/**
 * Private AI's limits, one copy for the phone (screens/PrivateAi.tsx) and the
 * worker (worker/privateai.ts), so the two can never disagree about what a
 * conversation may carry.
 */
export const AI_LIMITS = {
  /** one message, in characters */
  message: 2000,
  /** turns of the conversation sent with a question, newest kept */
  turns: 12,
  /** characters of conversation sent with a question, newest kept */
  context: 8000,
  /** the longest answer, in tokens */
  answer: 700,
  /** the longest answer from a model that always thinks first, its thinking counted in it */
  answerThinking: 3000,
  /** questions per account, a minute and a day */
  perMinute: 10,
  perDay: 200,
};

/**
 * What a top-up of credit may be, in dollars (worker /api/ai/credit/order), from $1 (owner, 2026-10-20: "the
 * deposit should start from a dollar"). No bridge sits under either rail: a vault coin swaps inside the
 * confidential balance (1Click quoted $1 of Tether for about $1.02 that day) and a Gram wallet token pays the
 * box directly.
 */
export const AI_TOPUPS = [1, 5, 10, 25];

/**
 * Any amount besides (owner, 2026-10-21: "users should be able to put any amount they like"): dollars in whole
 * cents, from a dollar to this much in one top-up, a cap that turns a typo of an extra zero or two into a refusal
 * rather than a payment. The presets above are the quick picks; the worker takes any amount this allows.
 */
export const AI_CREDIT_MIN = 1;
export const AI_CREDIT_MAX = 1000;

/** A top-up the worker will place: a finite number of dollars, whole cents, from AI_CREDIT_MIN to AI_CREDIT_MAX. */
export function aiTopupOk(usd: number): boolean {
  if (typeof usd !== 'number' || !Number.isFinite(usd) || usd < AI_CREDIT_MIN || usd > AI_CREDIT_MAX) return false;
  return Math.abs(usd * 100 - Math.round(usd * 100)) < 1e-6;
}

export type AiTurn = { role: 'user' | 'assistant'; content: string };

/**
 * The newest turns that fit, ending in the question, which always fits. The
 * phone sends no more than this, so a long chat never outgrows the route's
 * body cap, and the worker trims by the same rule whatever it is sent. A
 * conversation opens with the person, as the model's template expects.
 */
export function newestTurns(all: AiTurn[]): AiTurn[] {
  const last = all[all.length - 1];
  if (!last) return [];
  const kept: AiTurn[] = [last];
  let size = last.content.length;
  for (let i = all.length - 2; i >= 0 && kept.length < AI_LIMITS.turns; i--) {
    const t = all[i];
    if (!t.content) continue;
    if (size + t.content.length > AI_LIMITS.context) break;
    size += t.content.length;
    kept.unshift(t);
  }
  while (kept.length > 1 && kept[0].role !== 'user') kept.shift();
  return kept;
}
