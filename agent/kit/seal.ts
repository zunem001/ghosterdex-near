/**
 * A sealed copy of this key, so the owner can bring the money home without
 * this machine (instant withdrawal).
 *
 * The owner approves each of their devices with their wallet's signature
 * over one exact text (deviceText). GhosterDex hands the kit that list and
 * the kit trusts none of it: each entry is checked against the owner key
 * pinned at pairing, and only a device that passes gets a copy, sealed so
 * that device alone can open it (X25519 with XSalsa20-Poly1305, a fresh
 * one-time key per copy from this machine's checked randomness). GhosterDex
 * keeps copies it cannot read.
 *
 * GDX_SEAL=off keeps the key on this machine only and withdraws any copies;
 * the owner then gets money back the slower way, through the kit.
 */
import nacl from 'tweetnacl';
import { signedBy, type WalletSig } from './sign';
import { refreshTrust, saveKeystore, type Keystore } from './wallet';

export type SealBlob = { v: 1; to: string; epk: string; n: string; c: string };
export type OwnerDevice = { pk: string; label: string; proof: WalletSig };

/** The one text an owner's wallet signs to approve a device (worker/agents.ts and the app build the same). */
export function deviceText(ownerKey: string, devicePk: string, label: string): string {
  return [
    'GhosterDex agent keys v1',
    "This device may open your agents' sealed keys to return their funds to you.",
    `Owner key: ${ownerKey}`,
    `Device key: ${devicePk}`,
    `Device: ${label}`,
  ].join('\n');
}

/** A device the pinned owner key really approved: this device key, this name, signed for GhosterDex. */
export function deviceApproved(ownerKey: string, d: OwnerDevice): boolean {
  if (!/^[0-9a-f]{64}$/.test(ownerKey) || !/^[0-9a-f]{64}$/.test(String(d?.pk || ''))) return false;
  if (!/(^|\.)ghosterdex\.com$/.test(String(d.proof?.domain || ''))) return false;
  if (d.proof?.payload?.text !== deviceText(ownerKey, d.pk, String(d.label))) return false;
  return signedBy(ownerKey, d.proof);
}

/**
 * The owner key this kit trusts. The first one GhosterDex names is pinned in
 * wallet.json and kept; only pairing again, which the owner starts with a new
 * code, replaces it. Answers the pinned key, or null when there is none.
 * `via` records which it was, because only an explicit pairing may undo what
 * a previous owner was given (kit.ts keepOwnerControl).
 */
export function pinOwner(ks: Keystore, key: string | null | undefined, repin = false): string | null {
  const k = String(key || '').toLowerCase();
  /* a copy loaded before the pin was made must take the file's pin, never make its own */
  if (!repin && !ks.owner) refreshTrust(ks);
  if (/^[0-9a-f]{64}$/.test(k) && (repin || !ks.owner) && ks.owner?.key !== k) {
    ks.owner = { key: k, pinnedAt: new Date().toISOString(), via: repin ? 'pair' : 'first' };
    saveKeystore(ks);
  }
  return ks.owner?.key || null;
}

/** Whether this machine keeps its key to itself (GDX_SEAL=off). */
export function sealingOff(): boolean {
  return /^(0|off|no|false)$/i.test(String(process.env.GDX_SEAL || '').trim());
}

/** One copy of `plain` that only the holder of `devicePk`'s secret can open. `random` is 56 fresh bytes. */
export function sealFor(devicePk: string, plain: Uint8Array, random: Uint8Array): SealBlob {
  if (random.length !== 56) throw new Error('A seal needs 56 random bytes.');
  const eph = nacl.box.keyPair.fromSecretKey(random.slice(0, 32));
  const n = random.slice(32, 56);
  const c = nacl.box(plain, n, Buffer.from(devicePk, 'hex'), eph.secretKey);
  eph.secretKey.fill(0);
  const b64 = (b: Uint8Array) => Buffer.from(b).toString('base64');
  return { v: 1, to: devicePk, epk: b64(eph.publicKey), n: b64(n), c: b64(c) };
}
