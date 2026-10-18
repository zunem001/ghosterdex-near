/**
 * Randomness for an agent's recovery phrase.
 *
 * The same discipline the phone keeps (crypto/Entropy.kt): the provider is
 * health-checked before a single seed byte is drawn, every draw is mixed from
 * two independent sources plus timing jitter, and a replay canary remembers
 * recent probe fingerprints so a generator that is merely predictable (and
 * therefore passes every statistical test) still fails loudly instead of
 * minting a wallet somebody else can recompute.
 */
import { createHash, randomBytes, webcrypto } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const SAMPLE = 4096;
const WINDOW = 512;
/** Eight identical bytes in a row from a real CSPRNG is a 2^-56 event. */
const REPEAT_LIMIT = 8;
/** Any one value 32 times in a 512 byte window is far outside chance. */
const PROPORTION_LIMIT = 32;
const CANARY_KEEP = 16;

export class EntropyError extends Error {}

function healthCheck(sample: Uint8Array): void {
  let run = 1;
  for (let i = 1; i < sample.length; i++) {
    run = sample[i] === sample[i - 1] ? run + 1 : 1;
    if (run >= REPEAT_LIMIT) throw new EntropyError('The random source repeated itself. No wallet was created.');
  }
  for (let start = 0; start + WINDOW <= sample.length; start += WINDOW) {
    const counts = new Uint16Array(256);
    for (let i = start; i < start + WINDOW; i++) {
      if (++counts[sample[i]] >= PROPORTION_LIMIT) {
        throw new EntropyError('The random source is biased. No wallet was created.');
      }
    }
  }
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a[i] ^ b[i];
  return d === 0;
}

/**
 * A replay canary: a salted fingerprint of one probe draw, compared with the
 * last few creations on this machine. Two creations that see the same probe
 * mean the generator restarted from the same state, whatever its statistics.
 */
function canary(home: string, probe: Uint8Array): void {
  const file = join(home, 'entropy.json');
  let seen: string[] = [];
  try {
    if (existsSync(file)) seen = JSON.parse(readFileSync(file, 'utf8')).seen || [];
  } catch {
    seen = [];
  }
  const print = createHash('sha256').update('ghosterdex-agent canary v1').update(probe).digest('hex');
  if (seen.includes(print)) {
    throw new EntropyError('The random source replayed an earlier draw. No wallet was created.');
  }
  seen = [print, ...seen].slice(0, CANARY_KEEP);
  try {
    writeFileSync(file, JSON.stringify({ seen }), { mode: 0o600 });
  } catch {
    /* a read-only home still gets the statistical checks */
  }
}

/**
 * `n` bytes fit to become key material, or a thrown EntropyError.
 *
 * Each 32 byte block is SHA-256(randomBytes ‖ getRandomValues ‖ hrtime), so a
 * failure in one provider layer alone cannot decide the output.
 */
export function strongBytes(n: number, home: string): Uint8Array {
  const sample = new Uint8Array(randomBytes(SAMPLE));
  healthCheck(sample);
  const a = new Uint8Array(randomBytes(32));
  const b = new Uint8Array(randomBytes(32));
  if (sameBytes(a, b)) throw new EntropyError('The random source returned the same bytes twice. No wallet was created.');
  canary(home, a);

  const out = new Uint8Array(n);
  let filled = 0;
  let counter = 0;
  while (filled < n) {
    const web = new Uint8Array(32);
    webcrypto.getRandomValues(web);
    const block = createHash('sha256')
      .update(randomBytes(32))
      .update(web)
      .update(String(process.hrtime.bigint()))
      .update(String(counter++))
      .digest();
    const take = Math.min(32, n - filled);
    out.set(block.subarray(0, take), filled);
    filled += take;
  }
  return out;
}
