/**
 * Instant withdrawal, the owner's side: open an agent's sealed key on this
 * device and bring its vault home, without the agent.
 *
 * The kit seals its key to each device the owner approved (seal.ts) and
 * GhosterDex stores copies it cannot open. This module opens one with this
 * device's secret, checks it is the key of the agent the owner picked, signs
 * in as that agent and sends each coin privately to the owner's vault, every
 * move signed here with the agent's key, exactly as the kit would sign it.
 *
 * It runs inside the app (a browser, or the phone's web layer): tweetnacl and
 * WebCrypto only, nothing from Node.
 *
 * Its requests carry the agent's session and nothing of the owner's: no
 * cookies, no Telegram initData, no device id. A sign-in carrying the owner's
 * Telegram identity would tie the agent's wallet to the owner's account
 * (tonproof/verify aliases a wallet to the Telegram user it sees), and a
 * device id invites the sign-in to adopt that device's account. The owner's
 * rules still apply at the gate: with the defaults, money can only go home,
 * paused or not.
 */
import nacl from 'tweetnacl';
import { spendRefusal } from './intent';

export type SealBlob = { v: 1; to: string; epk: string; n: string; c: string };

/**
 * How this device opens a copy: with its X25519 secret, or with a function
 * that runs X25519 on it and returns the raw 32 byte shared secret, so a
 * WebCrypto key that is never exported works too:
 *   deriveShared: async (epk) => new Uint8Array(await crypto.subtle.deriveBits(
 *     { name: 'X25519', public: await crypto.subtle.importKey('raw', epk, { name: 'X25519' }, false, []) },
 *     deviceSecretKey, 256))
 */
export type DeviceOpener = { secretKey: Uint8Array } | { deriveShared: (epk: Uint8Array) => Promise<Uint8Array> };

export type Opened = { words: string[]; pk: string; address: string };

export type Returned = {
  /** every chosen coin is on its way to the owner */
  ok: boolean;
  moves: Array<{ coin: string; amount: string; route: string }>;
  failed: Array<{ coin: string; error: string; status?: number; code?: string }>;
  /** coins left where they are, and why */
  skipped: Array<{ coin: string; why: string }>;
};

export type Step = { coin: string; step: 'preparing' | 'signing' | 'sent' | 'failed'; note?: string };

const DOMAIN = 'ghosterdex.com';
const enc = new TextEncoder();

/* ------------------------------------------------------------ the device */

/** The one text an owner's wallet signs to approve a device (worker/agents.ts and seal.ts build the same). */
export function deviceText(ownerKey: string, devicePk: string, label: string): string {
  return [
    'GhosterDex agent keys v1',
    "This device may open your agents' sealed keys to return their funds to you.",
    `Owner key: ${ownerKey}`,
    `Device key: ${devicePk}`,
    `Device: ${label}`,
  ].join('\n');
}

/**
 * A device name as it is signed and stored: one line, at most 40 characters,
 * cut on whole characters (worker/agents.ts deviceLabel, which refuses any
 * other form). Sign deviceText with deviceLabel(name), and send that label.
 */
