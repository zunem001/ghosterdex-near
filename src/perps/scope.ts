/**
 * Which wallet a browser-held trading key belongs to.
 *
 * ## The bug this exists to end
 *
 * The browser master key lived at the fixed localStorage path
 * `ghoster.perps.master`, with no wallet anywhere in it. One browser, one key.
 * So a second wallet connecting in the same browser or Telegram webview read
 * the FIRST wallet's key and could sign orders on its Hyperliquid account:
 * not merely see the positions, place and close them. Reported 2026-08-06 with
 * a recording of a $0.00 vault sitting above $30.38 of somebody else's perps.
 *
 * The Android app hit the same class of bug and fixed it by scoping per wallet
 * slot (TradePlugin.kt, addrKey()). This is that fix for the web layer, plus
 * the part Android did not need.
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
 * against a ton_proof. Neither is a hint. A provisional or remembered "last
 * wallet" would reopen the hole it closes, because signing happens on the
 * strength of the local key alone: sign before the wallet is settled and the
 * new wallet is once again trading on the old one's account.
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
    return normalise((localStorage.getItem('ghoster.tonauth') || '').split('.')[0]);
  } catch {
    return null;
  }
}

/** The wallet the address caches below were last written for. */
const CACHE_OWNER = 'ghoster.perps.wallet';

/**
 * Tell the scope which wallet is connected. Null clears it.
 *
 * Also the one place a wallet CHANGE is noticed, which is what closes the
 * read-only half of the leak. `ghoster.tradeAddr` and `.view` are caches of a
 * public trading address read by the classic scripts in public/ (perps-pro,
 * fund-pro, perps-activity). Those cannot import from src/, so rather than
 * thread a scope through three vanilla files, the cache is made unable to
 * OUTLIVE its wallet: the moment a different wallet is proven, it is dropped
 * and the discovery ladder re-derives for whoever is actually connected.
 * Without this, wallet B would correctly have no signing key and still sit
 * there reading wallet A's positions and balance out of a stale slot.
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
 * Every perps storage key in the app must come from here. A literal string
 * anywhere else is the bug coming back.
 */
export function perpsKey(base: string): string | null {
  const w = perpsScope();
  return w ? `${base}@${w}` : null;
}

/* ---- the legacy, unscoped values ---------------------------------------- */

const LEGACY_MASTER = 'ghoster.perps.master';
const LEGACY_SAVED = 'ghoster.perps.master.saved';
/** Where an unattributable legacy master waits to be claimed by hand. */
export const ORPHAN_KEY = 'ghoster.perps.orphan';

/**
 * How the current wallet came to hold its key: 'mint' or 'claim'.
 *
 * Scoped like the key itself. This exists because [removeMasterCopiesElsewhere]
 * could not tell the difference between the two cases that look identical in
 * storage: my own copy under an address I used to have, and somebody else's
 * original. Bytes cannot answer that. Provenance can.
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
 * Deal with what the old build left behind. Runs once per browser, at boot.
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
 * by that exact key. Deleting it is fund loss. Adopting it into whichever
 * wallet boots first is the permanent wrong association, and the wrong wallet
 * would be trading on the right one's money, which is the reported bug wearing
 * a different hat.
 *
 * So it is moved somewhere no wallet reads, and the owner is offered it by
 * name, with the address shown, in the trading-key sheet. Nothing anywhere
 * ever recorded which wallet made this key; a claim is the only honest way to
 * find out, and it is reversible.
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

/** The quarantined key, if this browser has one waiting. */
export function orphanSecret(): string | null {
  try {
    const v = localStorage.getItem(ORPHAN_KEY);
    return v && /^0x[0-9a-f]{64}$/.test(v) ? v : null;
  } catch {
    return null;
  }
}

/**
 * Master keys stored under some OTHER wallet than the one connected.
 *
 * Scoping introduces a failure mode it must also answer for: the scope is the
 * wallet's raw address, and a raw address is not forever. Upgrading a TON
 * wallet contract (v4R2 to W5 is the common one) gives the same person a
 * different raw address, so `...master@0:old` becomes a key nothing reads,
 * holding a funded Hyperliquid account. Scoping without this would trade a
 * leak for a lockout, which is the worse of the two.
 *
 * These are OFFERED, never read automatically. The signing path stays strictly
 * bound to the connected wallet; this only lets the owner see that a key is
 * here and say it is theirs, with the same warning the legacy orphan carries.
 * On a shared browser the other wallet's key is visible in this list, so the
 * claim is deliberate, named by address, and reversible.
 */
