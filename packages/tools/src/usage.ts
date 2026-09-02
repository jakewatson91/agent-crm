/**
 * Staying under the hosting plan's limits, rather than finding out by email.
 *
 * Supabase bills two meters that can stop a project dead: egress per billing
 * cycle, and database size. Neither is visible from inside Postgres, and the
 * usage dashboard has no per-service breakdown to reconcile against, so the
 * only readable source is the project's own Prometheus endpoint. It exposes a
 * cumulative byte counter, not a per-cycle one, which is why this records a
 * sample every run and adds up the deltas itself.
 *
 * It reports, it does not stop anything. A paused pipeline is not a fix for
 * using too much per account; it just hides the number until the cycle turns
 * over. This exists so the cost per entity is visible while it is drifting,
 * not so the system can switch itself off.
 *
 * Off unless configured. `policy.limits` is empty by default because the caps
 * belong to whatever plan the customer is on, and guessing them is worse than
 * not enforcing them.
 */
import type { SupabaseClient } from '@supabase/supabase-js';

export interface UsageLimits {
  /** Egress allowed per billing cycle, in GB. Absent = not enforced. */
  egress_gb?: number;
  /** Database size allowed, in MB. Absent = not enforced. */
  db_mb?: number;
  /** Day of month the billing cycle restarts. Defaults to the 1st. */
  cycle_day?: number;
  /** Fraction of a limit at which this goes RED in the sweep. Defaults to 0.85. */
  pause_at?: number;
}

export interface UsageReading {
  /** Bytes off the instance since the cycle started, summed from our own samples. */
  egress_bytes_cycle: number;
  /** Whole-database size right now. */
  db_bytes: number;
  /** Cumulative counter, kept so the next run can diff against it. */
  transmit_total: number;
  /** True when the counter went backwards, i.e. the instance restarted. */
  counter_reset: boolean;
  cycle_started: string;
  sampled_at: string;
}

/** Days of a cycle that have to elapse before a rate is worth extrapolating. */
const PROJECTION_MIN_DAYS = 3;
/** Nominal cycle length used to project a partial cycle forward. */
const CYCLE_DAYS = 30;

const METRIC_TRANSMIT = 'node_network_transmit_bytes_total';
const METRIC_DB_SIZE = 'pg_database_size_bytes';
export const USAGE_SAMPLE_ACTION = 'usage_sample';

/** First instant of the billing cycle containing `now`, given the cycle day. */
export function cycleStart(now: Date, cycleDay = 1): Date {
  const day = Math.min(Math.max(Math.trunc(cycleDay), 1), 28);
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), day));
  if (start > now) start.setUTCMonth(start.getUTCMonth() - 1);
  return start;
}

/**
 * Scrape the project's metrics endpoint. Basic auth, user `service_role`, the
 * service role key as the password. Returns null when the endpoint or the
 * credentials are unavailable rather than throwing, because a usage check that
 * breaks the sweep is worse than one that skips a run.
 */
export async function readMetrics(): Promise<{ transmit: number; db: number } | null> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  const ref = url.replace(/^https:\/\/([^.]+)\..*$/, '$1');
  try {
    const res = await fetch(`https://${ref}.supabase.co/customer/v1/privileged/metrics`, {
      headers: { authorization: `Basic ${Buffer.from(`service_role:${key}`).toString('base64')}` },
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) return null;
    const body = await res.text();
    const pick = (name: string, filter?: string) => {
      const line = body.split('\n').find((l) => l.startsWith(name) && (!filter || l.includes(filter)));
      return line ? Number(line.slice(line.lastIndexOf(' ') + 1)) : NaN;
    };
    const transmit = pick(METRIC_TRANSMIT, 'ens5');
    const db = pick(METRIC_DB_SIZE);
    if (!Number.isFinite(transmit) || !Number.isFinite(db)) return null;
    return { transmit, db };
  } catch {
    return null;
  }
}

/**
 * Read both meters and add this sample to the running cycle total.
 *
 * The counter is cumulative since the instance booted, so a restart makes it
 * jump backwards. That reads as a negative delta, which would silently shrink
 * the cycle total and hide an overage, so a backwards step is treated as
 * "everything since the restart" instead.
 */
