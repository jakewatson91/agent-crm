/**
 * One score language across the app. The raw 0–1 number is an audit detail, not
 * something a person reads at a glance — so lists and the feed show the verdict
 * word ("strong fit", "weak fit") in the band color, with the exact score on
 * hover. The entity page keeps the fuller "78% match" headline; this is the
 * compact chip form used wherever a score used to render as "score 0.72".
 */
import { bandOf, bandColor, BAND_HEADLINE } from '../_lib/bands';

export function ScorePill({ icp, title }: { icp: number | null; title?: string }) {
  if (icp === null) return null;
  const band = bandOf(icp);
  return (
    <span
      className="mono"
      title={title ?? `score ${icp.toFixed(2)}`}
      style={{
        fontSize: '.72rem',
        color: bandColor(icp),
        padding: '1px 7px',
        background: 'var(--panel-2)',
        border: '1px solid var(--border)',
        borderRadius: 999,
        whiteSpace: 'nowrap',
      }}
    >
      {BAND_HEADLINE[band].toLowerCase()}
    </span>
  );
}
