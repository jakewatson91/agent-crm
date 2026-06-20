/**
 * Shared inbound-ingestion core.
 *
 * One write path for turning external rows (a webhook push, a CSV import, a
 * custom_http fetch) into idempotent entities + facts + signals. Callers map
 * raw rows to a declarative IngestSpec; this resolves-or-creates the account,
 * links the contact, asserts the mapped facts, and emits one signal per row so
 * the existing match → enrich → score → draft pipeline fires.
 *
 * Idempotency is the whole point:
 *   - accounts resolve by domain (fall back to name) against a preloaded cache,
 *   - contacts resolve by email via linkContactToAccount (idempotent on the
 *     email fact),
 *   - facts are content-hash idempotent in record_event,
 *   - rows carry an item_id recorded in signals.structured_tags; a row already
 *     seen (same source signal type, within the window) is skipped.
 *
 * So re-running an import, or mixing an import with a webhook that pushes the
 * same rows, converges instead of duplicating.
 */
import { createHash } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Actor } from '@agent-crm/primitives';
import { callTool } from './index.ts';
import { fetchSeenSignalTags } from './reads.ts';
import { linkContactToAccount } from './contacts.ts';
import { entityIdsOfType } from './entity_types.ts';

// ─── Spec + provenance ──────────────────────────────────────────────────────

/** Declarative field-map: how to pull account/contact/fact/signal out of a raw
 *  source row. Dot paths are resolved against the row object. Lives in config
 *  (sources.config.ingest_spec for the webhook; built from the column mapping
 *  for CSV), never in code. */
export interface IngestSpec {
  account_name_path?: string;
  account_domain_path?: string;
  contact_email_path?: string;
  contact_name_path?: string;
  contact_role_path?: string;
  /** Map arbitrary source fields to facts on the account or the contact. */
  fact_map?: Array<{ source_path: string; predicate: string; on?: 'account' | 'contact'; confidence?: number }>;
  signal?: { type?: string; magnitude?: number; body_path?: string; body_template?: string };
  /** Map a row to an opportunity (deal) entity + deal_* facts on it. Deal state
   *  facts are superseded on re-import so the chain is the stage-transition
   *  history. The opportunity is resolved across runs by external_id (falls
   *  back to the row's item_id). */
  deal?: {
    external_id_path?: string;
    name_path?: string;
    stage_path?: string;
    value_path?: string;
    close_date_path?: string;
    owner_path?: string;
    pipeline_path?: string;
  };
  /** Stable per-row id for cross-run dedup. Falls back to a hash of the row. */
  item_id_path?: string;
  /** Window for the dedup lookup. Default 720h (30d). */
  dedup_since_hours?: number;
}

export interface IngestProvenance {
  source_kind: 'webhook' | 'connected' | 'import_csv' | 'custom_http';
  /** source_id / import-job id — whatever identifies this run for the audit. */
  source_ref: string;
  /** Human label for the audit surface (optional). */
  source_label?: string;
}

export interface IngestResult {
  accounts_created: number;
  accounts_reused: number;
  contacts_created: number;
  contacts_reused: number;
  opportunities_created: number;
  opportunities_updated: number;
  facts_asserted: number;
  signals_created: number;
  skipped: number;
  errors: string[];
}

// ─── Shared helpers (also imported by custom_http) ────────────────────────────

export function getPath(obj: unknown, path: string | undefined): unknown {
  if (!path) return undefined;
  let cur: any = obj;
  for (const p of path.split('.')) {
    if (cur == null) return undefined;
    cur = cur[p];
  }
  return cur;
}

export function normalizeDomain(url: string | undefined | null): string | null {
  if (!url) return null;
  try {
    const u = new URL(url.startsWith('http') ? url : `https://${url}`);
    return u.hostname.replace(/^www\./, '').toLowerCase();
  } catch {
    return null;
  }
}

export function hashItem(item: unknown): string {
  return createHash('sha256').update(JSON.stringify(item)).digest('hex').slice(0, 32);
}

function asString(v: unknown): string | null {
  if (v == null) return null;
  if (typeof v === 'string') return v.trim() || null;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return null;
}

function clampConfidence(v: unknown, fallback: number): number {
  return typeof v === 'number' ? Math.max(0, Math.min(1, v)) : fallback;
}

// ─── Core ─────────────────────────────────────────────────────────────────────

/**
 * Ingest raw rows into the workspace. Idempotent. Returns counts + per-row
 * errors (never throws on a single bad row — it's counted and skipped).
 */
