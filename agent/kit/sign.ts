/**
 * The two signatures GhosterDex asks a wallet for, byte for byte the phone's
 * (android crypto/TonProofSigner.kt and TonConnectSigner.kt), because the
 * worker and the intent contract verify exactly these envelopes and a single
 * drifted byte only ever comes back as "invalid signature".
 */
import { createHash } from 'node:crypto';
import nacl from 'tweetnacl';
import type { Keys } from './wallet';

export const DOMAIN = 'ghosterdex.com';

const sha256 = (b: Buffer) => createHash('sha256').update(b).digest();

function be(value: bigint | number, bytes: number): Buffer {
  const out = Buffer.alloc(bytes);
  let v = BigInt(value);
  for (let i = bytes - 1; i >= 0; i--) {
    out[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return out;
}

function le(value: bigint | number, bytes: number): Buffer {
  const out = Buffer.alloc(bytes);
  let v = BigInt(value);
  for (let i = 0; i < bytes; i++) {
    out[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return out;
}

function splitRaw(address: string): { wc: number; hash: Buffer } {
  const [wc, hex] = address.split(':');
  if (!hex || hex.length !== 64) throw new Error(`Malformed raw address: ${address}`);
  return { wc: Number(wc), hash: Buffer.from(hex, 'hex') };
}

/** A TON Connect ton_proof for the login challenge. */
export function tonProof(keys: Keys, address: string, payload: string, timestamp = Math.floor(Date.now() / 1000)) {
  const { wc, hash } = splitRaw(address);
  const domain = Buffer.from(DOMAIN, 'utf8');
  const message = Buffer.concat([
    Buffer.from('ton-proof-item-v2/', 'utf8'),
    be(wc, 4),
    hash,
    le(domain.length, 4),
    domain,
    le(timestamp, 8),
    Buffer.from(payload, 'utf8'),
  ]);
  const full = Buffer.concat([Buffer.from([0xff, 0xff]), Buffer.from('ton-connect', 'utf8'), sha256(message)]);
  const signature = Buffer.from(nacl.sign.detached(sha256(full), keys.secretKey));
  return {
    timestamp,
    domain: { lengthBytes: domain.length, value: DOMAIN },
    signature: signature.toString('base64'),
    payload,
  };
}

export type WalletSig = {
  signature: string;
  address: string;
  timestamp: number;
  domain: string;
  payload: { type: 'text'; text: string };
};

/** The bytes a TON Connect signData (text) signs the SHA-256 of. */
export function signDataPreimage(address: string, domain: string, timestamp: number, text: string): Buffer {
  const { wc, hash } = splitRaw(address);
  const dom = Buffer.from(domain, 'utf8');
  const body = Buffer.from(text, 'utf8');
  return Buffer.concat([
    Buffer.from([0xff, 0xff]),
    Buffer.from('ton-connect/sign-data/', 'utf8'),
    be(wc, 4),
    hash,
    be(dom.length, 4),
    dom,
    be(timestamp, 8),
    Buffer.from('txt', 'utf8'),
    be(body.length, 4),
    body,
  ]);
}

/** A TON Connect signData over text: the approval for one private move. */
export function signText(keys: Keys, address: string, text: string, timestamp = Math.floor(Date.now() / 1000)): WalletSig {
  const preimage = signDataPreimage(address, DOMAIN, timestamp, text);
  const signature = Buffer.from(nacl.sign.detached(sha256(preimage), keys.secretKey));
  return { signature: signature.toString('base64'), address, timestamp, domain: DOMAIN, payload: { type: 'text', text } };
}

/** Whether `publicKey` (hex) made this signData, as any wallet would have, for any domain it names. */
export function signedBy(publicKey: string, sig: WalletSig): boolean {
  try {
    if (!/^[0-9a-f]{64}$/.test(publicKey) || sig?.payload?.type !== 'text' || typeof sig.signature !== 'string') return false;
    if (!Number.isSafeInteger(sig.timestamp) || sig.timestamp < 0) return false;
    const s = Buffer.from(sig.signature, 'base64');
    if (s.length !== 64) return false;
    const pre = signDataPreimage(sig.address, String(sig.domain || ''), sig.timestamp, sig.payload.text);
    return nacl.sign.detached.verify(sha256(pre), s, Buffer.from(publicKey, 'hex'));
  } catch {
    return false;
  }
}
