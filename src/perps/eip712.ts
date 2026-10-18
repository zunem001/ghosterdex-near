/**
 * EIP-712 typed-data hashing, for the agent key that trades from this browser.
 *
 * This is the second implementation of an encoder the Android app already has
 * in Eip712.kt, and the two must agree exactly: a digest that differs by one
 * byte produces a signature that recovers to a different address, which the
 * venue rejects as a signer nobody recognises. So this does not merely aim to
 * be correct, it proves it, [assertTrustworthy] reproduces the worked example
 * published in EIP-712 itself, and refuses to let anything sign if it cannot.
 *
 * A wrong encoder that is never checked is the failure mode worth spending
 * code on here: it does not throw, it does not warn, it just signs documents
 * that mean something other than what was shown.
 */
import { keccak_256 } from '@noble/hashes/sha3';

export interface Field {
  name: string;
  type: string;
}
export type Types = Record<string, Field[]>;
export interface TypedData {
  types: Types;
  primaryType: string;
  domain: Record<string, unknown>;
  message: Record<string, unknown>;
}

const enc = new TextEncoder();

function cat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

export function toHex(u8: Uint8Array): string {
  let s = '0x';
  for (const b of u8) s += b.toString(16).padStart(2, '0');
  return s;
}

export function fromHex(value: string): Uint8Array {
  const h = String(value).replace(/^0x/, '');
  const out = new Uint8Array(h.length >> 1);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.substr(i * 2, 2), 16);
  return out;
}