export async function ingestRows(
  supabase: SupabaseClient,
  actor: Pick<Actor, 'workspace_id'>,
  rows: unknown[],
  spec: IngestSpec,
  provenance: IngestProvenance,
): Promise<IngestResult> {
  const result: IngestResult = {
    accounts_created: 0, accounts_reused: 0,
    contacts_created: 0, contacts_reused: 0,
    opportunities_created: 0, opportunities_updated: 0,
    facts_asserted: 0, signals_created: 0,
    skipped: 0, errors: [],
  };
  if (!Array.isArray(rows) || rows.length === 0) return result;

  const workspace_id = actor.workspace_id;
  const signalType = spec.signal?.type ?? provenance.source_kind;
  const magnitude = spec.signal?.magnitude ?? 0.5;

  // Provenance: every write is attributed to a stable source actor so the
  // cite-chain (fact → signal → event → actor) keeps resolving to "the X push".
  const sourceActor: Actor = {
    workspace_id,
    actor_kind: 'agent',
    actor_id: `source:${provenance.source_kind}:${provenance.source_ref.slice(0, 8)}`,
  };

  // ── Cross-run dedup: collect item_ids already seen for this source signal type.
  const sinceHours = spec.dedup_since_hours ?? 720;
  const cutoff = new Date(Date.now() - sinceHours * 3600 * 1000).toISOString();
  const seen = await fetchSeenSignalTags(supabase, { workspace_id, type: signalType, sinceISO: cutoff });
  const seenIds = new Set<string>();
  for (const s of seen) {
    const id = (s.structured_tags as { item_id?: string } | null)?.item_id;
    if (id) seenIds.add(id);
  }

  // ── Preload account entities for resolve-or-create (one round trip).
  const entitiesByDomain = new Map<string, string>();
  const entitiesByName = new Map<string, string>();
  const acctIds = await entityIdsOfType(supabase, workspace_id, 'account');
  if (acctIds.length) {
    const ents = await supabase.from('entities').select('id, name, attributes').in('id', acctIds);
    for (const e of ents.data ?? []) {
      const d = (e.attributes as { domain?: string } | null)?.domain;
      if (d) entitiesByDomain.set(d.toLowerCase(), e.id as string);
      entitiesByName.set((e.name as string).toLowerCase(), e.id as string);
    }
  }

  const resolveOrCreateAccount = async (name: string | null, domain: string | null): Promise<string | null> => {
    const key = domain && entitiesByDomain.get(domain);
    const byName = name && entitiesByName.get(name.toLowerCase());
    const existing = key || byName;
    if (existing) { result.accounts_reused++; return existing; }
    const displayName = name ?? domain;
    if (!displayName) return null;
    const created = await callTool(supabase, sourceActor, 'create_account', {
      name: displayName,
      attributes: {
        ...(domain ? { domain } : {}),
        ingested_via: provenance.source_kind,
        ingested_at: new Date().toISOString(),
      },
    });
    if (!created.ok) { result.errors.push(`create_account ${displayName}: ${created.error}`); return null; }
    const id = created.target_id;
    result.accounts_created++;
    if (domain) entitiesByDomain.set(domain, id);
    entitiesByName.set(displayName.toLowerCase(), id);
    // Assert domain as a fact too, so it's queryable/citeable as part of the record.
    if (domain) {
      const df = await callTool(supabase, sourceActor, 'assert_fact', {
        subject_entity: id, predicate: 'domain', object_text: domain, confidence: 1.0,
      });
      if (df.ok) result.facts_asserted++;
    }
    return id;
  };

  // ── Opportunity (deal) resolution, only when the spec maps deals.
  const oppByExternalId = new Map<string, string>();
  if (spec.deal) {
    const oppIds = await entityIdsOfType(supabase, workspace_id, 'opportunity');
    if (oppIds.length) {
      const f = await supabase.from('facts')
        .select('subject_entity, object_text')
        .eq('workspace_id', workspace_id)
        .eq('predicate', 'deal_external_id')
        .is('supersedes', null)
        .in('subject_entity', oppIds);
      for (const r of f.data ?? []) {
        if (r.object_text) oppByExternalId.set(r.object_text as string, r.subject_entity as string);
      }
    }
  }

  // Set a deal fact: no-op if unchanged, supersede if changed, assert if new.
  // The supersede chain becomes the stage-transition history.
  //
  // supersede_fact writes the NEW row with supersedes = <old id>, so the
  // CURRENT fact is the one NOT pointed at by any other row's supersedes — NOT
  // `supersedes is null` (that returns the original). Using the wrong one would
  // re-supersede the original and fork the chain on the second change.
  const upsertFact = async (entity_id: string, predicate: string, object_text: string): Promise<boolean> => {
    const all = await supabase.from('facts')
      .select('id, object_text, supersedes')
      .eq('workspace_id', workspace_id)
      .eq('subject_entity', entity_id)
      .eq('predicate', predicate);
    const rows = all.data ?? [];
    const pointedTo = new Set(rows.map((r) => r.supersedes).filter(Boolean) as string[]);
    const current = rows.find((r) => !pointedTo.has(r.id as string));
    if (current) {
      if (current.object_text === object_text) return false; // unchanged
      const r = await callTool(supabase, sourceActor, 'supersede_fact', {
        subject_entity: entity_id, predicate, object_text, confidence: 0.95, supersedes: current.id,
      });
      if (r.ok) result.facts_asserted++;
      return r.ok;
    }
    const r = await callTool(supabase, sourceActor, 'assert_fact', {
      subject_entity: entity_id, predicate, object_text, confidence: 0.95,
    });
    if (r.ok) result.facts_asserted++;
    return r.ok;
  };

  for (const row of rows) {
    const rawId = asString(getPath(row, spec.item_id_path));
    const item_id = rawId || hashItem(row);
    if (seenIds.has(item_id)) { result.skipped++; continue; }
    seenIds.add(item_id);

    try {
      const accountName = asString(getPath(row, spec.account_name_path));
      let accountDomain = normalizeDomain(asString(getPath(row, spec.account_domain_path)));
      const email = asString(getPath(row, spec.contact_email_path))?.toLowerCase() ?? null;
      const contactName = asString(getPath(row, spec.contact_name_path));
      const contactRole = asString(getPath(row, spec.contact_role_path)) ?? undefined;

      // If only a contact email is present, derive the account from its domain
      // so the contact still attaches to something (from-scratch contact rows).
      if (!accountName && !accountDomain && email) {
        const emailDomain = email.split('@')[1] ?? null;
        if (emailDomain && !/(gmail|outlook|hotmail|yahoo|icloud|proton)\./.test(emailDomain)) {
          accountDomain = emailDomain.toLowerCase();
        }
      }

      const accountId = await resolveOrCreateAccount(accountName, accountDomain);
      if (!accountId && !email) { result.skipped++; continue; }

      // Contact (idempotent on email).
      let contactId: string | null = null;
      if (email && email.includes('@') && accountId) {
        const link = await linkContactToAccount(supabase, sourceActor, {
          account_entity_id: accountId,
          name: contactName ?? email.split('@')[0]!,
          email,
          role: contactRole,
        });
        contactId = link.contact_entity_id;
        if (link.created) result.contacts_created++; else result.contacts_reused++;
      }

      // Mapped facts.
      for (const fm of spec.fact_map ?? []) {
        const val = asString(getPath(row, fm.source_path));
        if (!val) continue;
        const subject = fm.on === 'contact' ? contactId : accountId;
        if (!subject) continue;
        const f = await callTool(supabase, sourceActor, 'assert_fact', {
          subject_entity: subject,
          predicate: fm.predicate.toLowerCase().replace(/\s+/g, '_'),
          object_text: val,
          confidence: clampConfidence(fm.confidence, 0.9),
        });
        if (f.ok) result.facts_asserted++;
      }

      // Deal → opportunity entity + deal_* facts (superseded on re-import).
      if (spec.deal && accountId) {
        const ext = asString(getPath(row, spec.deal.external_id_path)) ?? item_id;
        let oppId = oppByExternalId.get(ext) ?? null;
        const isNew = !oppId;
        if (!oppId) {
          const dealName = asString(getPath(row, spec.deal.name_path)) ?? `Deal ${ext}`;
          const created = await callTool(supabase, sourceActor, 'create_entity', {
            name: dealName, kind: 'opportunity',
            attributes: { ingested_via: provenance.source_kind, ingested_at: new Date().toISOString() },
          });
          if (created.ok) {
            oppId = created.target_id;
            oppByExternalId.set(ext, oppId);
            result.opportunities_created++;
            await callTool(supabase, sourceActor, 'assert_fact', {
              subject_entity: oppId, predicate: 'deal_external_id', object_text: ext, confidence: 1.0,
            });
            await callTool(supabase, sourceActor, 'assert_fact', {
              subject_entity: oppId, predicate: 'for_account', object_entity: accountId, confidence: 1.0,
            });
          } else {
            result.errors.push(`create_entity opportunity ${ext}: ${created.error}`);
          }
        }
        if (oppId) {
          const fields: Array<[string | undefined, string]> = [
            [spec.deal.stage_path, 'deal_stage'],
            [spec.deal.value_path, 'deal_value'],
            [spec.deal.close_date_path, 'deal_close_date'],
            [spec.deal.owner_path, 'deal_owner'],
            [spec.deal.pipeline_path, 'deal_pipeline'],
          ];
          let changed = false;
          for (const [path, predicate] of fields) {
            const v = asString(getPath(row, path));
            if (!v) continue;
            if (await upsertFact(oppId, predicate, v)) changed = true;
          }
          if (changed && !isNew) result.opportunities_updated++;
        }
      }

      // One signal per row so the pipeline fires. Attach to the account if we
      // have one, else the contact.
      const signalEntity = accountId ?? contactId;
      if (signalEntity) {
        const body = asString(getPath(row, spec.signal?.body_path))
          ?? spec.signal?.body_template
          ?? `Ingested via ${provenance.source_label ?? provenance.source_kind}: ${accountName ?? accountDomain ?? email}`;
        const sig = await callTool(supabase, sourceActor, 'create_signal', {
          entity_id: signalEntity,
          type: signalType,
          magnitude,
          body_for_embedding: body,
          structured_tags: {
            signal_source: signalType,
            source_kind: provenance.source_kind,
            source_ref: provenance.source_ref,
            item_id,
          },
        });
        if (sig.ok) result.signals_created++;
        else result.errors.push(`create_signal: ${sig.error}`);
      }
    } catch (e) {
      result.errors.push(`row ${item_id}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  return result;
}
