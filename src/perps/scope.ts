/**
 * Which wallet a browser-held trading key belongs to.
 *
 * Every trading key this browser holds is stored under the wallet it belongs to, the way the phone scopes per wallet
 * slot (TradePlugin.kt, addrKey()), so one browser can serve several wallets and each reads only its own.
 *
 * ## Why the scope is the RAW address
 *
 * `0:<64hex>`, lowercased. Not the user-friendly EQ/UQ form: that varies with
 * the bounceable flag, so one wallet would land in two buckets and a key
 * written under one form would be invisible under the other. Raw is what the
 * worker canonicalises on and what the session token already carries.
 *
 * ## Why a scope must be PROVEN, never guessed
 *
 * Both sources below are wallets the app has actually established: a live
 * TON Connect account, or the prefix of a session token the server minted
 * against a ton_proof. Neither is a hint, because signing happens on the
 * strength of the local key alone, so nothing signs before the wallet is settled.
 *
 * With no proven wallet there is no scope, and with no scope there is no key.
 * The terminal briefly says it has no trading account and corrects itself the
 * moment the wallet settles, which is the harmless direction to be wrong in.
 */

const RAW_RE = /^-?\d+:[0-9a-f]{64}$/;

/** Set by WalletContext from the live connection. Not persisted here. */
let confirmed: string | null = null;

function normalise(addr: string | null | undefined): string | null {
  const s = String(addr || '').trim().toLowerCase();
  return RAW_RE.test(s) ? s : null;
}

/**
 * The wallet the session token was minted for.
 *
 * Format is `address.exp.mac`, so everything before the first dot is the raw
 * address (TON raw addresses hold no dots). The server verified the ton_proof
 * before issuing it, so this is a PROVEN wallet and not a remembered guess. It
 * exists so a reload does not strand a key until TON Connect finishes waking.
 */
function fromSessionToken(): string | null {
  try {
    const [address, exp] = (localStorage.getItem('ghoster.tonauth') || '').split('.');
    /* a session that has run out proves nothing any more */
    if (!(Number(exp) * 1000 > Date.now())) return null;
    return normalise(address);
  } catch {
    return null;
  }
}

/** The wallet the address caches below were last written for. */
const CACHE_OWNER = 'ghoster.perps.wallet';

/**
 * Tell the scope which wallet is connected. Null clears it.
 *
 * Also the one place a wallet change is noticed. `ghoster.tradeAddr` and `.view` are caches of a
 * public trading address read by the classic scripts in public/ (perps-pro,
 * fund-pro, perps-activity). Those cannot import from src/, so rather than
 * thread a scope through three vanilla files, the cache is made unable to
 * OUTLIVE its wallet: the moment a different wallet is proven, it is dropped
 * and the discovery ladder re-derives for whoever is actually connected.
 */
export function setPerpsWallet(addr: string | null | undefined): void {
  const next = normalise(addr);
  confirmed = next;
  if (!next) return; // a disconnect leaves the caches for the same wallet's return
  try {
    if (localStorage.getItem(CACHE_OWNER) === next) return;
    localStorage.setItem(CACHE_OWNER, next);
    localStorage.removeItem('ghoster.tradeAddr');
    localStorage.removeItem('ghoster.tradeAddr.view');
    /* Anything holding the old address in memory re-reads on this. The perps
       surfaces already listen for it, because a session change has always
       meant "the account under you moved". */
    window.dispatchEvent(new Event('ghoster:auth'));
  } catch {
    /* Storage unavailable: nothing is cached either, so nothing is stale. */
  }
}

/** The wallet every perps key path is scoped to, or null when none is proven. */
export function perpsScope(): string | null {
  return confirmed || fromSessionToken();
}

/**
 * A storage path for this wallet, or null when no wallet is proven.
 *
 * Every perps storage key in the app must come from here.
 */
export function perpsKey(base: string): string | null {
  const w = perpsScope();
  return w ? `${base}@${w}` : null;
}

/* ---- the legacy, unscoped values ---------------------------------------- */

const LEGACY_MASTER = 'ghoster.perps.master';
const LEGACY_SAVED = 'ghoster.perps.master.saved';
/** Where an unattributable legacy master waits to be restored by hand. */
export const ORPHAN_KEY = 'ghoster.perps.orphan';

