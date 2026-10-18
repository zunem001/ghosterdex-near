/**
 * The agent key: this browser's permission to trade, and nothing else.
 *
 * ## What this is allowed to be
 *
 * Hyperliquid lets an account approve a second key, an *agent*, which may
 * place and cancel orders on that account, using that account's margin, and
 * which the venue refuses for `withdraw3` and `sendAsset`. That asymmetry is
 * the whole reason this file may exist. A key here lives in browser storage,
 * where none of the Android Keystore's guarantees apply and any script that
 * gets to run can read it. Holding a *withdrawal* key under those conditions
 * would be indefensible; holding a key whose worst case is a bad trade on a
 * balance it cannot move is a trade-off worth offering, once it is stated.
 *
 * It follows that this module must never grow a `signHlWithdraw` or a
 * `signHlSendAsset`, even as a convenience that "just proxies to the phone".
 * The absence is the security property. [FORBIDDEN] states it in code so that
 * adding one is a deliberate act rather than an oversight.
 *
 * ## Why it presents itself as the plugin
 *
 * `perps-pro.js` signs through an object with `signHlOrder`, `signHlCancel`
 * and friends, provided on Android by the native bridge. Rather than teach the
 * terminal about a second kind of signer, this offers the same shape. The
 * terminal then trades from Telegram with no knowledge that anything changed,
 * which is also the only way the two stay in step as it grows.
 */
import * as secp from '@noble/secp256k1';
import { hmac } from '@noble/hashes/hmac';
import { sha256 } from '@noble/hashes/sha256';
import { keccak_256 } from '@noble/hashes/sha3';
import { toHex, fromHex } from './eip712';
import { digestFor, type Packable } from './l1action';
import { asterSignedQuery, asterRules, asterOrderParams, asterBracketParams } from './aster';
import { perpsKey } from './scope';

/* noble v2 will not sign synchronously until this is wired, and it fails at
   call time rather than at import, so it is done once, here, at module load,
   where a mistake shows up immediately instead of under a finger. */
secp.etc.hmacSha256Sync = (k: Uint8Array, ...m: Uint8Array[]) =>
  hmac(sha256, k, secp.etc.concatBytes(...m));

/* Scoped to the proven wallet, exactly like the master key in ./local.
 *
 * This was a fixed path, and scoping the master key alone left the SAME bug
 * standing for the other signer this browser can hold: wallet B connecting in
 * a shared browser read wallet A's agent key and could open and close
 * positions on A's Hyperliquid account. The venue refuses withdraw3 and
 * sendAsset for an agent, so the ceiling is "trade badly with someone else's
 * margin" rather than "take it", which is a smaller hole and the same shape.
 *
 * Found by attacking the shipped 2.8.7 fix rather than its design; the design
 * pass never looked at this file. */
const STORE_BASE = 'ghoster.perps.agent';
function agentKeyPath(): string | null {
  return perpsKey(STORE_BASE);
}

/**
 * Actions an agent key must never be able to produce.
 *
 * Listed rather than merely omitted: a name here is refused loudly if anything
 * ever asks for it, so the boundary shows up in a stack trace instead of in an
 * account that has been emptied.
 */
const FORBIDDEN = ['signHlWithdraw', 'signHlSendAsset', 'signEvmTransaction', 'signTypedData'];

export interface AgentIdentity {
  /** The agent's own address, what the phone approves. */
  address: string;
  /** The master account it trades for, learned at pairing. */
  master: string | null;
  /** Short label shown on both screens. Matches the phone's AGENT_NAME rule. */
  name: string;
  createdAt: number;
}

interface Stored extends AgentIdentity {
  key: string;
}

function addressOf(priv: Uint8Array): string {
  const pub = secp.getPublicKey(priv, false).slice(1);
  return '0x' + toHex(keccak_256(pub)).slice(-40);
}