export async function sampleUsage(
  supabase: SupabaseClient,
  workspace_id: string,
  limits: UsageLimits,
): Promise<UsageReading | null> {
  const m = await readMetrics();
  if (!m) return null;

  const now = new Date();
  const started = cycleStart(now, limits.cycle_day ?? 1);

  const prior = await supabase.from('events')
    .select('payload, created_at')
    .eq('workspace_id', workspace_id)
    .eq('action', USAGE_SAMPLE_ACTION)
    .gte('created_at', started.toISOString())
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  const last = (prior.data as { payload?: { transmit_total?: number; egress_bytes_cycle?: number } } | null)?.payload;
  const lastTotal = typeof last?.transmit_total === 'number' ? last.transmit_total : null;
  const lastCycle = typeof last?.egress_bytes_cycle === 'number' ? last.egress_bytes_cycle : 0;

  const counter_reset = lastTotal !== null && m.transmit < lastTotal;
  const delta = lastTotal === null ? 0 : counter_reset ? m.transmit : m.transmit - lastTotal;

  return {
    egress_bytes_cycle: lastCycle + delta,
    db_bytes: m.db,
    transmit_total: m.transmit,
    counter_reset,
    cycle_started: started.toISOString(),
    sampled_at: now.toISOString(),
  };
}

export interface UsageVerdict {
  /** Highest fraction of any configured limit currently used. */
  worst: number;
  /** Which meter is worst, for the message. */
  meter: 'egress' | 'db' | null;
  /** True when a configured meter is past pause_at. Reported, never acted on. */
  breach: boolean;
  detail: string;
}

/**
 * How close each configured meter is to its limit.
 *
 * Egress is projected to the end of the cycle rather than read flat: 60% used
 * on day 3 is a breach in the making and 60% on day 28 is fine, and noticing
 * only once the meter reads 100% notices after the money is already spent.
 * Database size is read flat, because it does not reset when the cycle does.
 */
export function judgeUsage(reading: UsageReading, limits: UsageLimits, now = new Date()): UsageVerdict {
  const redAt = limits.pause_at ?? 0.85;
  const parts: string[] = [];
  let worst = 0;
  let meter: 'egress' | 'db' | null = null;

  if (limits.egress_gb && limits.egress_gb > 0) {
    const cap = limits.egress_gb * 1e9;
    const elapsedDays = (now.getTime() - Date.parse(reading.cycle_started)) / 86_400_000;
    const usedFrac = reading.egress_bytes_cycle / cap;

    // Rate over a day or two of a thirty-day cycle says almost nothing: one
    // backfill on the 2nd projects to a year's worth of traffic and would pause
    // a healthy pipeline. Judge on what has actually been spent until enough of
    // the cycle has run to make a rate mean something, then take whichever of
    // spent-so-far and on-this-pace is worse.
    const trustProjection = elapsedDays >= PROJECTION_MIN_DAYS;
    const projected = trustProjection ? reading.egress_bytes_cycle / elapsedDays * CYCLE_DAYS : null;
    const frac = projected === null ? usedFrac : Math.max(usedFrac, projected / cap);

    parts.push(`egress ${(reading.egress_bytes_cycle / 1e9).toFixed(2)} GB of ${limits.egress_gb} GB used`
      + (projected === null
        ? `, ${elapsedDays.toFixed(1)}d into the cycle (too early to project)`
        : `, ${(projected / 1e9).toFixed(1)} GB projected on this pace`));
    if (frac > worst) { worst = frac; meter = 'egress'; }
  }

  if (limits.db_mb && limits.db_mb > 0) {
    const frac = reading.db_bytes / (limits.db_mb * 1e6);
    parts.push(`database ${(reading.db_bytes / 1e6).toFixed(0)} MB of ${limits.db_mb} MB`);
    if (frac > worst) { worst = frac; meter = 'db'; }
  }

  return { worst, meter, breach: worst >= redAt, detail: parts.join('; ') };
}