export function foreignMasters(): { scope: string; secret: string }[] {
  const out: { scope: string; secret: string }[] = [];
  try {
    const mine = perpsScope();
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (!k || !k.startsWith(`${LEGACY_MASTER}@`)) continue;
      const scope = k.slice(LEGACY_MASTER.length + 1);
      if (!scope || scope === mine) continue;
      const secret = localStorage.getItem(k);
      if (secret && /^0x[0-9a-f]{64}$/.test(secret)) out.push({ scope, secret });
    }
  } catch {
    /* storage unavailable: nothing to offer */
  }
  return out;
}

/**
 * Stop offering a key to THIS wallet, without destroying it.
 *
 * "Not mine" used to call removeItem on the quarantine, which is a one-tap
 * unconfirmed delete of a key that may hold another person's funds, offered,
 * on a shared browser, to precisely the person who cannot know what it holds
 * and has just been told it is not theirs. Saying "this is not mine" is a
 * statement about the speaker, never a licence to destroy it.
 *
 * So the key stays exactly where it is and this wallet stops being shown it.
 * The rightful owner connects their own wallet and is offered it as before.
 * Hiding is per wallet AND per key, so dismissing one does not bury another.
 */
export function hideFromThisWallet(secret: string): void {
  try {
    const w = perpsScope() || 'nowallet';
    const tag = secret.slice(-16); // enough to name it, never the key itself
    localStorage.setItem(`ghoster.perps.hidden:${w}:${tag}`, '1');
  } catch {
    /* nowhere to remember it; the offer simply reappears */
  }
}

/**
 * Delete plaintext copies of ONE EXACT key held under other wallet scopes.
 *
 * A key reaches a second scope legitimately. Upgrading a TON wallet contract
 * gives the same owner a new raw address, so the claim flow copies the key to
 * the new scope and deliberately leaves the source alone. A mistaken claim has
 * to be reversible, and `hideFromThisWallet` above exists precisely because
 * deleting a key on someone's say-so is not acceptable.
 *
 * Two moments end that. Protecting the key means "no plaintext of this key is
 * on this device", and sealing only rewrites the current scope's slot; without
 * this sweep the same 32 bytes stay readable one storage key along, and
 * isProtected() reports true while the reader it defends against still wins.
 * Forgetting means "this account is off this device", and it was equally
 * partial. Someone wiping a laptop before selling it was told the account was
 * gone while a copy remained.
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
     * clears it unless the owner claims it explicitly. It sat outside this
     * sweep, so a key could be sealed or forgotten while a byte-identical
     * plaintext copy stayed one storage key along, which is exactly the
     * sold-laptop case above. Safe to take on an exact match for the same
     * reason the rest of the sweep is: matching the secret proves the caller
     * already holds those bytes, and the slot has no owner to take it from. */
    if (localStorage.getItem(ORPHAN_KEY) === secret) doomed.push(ORPHAN_KEY);

    /* Another wallet's slot is only ever swept by the wallet that MINTED the
     * key, and this is the line that stops a theft.
     *
     * "The caller demonstrably already holds those bytes" is true and does not
     * establish whose copy is the original. A second wallet in the same browser
     * is offered this key by foreignMasters(), can claim it, and could then
     * seal it, at which point this sweep deleted the FIRST wallet's slot. The
     * victim reconnected to "No trading account on this device yet" while the
     * same 32 bytes sat under the claimer's passphrase. No code execution, no
     * devtools, just the Settings screen, and a shared browser profile is
     * ordinary: a family laptop, or a Telegram Mini App, where TON Connect
     * sessions are shared across accounts on one origin.
     *
     * A claimer keeps their own copy and takes nobody else's. The cost is that
     * an owner whose wallet address changed leaves plaintext behind under the
     * old address, which is recoverable and not fund loss; the alternative cost
     * was somebody else's account. */
    const sweepOtherScopes = mintedHere();
    /* length/key(i), the same walk foreignMasters() uses above. Object.keys on
       localStorage happens to work in a browser and returns the method names on
       anything standing in for it, which is how the first version of this
       silently swept nothing at all. */
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

/** Whether this wallet has already said a given key is not theirs. */
export function hiddenFromThisWallet(secret: string): boolean {
  try {
    const w = perpsScope() || 'nowallet';
    return localStorage.getItem(`ghoster.perps.hidden:${w}:${secret.slice(-16)}`) === '1';
  } catch {
    return false;
  }
}

/** Retire the quarantine slot after its key has been CLAIMED into a wallet.
 *  Only ever called once the same secret is safely stored under a scope. */
export function orphanClaimed(): void {
  try {
    localStorage.removeItem(ORPHAN_KEY);
  } catch {
    /* nothing to remove */
  }
}