function read(): Stored | null {
  try {
    const path = agentKeyPath();
    if (!path) return null; // no proven wallet: this browser has no agent key
    const raw = localStorage.getItem(path);
    if (!raw) return null;
    const j = JSON.parse(raw) as Stored;
    return j && typeof j.key === 'string' && /^0x[0-9a-f]{64}$/i.test(j.key) ? j : null;
  } catch {
    return null;
  }
}

function write(s: Stored): void {
  const path = agentKeyPath();
  /* Refused rather than written to a shared path. A pairing minted with no
     proven wallet is a pairing nothing can attribute, which is how the
     unscoped key became readable by the next wallet through this browser. */
  if (!path) throw new Error('Connect your wallet before pairing this browser.');
  localStorage.setItem(path, JSON.stringify(s));
}

/** The stored identity, or null when this browser has never been paired. */
export function identity(): AgentIdentity | null {
  const s = read();
  if (!s) return null;
  return { address: s.address, master: s.master, name: s.name, createdAt: s.createdAt };
}

/**
 * Make a key for this browser, once.
 *
 * Generated locally and never sent anywhere: the phone is told the *address*,
 * which is public, and the private half stays here. Returning the existing one
 * rather than a fresh one matters, a second key would silently invalidate the
 * approval the owner already gave to the first.
 */
export function ensureKey(name = 'telegram'): AgentIdentity {
  const existing = read();
  if (existing) return identity()!;
  const priv = secp.utils.randomPrivateKey();
  const s: Stored = {
    key: toHex(priv),
    address: addressOf(priv),
    master: null,
    name,
    createdAt: Date.now(),
  };
  write(s);
  return identity()!;
}

/** Record which account approved this key, once the phone has said so. */
export function setMaster(master: string): void {
  const s = read();
  if (!s) throw new Error('There is no agent key in this browser yet.');
  if (!/^0x[0-9a-fA-F]{40}$/.test(master)) throw new Error('That is not an account address.');
  s.master = master;
  write(s);
}

/**
 * Forget the key.
 *
 * Local only, and deliberately not described as a revoke: the venue still
 * honours the approval until the phone revokes it there. Saying otherwise
 * would leave someone believing a stolen key had been disarmed when it had
 * only been forgotten on one device.
 */
export function forget(): void {
  const path = agentKeyPath();
  if (path) localStorage.removeItem(path);
}

function privateKey(): Uint8Array {
  const s = read();
  if (!s) throw new Error('This browser has no trading key. Pair it from your phone first.');
  return fromHex(s.key);
}

/* ---- Aster: the same key, approved separately ----------------------------
   Aster's approval is the wallet's own signature under Aster's domain, so a
   key the phone approved for Hyperliquid is not yet Aster's agent, and
   `master` above says nothing about Aster. Aster's approval has its own
   record beside the key, under the same wallet scope, naming the key it was
   given for: a key made afresh is unapproved whatever the record says. */
const ASTER_BASE = 'ghoster.perps.aster';

interface AsterRecord {
  /** The wallet whose Aster account this key trades for. */
  user: string;
  /** The key that was approved; must be the key held now. */
  agent: string;
  /** When Aster stops honouring it, in milliseconds. */
  expired: number;
  approvedAt: number;
}

function readAster(): AsterRecord | null {
  try {
    const path = perpsKey(ASTER_BASE);
    if (!path) return null;
    const raw = localStorage.getItem(path);
    if (!raw) return null;
    const j = JSON.parse(raw) as AsterRecord;
    const key = read();
    if (!j || !key || String(j.agent).toLowerCase() !== key.address.toLowerCase()) return null;
    if (!/^0x[0-9a-fA-F]{40}$/.test(String(j.user))) return null;
    return j;
  } catch {
    return null;
  }
}

export interface AsterIdentity {
  agent: string | null;
  user: string | null;
  expired: number;
  /** Approved, and not yet expired. */
  approved: boolean;
}

/** Where this key stands with Aster. */
export function asterIdentity(): AsterIdentity {
  const key = read();
  const a = readAster();
  const live = !!(a && a.expired > Date.now());
  return { agent: key?.address ?? null, user: live ? a!.user : null, expired: a?.expired ?? 0, approved: live };
}