/** A 32-byte big-endian word. Negative numbers never appear in these documents. */
function word(value: unknown): Uint8Array {
  let v = BigInt(value as string | number | bigint);
  if (v < 0n) throw new Error('eip712: negative integers are not used here');
  const out = new Uint8Array(32);
  for (let i = 31; i >= 0 && v > 0n; i--) {
    out[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return out;
}

function collect(types: Types, name: string, found: Set<string>): Set<string> {
  if (found.has(name) || !types[name]) return found;
  found.add(name);
  for (const f of types[name]) {
    const base = f.type.replace(/\[\d*\]$/, '');
    if (types[base]) collect(types, base, found);
  }
  return found;
}

/**
 * `Mail(Person from,Person to,string contents)Person(string name,address wallet)`
 *
 * Primary type first, then every struct type it reaches, sorted by name. The
 * sort is what makes this canonical: two implementations that disagree on
 * order produce different type hashes, and therefore signatures each one
 * thinks the other forged.
 */
export function encodeType(types: Types, primaryType: string): string {
  const referenced = [...collect(types, primaryType, new Set())]
    .filter((t) => t !== primaryType)
    .sort();
  return [primaryType, ...referenced]
    .map((t) => `${t}(${types[t].map((f) => `${f.type} ${f.name}`).join(',')})`)
    .join('');
}

export const typeHash = (types: Types, primaryType: string): Uint8Array =>
  keccak_256(enc.encode(encodeType(types, primaryType)));

function encodeValue(types: Types, type: string, value: unknown): Uint8Array {
  if (/\[\d*\]$/.test(type)) {
    const base = type.replace(/\[\d*\]$/, '');
    const items = (value as unknown[]) || [];
    return keccak_256(cat(...items.map((v) => encodeValue(types, base, v))));
  }
  if (types[type]) return hashStruct(types, type, value as Record<string, unknown>);
  if (type === 'string') return keccak_256(enc.encode(String(value ?? '')));
  if (type === 'bytes') {
    return keccak_256(typeof value === 'string' ? fromHex(value) : (value as Uint8Array));
  }
  if (type === 'address') {
    const out = new Uint8Array(32);
    out.set(fromHex(String(value)), 12);
    return out;
  }
  if (type === 'bool') return word(value ? 1 : 0);
  if (type.startsWith('bytes')) {
    const out = new Uint8Array(32);
    out.set(fromHex(String(value)), 0);
    return out;
  }
  if (type.startsWith('uint') || type.startsWith('int')) return word(value);
  throw new Error(`eip712: unsupported type ${type}`);
}

export function hashStruct(
  types: Types,
  primaryType: string,
  value: Record<string, unknown>,
): Uint8Array {
  const parts = [typeHash(types, primaryType)];
  for (const f of types[primaryType]) parts.push(encodeValue(types, f.type, value[f.name]));
  return keccak_256(cat(...parts));
}

/** The 32 bytes an EIP-712 signature is made over. */
export function digest(typed: TypedData): Uint8Array {
  return keccak_256(
    cat(
      Uint8Array.from([0x19, 0x01]),
      hashStruct(typed.types, 'EIP712Domain', typed.domain),
      hashStruct(typed.types, typed.primaryType, typed.message),
    ),
  );
}

/* The domain's fields, in the order EIP-712 lists them. A caller names the
   domain it has; the type is derived from it, never supplied, so no document
   can describe a domain other than the one it carries. */
const DOMAIN_FIELDS: Field[] = [
  { name: 'name', type: 'string' },
  { name: 'version', type: 'string' },
  { name: 'chainId', type: 'uint256' },
  { name: 'verifyingContract', type: 'address' },
  { name: 'salt', type: 'bytes32' },
];

/**
 * The digest of a typed document from its parts, for a venue that signs
 * ordinary EIP-712 (Aster, perps/aster.ts). Hyperliquid's L1 actions keep
 * their own road in l1action.ts; this is for the standard's own shape.
 *
 * The encoder proves itself first, every time: see [assertTrustworthy].
 */
export function typedDigest(
  domain: Record<string, unknown>,
  types: Types,
  primaryType: string,
  message: Record<string, unknown>,
): Uint8Array {
  assertTrustworthy();
  if (types.EIP712Domain) throw new Error('eip712: the domain type is derived from the domain, not supplied');
  if (!types[primaryType]) throw new Error(`eip712: unknown primary type ${primaryType}`);
  const EIP712Domain = DOMAIN_FIELDS.filter((f) => domain[f.name] !== undefined);
  if (!EIP712Domain.length) throw new Error('eip712: a domain needs at least one field');
  return digest({ types: { EIP712Domain, ...types }, primaryType, domain, message });
}

/* ---- proof, not confidence ---------------------------------------------- */

/** The worked example from EIP-712, with the hashes the standard publishes. */
const SPEC: TypedData = {
  types: {
    EIP712Domain: [
      { name: 'name', type: 'string' },
      { name: 'version', type: 'string' },
      { name: 'chainId', type: 'uint256' },
      { name: 'verifyingContract', type: 'address' },
    ],
    Person: [
      { name: 'name', type: 'string' },
      { name: 'wallet', type: 'address' },
    ],
    Mail: [
      { name: 'from', type: 'Person' },
      { name: 'to', type: 'Person' },
      { name: 'contents', type: 'string' },
    ],
  },
  primaryType: 'Mail',
  domain: {
    name: 'Ether Mail',
    version: '1',
    chainId: 1,
    verifyingContract: '0xCcCCccccCCCCcCCCCCCcCcCccCcCCCcCcccccccC',
  },
  message: {
    from: { name: 'Cow', wallet: '0xCD2a3d9F938E13CD947Ec05AbC7FE734Df8DD826' },
    to: { name: 'Bob', wallet: '0xbBbBBBBbbBBBbbbBbbBbbbbBBbBbbbbBbBbbBBbB' },
    contents: 'Hello, Bob!',
  },
};
const SPEC_TYPE = 'Mail(Person from,Person to,string contents)Person(string name,address wallet)';
const SPEC_DIGEST = '0xbe609aee343fb3c4b28e1df9e632fca64fcfaede20f02e86244efddf30957bd2';

let proven: boolean | null = null;

/**
 * Refuse to be used unless this encoder can reproduce the standard's own hash.
 *
 * Called before every signature rather than once at import: the cost is one
 * keccak over a fixed document, and the alternative is trusting a result
 * computed by code nobody has checked on this device, in this browser, with
 * this build of its dependencies.
 */
export function assertTrustworthy(): void {
  if (proven === true) return;
  if (proven === false) throw new Error('eip712: encoder failed its own check');
  const okType = encodeType(SPEC.types, 'Mail') === SPEC_TYPE;
  const okDigest = toHex(digest(SPEC)) === SPEC_DIGEST;
  proven = okType && okDigest;
  if (!proven) {
    throw new Error(
      'eip712: this encoder cannot reproduce the EIP-712 specification example, '
        + 'so nothing it produces may be signed',
    );
  }
}