export function deviceLabel(v: unknown): string {
  const s = String(v ?? '')
    .replace(/\p{Cs}/gu, '')
    .replace(/[\u0000-\u001f\u007f<>]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return Array.from(s).slice(0, 40).join('').trim();
}

/* ------------------------------------------------------------- the bytes */

function concat(...parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

/** Big or little endian; a negative workchain in two's complement. */
function int(v: number, n: number, little = false): Uint8Array {
  const out = new Uint8Array(n);
  let x = BigInt.asUintN(n * 8, BigInt(v));
  for (let i = 0; i < n; i++) {
    out[little ? i : n - 1 - i] = Number(x & 0xffn);
    x >>= 8n;
  }
  return out;
}

const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
const fromHex = (h: string) => Uint8Array.from(h.match(/../g) || [], (x) => parseInt(x, 16));
const b64 = (b: Uint8Array) => btoa(Array.from(b, (x) => String.fromCharCode(x)).join(''));
const fromB64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const sha256 = async (b: Uint8Array) => new Uint8Array(await crypto.subtle.digest('SHA-256', new Uint8Array(b)));

function splitRaw(address: string): { wc: number; hash: Uint8Array } {
  const m = /^(-?\d+):([0-9a-f]{64})$/.exec(address);
  if (!m) throw new Error('That sealed key carries a malformed address.');
  return { wc: Number(m[1]), hash: fromHex(m[2]) };
}

/** The bytes a TON Connect signData (text) signs the SHA-256 of: sign.ts signDataPreimage, for the browser. */
export function signDataPreimage(address: string, domain: string, timestamp: number, text: string): Uint8Array {
  const { wc, hash } = splitRaw(address);
  const dom = enc.encode(domain);
  const body = enc.encode(text);
  return concat(
    new Uint8Array([0xff, 0xff]),
    enc.encode('ton-connect/sign-data/'),
    int(wc, 4),
    hash,
    int(dom.length, 4),
    dom,
    int(timestamp, 8),
    enc.encode('txt'),
    int(body.length, 4),
    body,
  );
}

/* ------------------------------------------------------------- the key */

/* "expand 32-byte k": HSalsa20's constant, as in nacl's box.before */
const SIGMA = new Uint8Array([101, 120, 112, 97, 110, 100, 32, 51, 50, 45, 98, 121, 116, 101, 32, 107]);

async function boxKey(epk: Uint8Array, open: DeviceOpener): Promise<Uint8Array> {
  if ('secretKey' in open) return nacl.box.before(epk, open.secretKey);
  const shared = await open.deriveShared(epk);
  if (shared.length !== 32 || shared.every((b) => b === 0)) throw new Error('This device cannot open that key.');
  const k = new Uint8Array(32);
  (nacl as unknown as { lowlevel: { crypto_core_hsalsa20(o: Uint8Array, i: Uint8Array, k: Uint8Array, c: Uint8Array): number } }).lowlevel.crypto_core_hsalsa20(
    k,
    new Uint8Array(16),
    shared,
    SIGMA,
  );
  shared.fill(0);
  return k;
}

/** Opens one sealed copy with this device's secret. Throws if it is not addressed to this device, or was tampered with. */
export async function openSealed(blob: SealBlob, open: DeviceOpener): Promise<Opened> {
  if (!blob || blob.v !== 1) throw new Error('This device cannot open that key.');
  const epk = fromB64(blob.epk);
  const n = fromB64(blob.n);
  if (epk.length !== 32 || n.length !== 24) throw new Error('This device cannot open that key.');
  const k = await boxKey(epk, open);
  const plain = nacl.box.open.after(fromB64(blob.c), n, k);
  k.fill(0);
  if (!plain) throw new Error('This device cannot open that key.');
  let j: { v?: unknown; words?: unknown; pk?: unknown; address?: unknown };
  try {
    j = JSON.parse(new TextDecoder().decode(plain));
  } finally {
    plain.fill(0);
  }
  const words = String(j.words || '').trim().toLowerCase().split(/\s+/);
  const pk = String(j.pk || '').toLowerCase();
  const address = String(j.address || '').toLowerCase();
  if (j.v !== 1 || words.length !== 24 || !/^[0-9a-f]{64}$/.test(pk) || !/^-?\d+:[0-9a-f]{64}$/.test(address)) {
    throw new Error('That sealed key is damaged.');
  }
  return { words, pk, address };
}

/** A 24 word TON phrase to its Ed25519 key, as @ton/crypto derives it: HMAC-SHA512, then PBKDF2-SHA512, 100000 rounds. */
export async function keysFromWords(words: string[]): Promise<nacl.SignKeyPair> {
  const phrase = enc.encode(words.join(' '));
  const hk = await crypto.subtle.importKey('raw', phrase, { name: 'HMAC', hash: 'SHA-512' }, false, ['sign']);
  const entropy = new Uint8Array(await crypto.subtle.sign('HMAC', hk, new Uint8Array(0)));
  const pb = await crypto.subtle.importKey('raw', entropy, 'PBKDF2', false, ['deriveBits']);
  const seed = new Uint8Array(
    await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-512', salt: enc.encode('TON default seed'), iterations: 100_000 }, pb, 512),
  );
  const kp = nacl.sign.keyPair.fromSeed(seed.slice(0, 32));
  seed.fill(0);
  entropy.fill(0);
  phrase.fill(0);
  return kp;
}

async function tonProof(secretKey: Uint8Array, address: string, payload: string) {
  const { wc, hash } = splitRaw(address);
  const timestamp = Math.floor(Date.now() / 1000);
  const dom = enc.encode(DOMAIN);
  const msg = concat(enc.encode('ton-proof-item-v2/'), int(wc, 4), hash, int(dom.length, 4, true), dom, int(timestamp, 8, true), enc.encode(payload));
  const full = concat(new Uint8Array([0xff, 0xff]), enc.encode('ton-connect'), await sha256(msg));
  const signature = b64(nacl.sign.detached(await sha256(full), secretKey));
  return { timestamp, domain: { lengthBytes: dom.length, value: DOMAIN }, signature, payload };
}

/** A TON Connect signData over text, made with the agent's key: what execute verifies. */
export async function signText(secretKey: Uint8Array, address: string, text: string) {
  const timestamp = Math.floor(Date.now() / 1000);
  const signature = b64(nacl.sign.detached(await sha256(signDataPreimage(address, DOMAIN, timestamp, text)), secretKey));
  return { signature, address, timestamp, domain: DOMAIN, payload: { type: 'text' as const, text } };
}

/* ---------------------------------------------------------- the session */

type ApiFailure = Error & { status?: number; code?: string };

/** The agent's own session, and nothing of the owner's (see the top of this file). */
class AgentSession {
  private token = '';
  constructor(
    private base: string,
    private address: string,
  ) {}

  async call<T>(path: string, body?: unknown): Promise<T> {
    const headers: Record<string, string> = { 'content-type': 'application/json', 'x-ghoster-mode': 'live', 'x-ghoster-wallet': this.address };
    if (this.token) headers['x-ghoster-tonauth'] = this.token;
    /* a local worker (wrangler dev) redirects plain HTTP unless told the edge saw https */
    if (this.base.startsWith('http://')) headers['cf-visitor'] = '{"scheme":"https"}';
    const stop = new AbortController();
    const timer = setTimeout(() => stop.abort(), 60_000);
    let res: Response;
    try {
      res = await fetch(this.base + path, {
        method: body === undefined ? 'GET' : 'POST',
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        credentials: 'omit',
        signal: stop.signal,
      });
    } finally {
      clearTimeout(timer);
    }
    const text = await res.text();
    let j: any = null;
    try {
      j = text ? JSON.parse(text) : null;
    } catch {
      j = { error: text.slice(0, 200) };
    }
    if (!res.ok) {
      const e: ApiFailure = new Error(String(j?.error || j?.message || `GhosterDex answered ${res.status}`));
      e.status = res.status;
      e.code = typeof j?.code === 'string' ? j.code : undefined;
      throw e;
    }
    return j as T;
  }

  async signIn(pk: string, secretKey: Uint8Array): Promise<void> {
    const ch = await this.call<{ payload?: string }>('/api/tonproof/challenge');
    if (!ch?.payload) throw new Error('GhosterDex did not issue a sign-in challenge.');
    const proof = await tonProof(secretKey, this.address, ch.payload);
    const v = await this.call<{ token?: string; error?: string }>('/api/tonproof/verify', { address: this.address, publicKey: pk, proof });
    if (!v?.token) throw new Error(v?.error || 'GhosterDex refused the sign-in.');
    this.token = v.token;
  }
}

/* -------------------------------------------------------------- the money */

type Row = { assetId: string; symbol: string; decimals: number; raw: string; usd?: number; rwa?: boolean };

const symbolOf = (s: unknown) => {
  const v = String(s || '').trim().toUpperCase().replace(/^\$/, '');
  return v === 'TON' || v === 'TONCOIN' ? 'GRAM' : v;
};

function toRaw(amount: string, decimals: number): bigint {
  const m = /^(\d+)(?:\.(\d+))?$/.exec(amount.trim());
  if (!m) throw new Error('Choose how much.');
  return BigInt(m[1]) * 10n ** BigInt(decimals) + BigInt((m[2] || '').slice(0, decimals).padEnd(decimals, '0') || '0');
}

function fromRaw(raw: bigint, decimals: number): string {
  const s = raw.toString().padStart(decimals + 1, '0');
  const whole = s.slice(0, s.length - decimals);
  const frac = s.slice(s.length - decimals).replace(/0+$/, '');
  return frac ? `${whole}.${frac}` : whole;
}

/** What leaves: every coin, all of one coin, or part of one (from a single network, as one move spends one). */
function plan(rows: Row[], coin?: string, amount?: string): { send: Array<{ row: Row; raw: bigint }>; skipped: Returned['skipped'] } {
  const held = rows
    .map((row) => ({ row, raw: BigInt(row.raw || '0') }))
    .filter((x) => x.raw > 0n)
    .sort((a, b) => (a.raw > b.raw ? -1 : a.raw < b.raw ? 1 : 0));
  const skipped: Returned['skipped'] = [];
  if (!coin) {
    const send = held.filter(({ row }) => {
      if (row.rwa) skipped.push({ coin: row.symbol, why: 'a stock: sell it first' });
      else if ((row.usd || 0) > 0 && (row.usd || 0) < 0.05) skipped.push({ coin: row.symbol, why: 'too small to move' });
      else return true;
      return false;
    });
    return { send, skipped };
  }
  const sym = symbolOf(coin);
  const mine = held.filter((x) => symbolOf(x.row.symbol) === sym);
  if (!mine.length) throw new Error(`It holds no ${sym}.`);
  if (mine.some((x) => x.row.rwa)) throw new Error(`${sym} is a stock: sell it first.`);
  if (!amount || /^all$/i.test(amount.trim())) return { send: mine, skipped };
  const cover = mine.find((x) => x.raw >= toRaw(amount, x.row.decimals));
  if (cover) return { send: [{ row: cover.row, raw: toRaw(amount, cover.row.decimals) }], skipped };
  const total = mine.reduce((s, x) => s + Number(fromRaw(x.raw, x.row.decimals)), 0);
  if (mine.length > 1 && total >= Number(amount)) {
    throw new Error(`Its ${sym} is split across networks. Take up to ${fromRaw(mine[0].raw, mine[0].row.decimals)} at once, or all of it.`);
  }
  throw new Error(`It holds ${total} ${sym}.`);
}

/**
 * Opens `blob` with this device, checks it is `expectVault`'s key, and sends
 * the agent's vault (every coin, or `coin` and `amount`) privately to
 * `ownerVault`. Coins are sent one move each; a move that fails is reported
 * and the rest still go. The Gram wallet stays with the agent's own recall.
 */
export async function returnWithSealed(o: {
  blob: SealBlob;
  open: DeviceOpener;
  /** the agent's vault address from the owner's own list: the opened key must be this one */
  expectVault: string;
  /** the owner's own vault address: where the money goes */
  ownerVault: string;
  coin?: string;
  /** with a coin: 'all', or a figure in that coin */
  amount?: string;
  /** GhosterDex's origin; the page's own when left out */
  server?: string;
  onStep?: (s: Step) => void;
}): Promise<Returned> {
  const expect = String(o.expectVault || '').toLowerCase();
  const home = String(o.ownerVault || '').toLowerCase().replace(/^0x/, '');
  if (!/^[0-9a-f]{64}$/.test(expect) || !/^[0-9a-f]{64}$/.test(home) || home === expect) {
    throw new Error('Choose an agent, and the vault to bring its money to.');
  }
  const opened = await openSealed(o.blob, o.open);
  const keys = await keysFromWords(opened.words);
  opened.words.fill('');
  try {
    const pk = hex(keys.publicKey);
    if (pk !== opened.pk || pk !== expect) throw new Error("That sealed key is not this agent's. Nothing was moved.");
    const api = new AgentSession(o.server ?? '', opened.address);
    await api.signIn(pk, keys.secretKey);
    const { confidential } = await api.call<{ confidential?: Row[] }>('/api/balances');
    const { send, skipped } = plan(confidential || [], o.coin, o.amount);
    const out: Returned = { ok: true, moves: [], failed: [], skipped };
    for (const { row, raw } of send) {
      const coin = row.symbol;
      try {
        o.onStep?.({ coin, step: 'preparing' });
        const q = await api.call<{ quoteId: string; depositAddress?: string; signPayload?: string }>('/api/quote', {
          kind: 'send',
          originAssetId: row.assetId,
          destinationAssetId: row.assetId,
          amount: raw.toString(),
          recipient: home,
          dry: false,
        });
        if (!q?.depositAddress || !q.signPayload) throw new Error('GhosterDex did not prepare this move. Try again.');
        const no = spendRefusal(q.signPayload, { account: pk, receiver: q.depositAddress, assetId: row.assetId, maxRaw: raw });
        if (no) throw new Error(`What came back to sign is not this move: ${no}. Nothing was signed.`);
        o.onStep?.({ coin, step: 'signing' });
        const walletSig = await signText(keys.secretKey, opened.address, q.signPayload);
        await api.call('/api/execute', {
          quoteId: q.quoteId,
          depositAddress: q.depositAddress,
          kind: 'send',
          walletSig,
          walletBind: { address: opened.address, publicKey: pk },
        });
        out.moves.push({ coin, amount: fromRaw(raw, row.decimals), route: q.depositAddress });
        o.onStep?.({ coin, step: 'sent' });
      } catch (e) {
        const f = e as ApiFailure;
        out.ok = false;
        out.failed.push({ coin, error: f.message, ...(f.status ? { status: f.status } : {}), ...(f.code ? { code: f.code } : {}) });
        o.onStep?.({ coin, step: 'failed', note: f.message });
      }
    }
    return out;
  } finally {
    keys.secretKey.fill(0);
  }
}