/** Record that `user` approved this key on Aster, once the venue has said so. */
export function recordAsterApproval(a: { user: string; expired: number }): void {
  const key = read();
  if (!key) throw new Error('There is no agent key in this browser yet.');
  if (!/^0x[0-9a-fA-F]{40}$/.test(a.user)) throw new Error('That is not an account address.');
  const path = perpsKey(ASTER_BASE);
  if (!path) throw new Error('Connect your wallet before approving this browser.');
  const rec: AsterRecord = { user: a.user, agent: key.address, expired: Number(a.expired) || 0, approvedAt: Date.now() };
  localStorage.setItem(path, JSON.stringify(rec));
}

/** Local only, like [forget]: Aster honours the approval until its expiry or a revoke there. */
export function forgetAster(): void {
  const path = perpsKey(ASTER_BASE);
  if (path) localStorage.removeItem(path);
}

/** Sign an L1 action with the agent key and shape it the way the plugin does. */
function signAction(action: Packable, opts: { testnet?: boolean } = {}) {
  const nonce = BigInt(Date.now());
  const d = digestFor(action, nonce, { testnet: opts.testnet });
  const sig = secp.sign(d, privateKey());
  const compact = sig.toCompactRawBytes();
  return {
    action,
    nonce: String(nonce),
    r: toHex(compact.slice(0, 32)),
    s: toHex(compact.slice(32, 64)),
    v: 27 + sig.recovery,
  };
}

/* ---- the action shapes, mirroring HlAction.kt exactly -------------------- */

/**
 * A number as the venue's wire string.
 *
 * Mirrors HlAction.floatToWire: eight decimal places, then trailing zeros
 * stripped, and a refusal rather than a rounding if the value will not fit.
 * Rounding here would sign a price that is not the price on the screen.
 */
export function floatToWire(x: number): string {
  const rounded = x.toFixed(8);
  if (Math.abs(Number(rounded) - x) >= 1e-12) {
    throw new Error(`${x} cannot be represented in 8 decimal places without rounding`);
  }
  let s = rounded === '-0.00000000' ? '0.00000000' : rounded;
  if (s.includes('.')) s = s.replace(/0+$/, '').replace(/\.$/, '');
  return s === '-0' ? '0' : s;
}

export interface OrderOpts {
  asset: number;
  isBuy: boolean;
  price: number;
  size: number;
  reduceOnly?: boolean;
  tif?: string;
  triggerPx?: number;
  tpsl?: string;
  isMarket?: boolean;
  /* The name the screens actually send. TradePlugin.kt has always read
     `triggerMarket`; this file read `isMarket` and nothing bridged them, so
     every trigger signed in a browser came out `isMarket: false` however the
     Market/Limit switch was set. A stop signed as a limit rests at its own
     price instead of taking the book, which is a stop that can fail to fill in
     the exact move it exists for. Both names are accepted; the default matches
     the native signer's. */
  triggerMarket?: boolean;
  testnet?: boolean;
}

/* Exported so the browser-master signer (local.ts) shapes an order exactly as
   the agent signer does. Two copies of this would be two chances to sign
   something other than what the screen said. */
export function orderStruct(o: OrderOpts): Packable {
  const base: Record<string, Packable> = {
    a: o.asset,
    b: o.isBuy,
    p: floatToWire(o.price),
    s: floatToWire(o.size),
    r: !!o.reduceOnly,
  };
  if (o.tpsl) {
    if (o.tpsl !== 'tp' && o.tpsl !== 'sl') throw new Error('tpsl must be tp or sl');
    if (typeof o.triggerPx !== 'number') throw new Error('a trigger order needs a trigger price');
    base.t = {
      trigger: {
        isMarket: o.triggerMarket ?? o.isMarket ?? true,
        triggerPx: floatToWire(o.triggerPx),
        tpsl: o.tpsl,
      },
    };
    base.r = o.reduceOnly === undefined ? true : !!o.reduceOnly;
  } else {
    base.t = { limit: { tif: o.tif || 'Gtc' } };
  }
  return base;
}

