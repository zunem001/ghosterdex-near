/**
 * Whether a message carries what nobody should ever paste into a chat: a
 * wallet's recovery phrase, or a private key.
 *
 * The Private AI chat (screens/CocoonAi.tsx) refuses to send such a message,
 * and the worker refuses it again (worker/cocoon.ts): the words would travel
 * through TON Console and Cocoon, and a phrase is the whole wallet. One module
 * for both sides, so the two can never disagree.
 *
 * A phrase is twelve or more of the 2048 BIP39 words in a row, however they
 * are numbered or separated. Ordinary sentences break such a run within a few
 * words, because "the", "a", "is", "to", "of", "in", "and", "for" and "with"
 * are not on the list (scripts/check-privateai.mts measures the app's own
 * copy against it).
 *
 * Hex is judged by its length and its label. A raw address or a transaction
 * hash is 64 hex characters too, and people ask about those, so 64 counts only
 * beside words that say it is a key; an expanded Ed25519 secret key (128) is a
 * key whatever surrounds it.
 */
import { wordlist } from '@ton/crypto/dist/mnemonic/wordlist';

const WORDS = new Set<string>(wordlist);
export const PHRASE_RUN = 12;

/** The longest run of consecutive recovery-phrase words in `text`. */
export function phraseRun(text: string): number {
  const tokens = String(text || '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
    /* "1." "2)" "12-" numbering sits between the words and is not a break */
    .filter((tok) => !/^\d{1,2}$/.test(tok));
  let best = 0;
  let run = 0;
  for (const tok of tokens) {
    run = WORDS.has(tok) ? run + 1 : 0;
    if (run > best) best = run;
  }
  return best;
}

export function looksLikeSecret(text: string): boolean {
  const s = String(text || '');
  if (phraseRun(s) >= PHRASE_RUN) return true;
  if (/(?:^|[^0-9a-fA-F])(?:0x)?[0-9a-fA-F]{128}(?:[^0-9a-fA-F]|$)/.test(s)) return true;
  if (/(?:private|secret)\s*key|seed\s*(?:phrase|words)?|mnemonic/i.test(s) && /(?:^|[^0-9a-fA-F])(?:0x)?[0-9a-fA-F]{64}(?:[^0-9a-fA-F]|$)/.test(s)) return true;
  return false;
}
