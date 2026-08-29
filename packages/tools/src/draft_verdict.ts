/**
 * What KIND of wrong a rejected draft was.
 *
 * Measured on Sudden before this existed: 85 decided drafts, 57 carrying a
 * typed note, and the notes read "this is terrible" and "just a jumble of
 * points in a sentence without any flow." Nothing can act on that, because the
 * three ways a draft fails need opposite fixes and free text does not say which
 * one happened:
 *
 *   - the reason was wrong        -> the argument needs rewriting
 *   - the company was wrong       -> the precondition or the ICP needs tightening
 *   - the writing was wrong       -> the argument is fine, the prose is not
 *
 * One click at the moment the person already knows the answer. Free text stays
 * available underneath for the detail, and stays optional.
 *
 * No imports on purpose. Client components render these labels, and anything
 * reaching the tools barrel from a browser bundle pulls `policy.ts` and its
 * `node:crypto` import, which webpack cannot resolve. See CLAUDE.md.
 */

export const DRAFT_VERDICTS = ['wrong_reason', 'wrong_company', 'bad_writing'] as const;

export type DraftVerdict = (typeof DRAFT_VERDICTS)[number];

/** Button text. Says what was wrong, not what to do about it. */
export const DRAFT_VERDICT_LABEL: Record<DraftVerdict, string> = {
  wrong_reason: 'Wrong reason to write',
  wrong_company: 'Wrong company',
  bad_writing: 'Bad writing',
};

/** One line under each button, so the choice does not need a manual. */
export const DRAFT_VERDICT_HELP: Record<DraftVerdict, string> = {
  wrong_reason: 'The argument it made does not hold for them.',
  wrong_company: 'The argument is fine, this company should not have been picked.',
  bad_writing: 'Right reason, right company, the message reads badly.',
};

export function isDraftVerdict(v: unknown): v is DraftVerdict {
  return typeof v === 'string' && (DRAFT_VERDICTS as readonly string[]).includes(v);
}