export const agentSigner = {
  /** True when this browser holds a key an account has approved. */
  ready(): boolean {
    const s = read();
    return !!(s && s.master);
  },

  address(): string | null {
    return read()?.address ?? null;
  },

  master(): string | null {
    return read()?.master ?? null;
  },

  signHlOrder(o: OrderOpts) {
    return Promise.resolve(
      signAction({ type: 'order', orders: [orderStruct(o)], grouping: 'na' }, o),
    );
  },

  /**
   * Several orders under ONE signature.
   *
   * The venue has always taken a list; the client was sending an entry and its
   * two brackets as three separate actions, which is three approvals for one
   * decision. On a perps screen that is not a papercut: it is three dialogs
   * during which the price keeps moving, and a stop that only exists after the
   * third one is approved.
   *
   *   normalTpsl    [entry, tp, sl]  the brackets arm when the parent fills
   *   positionTpsl  [tp, sl]         brackets over a position already open
   *
   * Grouping is passed rather than inferred, because the two cases differ in
   * what the venue attaches the children to and guessing wrong would arm a
   * bracket against nothing.
   */
  signHlOrders(o: { orders: OrderOpts[]; grouping: string; testnet?: boolean }) {
    if (!o.orders || !o.orders.length) return Promise.reject(new Error('No orders to sign.'));
    return Promise.resolve(
      signAction(
        { type: 'order', orders: o.orders.map(orderStruct), grouping: o.grouping || 'na' },
        o,
      ),
    );
  },

  /**
   * Cancel one resting order.
   *
   * `oid` arrives as a STRING from every call site in perps-pro.js, because
   * the native plugin takes it that way (`getString("oid")?.toLongOrNull()`)
   * and a JS number cannot hold a large venue order id exactly. msgpack would
   * have packed that string AS a string, which hashes differently from the
   * integer the venue signs, so every cancel from a browser would have been
   * refused by a signer nobody recognises. Converted here, and refused rather
   * than coerced to something meaningless.
   */
  signHlCancel(o: { asset: number; oid: number | string; testnet?: boolean }) {
    const oid = typeof o.oid === 'bigint' ? o.oid : BigInt(String(o.oid).trim());
    if (!(oid > 0n)) return Promise.reject(new Error('That is not an order id.'));
    return Promise.resolve(
      signAction({ type: 'cancel', cancels: [{ a: o.asset, o: oid }] }, o),
    );
  },

  signHlModify(o: OrderOpts & { oid: number }) {
    return Promise.resolve(
      signAction({ type: 'batchModify', modifies: [{ oid: o.oid, order: orderStruct(o) }] }, o),
    );
  },

  signHlLeverage(o: { asset: number; isCross: boolean; leverage: number; testnet?: boolean }) {
    return Promise.resolve(
      signAction(
        { type: 'updateLeverage', asset: o.asset, isCross: o.isCross, leverage: o.leverage },
        o,
      ),
    );
  },

  /**
   * Add or remove isolated margin on a position.
   *
   * The callers pass `{ coin, asset, usd }` with a signed dollar amount, not
   * `ntli`: that conversion belongs to the signer, and the native one does it
   * (`Math.round(usd * 1e6)`, then isBuy hardcoded true, per
   * HlAction.updateIsolatedMarginAction). This mirrors it exactly. Reading a
   * non-existent `o.ntli` produced `undefined`, which the packer drops from
   * the map, so the action lost two of its four fields and the venue was
   * asked something that was not the instruction on the screen.
   */
  signHlMargin(o: { asset: number; usd: number; testnet?: boolean }) {
    const usd = Number(o.usd);
    if (!isFinite(usd) || usd === 0) {
      return Promise.reject(new Error('A non-zero amount is required.'));
    }
    const ntli = BigInt(Math.round(usd * 1e6));
    return Promise.resolve(
      signAction(
        /* isBuy is true for both directions: the venue reads the SIGN of ntli
           to tell adding from removing. Matching the phone, field for field. */
        { type: 'updateIsolatedMargin', asset: o.asset, isBuy: true, ntli },
        o,
      ),
    );
  },

  /**
   * One Aster request, signed by this key as the agent Aster approved.
   *
   * Returns the whole query string: the caller's parameters, then nonce, user
   * and signer in Aster's order, then the signature over exactly that text
   * (perps/aster.ts). Only Aster's request domain is ever signed here; the
   * approval that makes this key an agent is the wallet's signature, from the
   * browser master or the phone, never from this key.
   */
  /**
   * A read signed for `user` before any approval is recorded here: how a
   * paired browser learns that its phone approved this key on Aster
   * (perps-pro.js asterProbePaired). Aster answers it only when `user` has
   * approved this key, which is the whole point: the answer comes from the
   * venue, never from our own server.
   */
  signAsterProbe(o: { user: string; params?: Record<string, string> }) {
    const key = read();
    if (!key) return Promise.reject(new Error('This browser has no trading key yet.'));
    const user = String(o?.user || '').toLowerCase();
    if (!/^0x[0-9a-f]{40}$/.test(user)) return Promise.reject(new Error('That is not an account address.'));
    try {
      const params = Object.fromEntries(
        Object.entries(o?.params || {}).map(([k, v]) => [k, String(v)]),
      );
      return Promise.resolve({
        query: asterSignedQuery(params, { user, signer: key.address }, fromHex(key.key)),
        user,
        signer: key.address,
      });
    } catch (e) {
      return Promise.reject(e instanceof Error ? e : new Error(String(e)));
    }
  },

  signAsterRequest(o: { params: Record<string, string> }) {
    const key = read();
    if (!key) return Promise.reject(new Error('This browser has no trading key yet.'));
    const a = readAster();
    if (!a) return Promise.reject(new Error('Aster has not approved this key yet.'));
    if (!(a.expired > Date.now())) return Promise.reject(new Error('Aster\'s approval of this key has expired.'));
    try {
      const params = Object.fromEntries(
        Object.entries(o?.params || {}).map(([k, v]) => [k, String(v)]),
      );
      return Promise.resolve({
        query: asterSignedQuery(params, { user: a.user, signer: key.address }, fromHex(key.key)),
        user: a.user,
        signer: key.address,
      });
    } catch (e) {
      return Promise.reject(e instanceof Error ? e : new Error(String(e)));
    }
  },
};