/**
 * How the current wallet came to hold its key: 'mint' or 'claim'.
 *
 * Scoped like the key itself. [removeMasterCopiesElsewhere] needs it to tell apart two cases that look identical in
 * storage: a wallet's own copy under an older address, and another wallet's original. Bytes cannot answer that.
 * Provenance can.
 */
const ORIGIN_BASE = 'ghoster.perps.master.origin';

/** Record how this wallet came by the key it now holds. */
export function noteKeyOrigin(origin: 'mint' | 'claim'): void {
  try {
    const k = perpsKey(ORIGIN_BASE);
    if (k) localStorage.setItem(k, origin);
  } catch {
    /* storage unavailable: the sweep will simply refuse to delete, which is
       the safe direction. */
  }
}

/**
 * Whether this wallet minted the key it holds.
 *
 * Absent counts as NOT minted. Every key written before this record existed is
 * therefore treated as claimed, which costs an old install one uncollected
 * duplicate and cannot cost anyone their account.
 */
function mintedHere(): boolean {
  try {
    const k = perpsKey(ORIGIN_BASE);
    return Boolean(k) && localStorage.getItem(k as string) === 'mint';
  } catch {
    return false;
  }
}
const MIGRATED_FLAG = 'ghoster.perps.migrated';

/**
 * Move what was stored before keys were scoped. Runs once per browser, at boot.
 *
 * Three different values, three different answers, because what it costs to be
 * wrong differs by three orders of magnitude.
 *
 * DELETED on sight, following Android's precedent exactly: `ghoster.tradeAddr`
 * and `ghoster.tradeAddr.view` are cached PUBLIC addresses behind a discovery
 * ladder that re-derives them, so losing one costs a slower first paint; and
 * `ghoster.perps.agent` is an agent key the venue itself refuses for withdraw
 * and sendAsset, so losing it costs one re-pair and cannot cost money. None of
 * them records which wallet it came from, and TradePlugin.kt's reasoning
 * transfers word for word: adopting an unattributed value would stamp one
 * wallet's account onto whichever wallet happened to be open.
 *
 * QUARANTINED, never deleted and never adopted: `ghoster.perps.master`. This
 * is where Android's remedy must NOT be copied. There the shared value was a
 * public address, re-derivable from the active slot's phrase at the next
 * unlock, so deleting it was free. Here the shared value IS the secret, it is
 * derivable from nothing (a TON wallet cannot produce it: ed25519, and signData
 * mixes in a wallet-chosen timestamp), and this module's own neighbour says it
 * plainly, forgetting the key leaves whatever sits at the venue reachable only
 * by that exact key, so it is neither deleted nor adopted into whichever wallet boots first.
 *
 * So it is moved somewhere no wallet reads, and it stays there until someone
 * restores that same key by hand: nothing anywhere ever recorded which wallet
 * made it, so no wallet can be handed it.
 */
export function migrateLegacyPerps(): void {
  try {
    if (localStorage.getItem(MIGRATED_FLAG) === '1') return;

    for (const k of ['ghoster.tradeAddr', 'ghoster.tradeAddr.view', 'ghoster.perps.agent']) {
      localStorage.removeItem(k);
    }

    const legacy = localStorage.getItem(LEGACY_MASTER);
    if (legacy && /^0x[0-9a-f]{64}$/i.test(legacy)) {
      // Never clobber a quarantine that is already waiting: that would be the
      // one delete this whole function exists to avoid.
      if (!localStorage.getItem(ORPHAN_KEY)) {
        localStorage.setItem(ORPHAN_KEY, legacy.toLowerCase());
      }
    }
    localStorage.removeItem(LEGACY_MASTER);
    localStorage.removeItem(LEGACY_SAVED);
    localStorage.setItem(MIGRATED_FLAG, '1');
  } catch {
    /* Storage unavailable. Nothing was moved, so nothing was lost; the app
       simply has no local key, which is the safe way to be broken. */
  }
}

/** The quarantined key, if this browser has one: for the sweep and a restore by hand, never to offer. */
export function orphanSecret(): string | null {
  try {
    const v = localStorage.getItem(ORPHAN_KEY);
    return v && /^0x[0-9a-f]{64}$/.test(v) ? v : null;
  } catch {
    return null;
  }
}

/**
 * Other addresses this browser holds a master key under. Addresses, never keys: another wallet's key stays that wallet's.
 *
 * The scope is the wallet's raw address, and a raw address is not forever. Upgrading a TON wallet contract (v4R2 to W5
 * is the common one) gives the same key a different raw address, so `...master@0:old` becomes a key nothing reads,
 * holding a funded Hyperliquid account. The trading-key sheet asks GhosterDex whether such an address comes from the
 * key this wallet proved at login (/api/trade/samekey), and only then moves the key across (masterUnder). The signing
 * path stays bound to the connected wallet throughout.
 */
