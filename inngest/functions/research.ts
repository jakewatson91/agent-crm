/**
 * Deep-research handler. Triggered by action_selector when it sees an entity
 * that looks like a possible fit but has too few facts to draft against.
 *
 * Runs a one-shot Exa search scoped to this specific entity (name + a few
 * key keywords pulled from its existing facts), creates `research_result`
 * signals attributed back to the entity, then asserts a `research_completed`
 * fact so the action_selector cooldown picks up next time.
 *
 * Concurrency-limited per workspace to avoid Exa bursts. Exa credit budget
 * still applies — if the account is 402'ing this just no-ops with an error
 * fact (audit trail preserves what we tried).
 */
import { createServerClient } from '@agent-crm/db';
import { embed, vectorLiteral } from '@agent-crm/primitives';
import { inngest } from '../client.js';

const EXA_API = 'https://api.exa.ai/search';
const MAX_RESULTS = 8;

export const researchRunner = inngest.createFunction(
  {
    id: 'research-runner',
    concurrency: { limit: 2, key: 'event.data.workspace_id' },
  },
  { event: 'research.requested' },
  async ({ event, step }) => {
    const { workspace_id, entity_id, entity_name, reason } = event.data;
    const apiKey = process.env.EXA_API_KEY;
    if (!apiKey) return { ok: false, reason: 'EXA_API_KEY not set' };

    return await step.run('search-and-attribute', async () => {
      const supabase = createServerClient();
      const actor = { workspace_id, actor_kind: 'agent' as const, actor_id: 'research_runner' };

      // Pull a few keywords from this entity's existing facts so the query
      // is targeted, not just the company name. Prefer facts that suggest
      // pain / stack / customers — those are what tells Exa what to look for.
      const facts = await supabase
        .from('facts')
        .select('predicate, object_text')
        .eq('workspace_id', workspace_id)
        .eq('subject_entity', entity_id)
        .is('supersedes', null)
        .limit(20);
      const keywords: string[] = [];
      for (const f of (facts.data ?? []) as Array<{ predicate: string; object_text: string | null }>) {
        if (!f.object_text) continue;
        if (/stack|uses|integrat|customer|target|industry|vertical|hiring/.test(f.predicate)) {
          keywords.push(f.object_text);
        }
      }
      const query = [entity_name, ...keywords.slice(0, 3)].join(' ').slice(0, 300);

      let results: Array<{ id: string; title: string | null; url: string; text?: string; publishedDate?: string }>;
      try {
        const r = await fetch(EXA_API, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey },
          body: JSON.stringify({
            query,
            type: 'auto',
            numResults: MAX_RESULTS,
            contents: { text: { maxCharacters: 1200 } },
          }),
        });
        if (!r.ok) {
          const msg = (await r.text()).slice(0, 200);
          await supabase.from('facts').insert({
            workspace_id, subject_entity: entity_id,
            predicate: 'research_error',
            object_text: `Exa ${r.status}: ${msg}`,
            confidence: 1.0,
            content_hash: `research_error:${Date.now()}`,
            source_event_id: 0, // best-effort; non-fatal write
          });
          return { ok: false, reason: `Exa ${r.status}` };
        }
        const j = await r.json() as { results: typeof results };
        results = j.results ?? [];
      } catch (e) {
        return { ok: false, reason: e instanceof Error ? e.message : String(e) };
      }

      // Dedup against existing signals for this entity by Exa result id.
      const since30d = new Date(Date.now() - 30 * 86400 * 1000).toISOString();
      const seenRes = await supabase
        .from('signals')
        .select('structured_tags')
        .eq('workspace_id', workspace_id)
        .eq('entity_id', entity_id)
        .gte('observed_at', since30d);
      const seenIds = new Set<string>();
      for (const s of (seenRes.data ?? []) as Array<{ structured_tags: { exa_id?: string } | null }>) {
        const id = s.structured_tags?.exa_id;
        if (id) seenIds.add(id);
      }

      let created = 0;
      for (const er of results) {
        if (seenIds.has(er.id)) continue;
        const body = [er.title, er.text].filter(Boolean).join('\n').slice(0, 1500);
        if (!body) continue;
        try {
          const vec = await embed(body);
          await supabase.from('signals').insert({
            workspace_id,
            entity_id,
            type: 'research_result',
            magnitude: 0.6,
            embedding: vectorLiteral(vec) as unknown as string,
            body_for_embedding: body,
            structured_tags: {
              signal_source: 'research',
              exa_id: er.id,
              url: er.url,
              triggered_by: reason,
            },
            source_event_id: null,
            observed_at: er.publishedDate ?? new Date().toISOString(),
          });
          created++;
        } catch {
          // skip; partial failure is acceptable for a research pull
        }
      }

      // Mark research as completed — action_selector will skip re-triggering
      // for the cooldown window.
      await supabase.from('facts').insert({
        workspace_id, subject_entity: entity_id,
        predicate: 'research_completed',
        object_text: `${created} new results from "${query.slice(0, 60)}"`,
        confidence: 1.0,
        content_hash: `research_completed:${entity_id}:${Date.now()}`,
        source_event_id: 0,
      });

      // Note: actor variable is reserved for future use — we'll wire act() calls
      // (vs raw inserts) once the trigger constraints are confirmed to allow it.
      void actor;
      return { ok: true, query, results_total: results.length, signals_created: created };
    });
  },
);