/**
 * Attach the refusals, on whichever object is about to be handed out.
 *
 * Applied per object rather than once, because these were originally defined
 * non-enumerable on `agentSigner` alone and then spread into the published
 * object, and spread copies only *enumerable* own properties, so they were
 * dropped on the way out. The result still refused to sign, which is why it
 * looked fine, but it refused with "is not a function" instead of saying why,
 * and the boundary this file exists to state was absent from the only object
 * anything actually calls.
 */
function guard<T extends object>(target: T): T {
  for (const name of FORBIDDEN) {
    Object.defineProperty(target, name, {
      value: () =>
        Promise.reject(
          new Error(
            `An agent key cannot ${name}. Moving money is signed on your phone, `
              + 'by the wallet that owns the account.',
          ),
        ),
      enumerable: true,
      configurable: true,
    });
  }
  return target;
}

guard(agentSigner);

/** Publish for perps-pro.js, which looks for this when there is no native bridge. */
export function install(): void {
  (window as unknown as Record<string, unknown>).__ghosterAgent = guard({
    ...agentSigner,
    identity,
    ensureKey,
    setMaster,
    forget,
    asterIdentity,
    recordAsterApproval,
    forgetAster,
    /* Aster's order shapes, pure: what an order sends, for perps-pro.js to sign through signAsterRequest */
    asterRules,
    asterOrderParams,
    asterBracketParams,
  });
}