export function foreignScopes(): string[] {
  const out: string[] = [];
  try {
    const mine = perpsScope();
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (!k || !k.startsWith(`${LEGACY_MASTER}@`)) continue;
      const scope = k.slice(LEGACY_MASTER.length + 1);
      if (!scope || scope === mine) continue;
      if (/^0x[0-9a-f]{64}$/.test(localStorage.getItem(k) || '')) out.push(scope);
    }
  } catch {
    /* storage unavailable: nothing here */
  }
  return out;
}

/** The copy under an address just proven to be this wallet's, once the key has moved here. */
export function dropMasterUnder(scope: string): void {
  try {
    localStorage.removeItem(`${LEGACY_MASTER}@${scope}`);
  } catch {
    /* nothing to remove */
  }
}

const REMOVED_BASE = 'ghoster.perps.removed';

/** This wallet's owner took the account off this browser: nothing brings it back on its own. */
export function noteAccountRemoved(): void {
  try {
    const k = perpsKey(REMOVED_BASE);
    if (k) localStorage.setItem(k, '1');
  } catch {
    /* nowhere to remember it */
  }
}

export function accountRemoved(): boolean {
  try {
    const k = perpsKey(REMOVED_BASE);
    return Boolean(k) && localStorage.getItem(k as string) === '1';
  } catch {
    return false;
  }
}

/** The key held under another address, for the one caller that has just proved that address is this same wallet's. */
export function masterUnder(scope: string): string | null {
  try {
    const secret = localStorage.getItem(`${LEGACY_MASTER}@${scope}`);
    return secret && /^0x[0-9a-f]{64}$/.test(secret) ? secret : null;
  } catch {
    return null;
  }
}

/**
 * Delete plaintext copies of ONE EXACT key held under other wallet scopes.
 *
 * A key reaches a second scope legitimately. Upgrading a TON wallet contract
 * gives the same owner a new raw address, so the move copies the key to the new
 * scope and leaves the source alone.
 *
 * Two moments end that. Protecting the key means no plaintext of it is on this device, and forgetting means the
 * account is off this device. Each of those rewrites only the current scope's slot, so this sweep takes the copies
 * elsewhere.
 *
 * Matched on the SECRET, never on the scope. Another wallet's own unrelated key
 * belongs to whoever put it there; the only thing removed is a duplicate of the
 * key the caller demonstrably already holds. Returns how many it removed, so a
 * caller can say so rather than guess.
 */
export function removeMasterCopiesElsewhere(secret: string): number {
  const doomed: string[] = [];
  try {
    const mine = perpsScope();

    /* The quarantine slot, which belongs to nobody.
     *
     * migrateLegacyPerps parks a pre-scoping key here and nothing else ever
     * clears it unless the owner restores it by hand. Safe to take on an exact match for the same
     * reason the rest of the sweep is: matching the secret proves the caller
     * already holds those bytes, and the slot has no owner to take it from. */
    if (localStorage.getItem(ORPHAN_KEY) === secret) doomed.push(ORPHAN_KEY);

    /* Another wallet's slot is only ever swept by the wallet that MINTED the key. Holding the bytes does not establish
     * whose copy is the original, so a claimer keeps their own copy and takes nobody else's. The cost is that an owner
     * whose wallet address changed leaves plaintext behind under the old address, which is recoverable. */
    const sweepOtherScopes = mintedHere();
    /* length/key(i), the same walk foreignScopes() uses above: Object.keys returns the method names on anything
       standing in for localStorage. */
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (!k || !k.startsWith(`${LEGACY_MASTER}@`)) continue;
      const scope = k.slice(LEGACY_MASTER.length + 1);
      if (!scope || scope === mine) continue;
      if (!sweepOtherScopes) continue;
      if (localStorage.getItem(k) !== secret) continue;
      doomed.push(k);
    }
    // Collected first: removing mid-walk renumbers everything after it, and a
    // sweep that skips half its targets is worse than one that never ran.
    for (const k of doomed) localStorage.removeItem(k);
  } catch {
    /* storage unavailable: nothing to sweep, and nothing was promised */
  }
  return doomed.length;
}
