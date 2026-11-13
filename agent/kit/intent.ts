/**
 * What this key signs, read before it signs.
 *
 * GhosterDex and 1Click prepare the text of every private move, and the contract that runs it reads exactly these
 * words, so the key reads them the same way first. A move is one transfer, out of this key's own account, of the coin
 * and amount that were asked for, to the address that was quoted. The balance link moves nothing at all.
 *
 * Prepared text is plain JSON with nothing to escape, so a backslash is refused, and the raw text can be counted: no
 * key can be given twice, or hidden behind an escape that one parser reads and another does not. No Node here: the
 * owner's device runs this too (owner.ts).
 */

const CONTRACTS = new Set(['intents.near', 'intents.far']);
const TRANSFER_KEYS = new Set(['intent', 'receiver_id', 'tokens', 'memo']);
/** a link's text is good for minutes; this is the most it may ask */
const LINK_DEADLINE_MS = 24 * 3600_000;

export type SpendWant = {
  /** this key's account: its public key in hex */
  account: string;
  /** the deposit address the quote named */
  receiver: string;
  /** the coin being spent */
  assetId: string;
  /** the most that may leave */
  maxRaw: bigint;
};

/** how many keys a parsed value holds, at any depth */
function keysIn(v: unknown): number {
  if (Array.isArray(v)) return v.reduce((n: number, x) => n + keysIn(x), 0);
  if (v && typeof v === 'object') return Object.values(v).reduce((n: number, x) => n + 1 + keysIn(x), 0);
  return 0;
}

function envelope(text: unknown, account: string): { p: Record<string, any> } | string {
  if (typeof text !== 'string' || !text || text.length > 8192) return 'the text is missing or too long';
  if (text.includes('\\')) return 'the text carries an escape';
  let p: unknown;
  try {
    p = JSON.parse(text);
  } catch {
    return 'the text is not JSON';
  }
  if (!p || typeof p !== 'object' || Array.isArray(p)) return 'the text is not an intent';
  /* with no escapes, every `"...":` in the text is a key, so one given twice anywhere shows as one too many */
  if ((text.match(/"[^"]*"\s*:/g) || []).length !== keysIn(p)) return 'a key is given twice';
  const q = p as Record<string, any>;
  if (!account || q.signer_id !== account) return 'it is for another account';
  if (!CONTRACTS.has(q.verifying_contract)) return 'it is for another contract';
  return { p: q };
}

/** Why this text must not be signed as the move asked for, or null when it is that move. */
export function spendRefusal(text: unknown, want: SpendWant): string | null {
  const e = envelope(text, want.account);
  if (typeof e === 'string') return e;
  const { p } = e;
  if (!Array.isArray(p.intents) || p.intents.length !== 1) return 'it is not one transfer';
  const it = p.intents[0];
  if (!it || typeof it !== 'object' || Array.isArray(it)) return 'it is not one transfer';
  if (it.intent !== 'transfer') return 'it is not a transfer';
  if (Object.keys(it).some((k) => !TRANSFER_KEYS.has(k))) return 'the transfer carries more than a transfer does';
  if (it.memo !== undefined && typeof it.memo !== 'string') return 'the memo is not text';
  if (!want.receiver || it.receiver_id !== want.receiver) return 'it pays another address than the quote named';
  const tokens = it.tokens;
  if (!tokens || typeof tokens !== 'object' || Array.isArray(tokens)) return 'it names no coin';
  const keys = Object.keys(tokens);
  if (keys.length !== 1) return 'it moves more than one coin';
  const bare = keys[0].replace(/^imt:[0-9a-f]{64}:/, '');
  /* a coin listed under a 1cs_v1 id is carried under its contract's own name, which the listing does not give */
  if (!want.assetId.startsWith('1cs_v1:') && bare !== want.assetId) return 'it moves another coin';
  const amount = tokens[keys[0]];
  if (typeof amount !== 'string' || !/^[0-9]{1,40}$/.test(amount) || BigInt(amount) <= 0n) return 'its amount is not a whole number above zero';
  if (BigInt(amount) > want.maxRaw) return 'it moves more than was asked';
  return null;
}

/** room over what this kit worked out for a purchase: fees and the market's move, not the whole balance */
const PRICE_ROOM = 1.5;

/** The most a purchase worth about `usd` may sign, in a coin's raw units, or null when there is no telling. */
export function mostToPay(usd: number, price: number, decimals: number): bigint | null {
  if (!(usd > 0) || !(price > 0)) return null;
  const d = Math.min(decimals, 12);
  return BigInt(Math.ceil(((usd * PRICE_ROOM) / price) * 10 ** d)) * 10n ** BigInt(decimals - d);
}

/** Why this text must not be signed as the balance link, or null when it moves nothing and is good only for a while. */
export function linkRefusal(text: unknown, account: string, now = Date.now()): string | null {
  const e = envelope(text, account);
  if (typeof e === 'string') return e;
  const { p } = e;
  if (!Array.isArray(p.intents) || p.intents.length !== 0) return 'it moves something';
  const until = Date.parse(String(p.deadline));
  if (!Number.isFinite(until) || until - now > LINK_DEADLINE_MS) return 'its deadline is too far off';
  return null;
}
