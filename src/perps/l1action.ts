/**
 * Hyperliquid L1 actions: msgpacked, hashed, and signed inside the Agent struct.
 *
 * This is the browser half of Msgpack.kt and HlAction.kt, and it has to produce
 * the same bytes those do, byte for byte. Not "equivalent", identical. The
 * venue hashes the msgpack encoding, so the encoding IS part of the signature:
 * a map written in a different key order, or an integer written one byte wider
 * than necessary, is still valid MessagePack, still decodes to the same value,
 * and still hashes to something the venue did not expect. The failure it
 * produces is not an error about encoding; it is a signature that recovers to
 * an address nobody recognises.
 *
 * Two rules follow, and both are enforced here rather than remembered:
 *
 *  - **Key order is load-bearing.** Maps are packed in insertion order. A plain
 *    object preserves string-key insertion order in JS, which is what makes
 *    this safe, but only for keys that are not integer-like, so integer-like
 *    keys are refused rather than silently reordered by the runtime.
 *  - **Integers take the shortest form.** Anything else hashes differently.
 *
 * Floats are deliberately unsupported, exactly as in the Kotlin encoder: the
 * venue takes prices and sizes as strings, and a float in a signed payload is a
 * rounding argument waiting to happen.
 */
import { keccak_256 } from '@noble/hashes/sha3';
import { digest as eip712Digest, toHex, type TypedData } from './eip712';

export const MAINNET_SOURCE = 'a';
export const TESTNET_SOURCE = 'b';

/** A value this encoder accepts. Deliberately narrow. */
export type Packable =
  | string
  | number
  | bigint
  | boolean
  | Packable[]
  | { [k: string]: Packable | undefined };

class Writer {
  private buf: number[] = [];

  byte(b: number): void {
    this.buf.push(b & 0xff);
  }

  bytes(b: Uint8Array): void {
    for (const x of b) this.buf.push(x);
  }

  /** Big-endian, `n` bytes wide. */
  be(v: bigint, n: number): void {
    for (let i = n - 1; i >= 0; i--) this.buf.push(Number((v >> BigInt(i * 8)) & 0xffn));
  }

  done(): Uint8Array {
    return Uint8Array.from(this.buf);
  }
}

const utf8 = new TextEncoder();
/** JS reorders integer-like own keys, which would silently change the hash. */
const INTEGER_KEY = /^(0|[1-9]\d*)$/;

function writeString(w: Writer, s: string): void {
  const b = utf8.encode(s);
  if (b.length < 32) w.byte(0xa0 | b.length);
  else if (b.length < 256) {
    w.byte(0xd9);
    w.byte(b.length);
  } else if (b.length < 65536) {
    w.byte(0xda);
    w.be(BigInt(b.length), 2);
  } else throw new Error('msgpack: string too long for anything this signs');
  w.bytes(b);
}

function writeInt(w: Writer, value: bigint): void {
  if (value >= 0n) {
    if (value < 128n) w.byte(Number(value));
    else if (value < 256n) {
      w.byte(0xcc);
      w.byte(Number(value));
    } else if (value < 65536n) {
      w.byte(0xcd);
      w.be(value, 2);
    } else if (value < 4294967296n) {
      w.byte(0xce);
      w.be(value, 4);
    } else {
      w.byte(0xcf);
      w.be(value, 8);
    }
  } else if (value >= -32n) w.byte(Number(value) & 0xff);
  else if (value >= -128n) {
    w.byte(0xd0);
    w.byte(Number(value) & 0xff);
  } else if (value >= -32768n) {
    w.byte(0xd1);
    w.be(value & 0xffffn, 2);
  } else if (value >= -2147483648n) {
    w.byte(0xd2);
    w.be(value & 0xffffffffn, 4);
  } else {
    w.byte(0xd3);
    w.be(value & 0xffffffffffffffffn, 8);
  }
}

function write(w: Writer, value: unknown): void {
  if (typeof value === 'boolean') return w.byte(value ? 0xc3 : 0xc2);
  if (typeof value === 'string') return writeString(w, value);
  if (typeof value === 'bigint') return writeInt(w, value);
  if (typeof value === 'number') {
    if (!Number.isInteger(value)) {
      throw new Error(
        `msgpack: refusing to pack the float ${value}. The venue takes numbers `
          + 'as strings, and a float here would be a rounding argument in a signature.',
      );
    }
    return writeInt(w, BigInt(value));
  }
  if (Array.isArray(value)) {
    if (value.length < 16) w.byte(0x90 | value.length);
    else if (value.length < 65536) {
      w.byte(0xdc);
      w.be(BigInt(value.length), 2);
    } else throw new Error('msgpack: array too long');
    for (const item of value) write(w, item);
    return;
  }
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined);
    for (const [k] of entries) {
      if (INTEGER_KEY.test(k)) {
        throw new Error(
          `msgpack: refusing the integer-like key "${k}". JavaScript enumerates `
            + 'those before string keys, so the packed order would not be the '
            + 'order written, and the hash would not be the one signed.',
        );
      }
    }
    if (entries.length < 16) w.byte(0x80 | entries.length);
    else if (entries.length < 65536) {
      w.byte(0xde);
      w.be(BigInt(entries.length), 2);
    } else throw new Error('msgpack: map too large');
    for (const [k, v] of entries) {
      writeString(w, k);
      write(w, v);
    }
    return;
  }
  throw new Error(`msgpack: unsupported type ${value === null ? 'null' : typeof value}`);
}

export function pack(value: Packable): Uint8Array {
  assertPackerTrustworthy();
  const w = new Writer();
  write(w, value);
  return w.done();
}

/**
 * The connection id: the packed action, the nonce, and the vault flag.
 *
 * Mirrors HlAction.actionHash. The trailing 0x00 is not padding, it is the
 * "no vault" discriminator, and omitting it hashes to something else entirely.
 */
export function actionHash(action: Packable, nonce: bigint, vault?: Uint8Array): Uint8Array {
  const w = new Writer();
  w.bytes(pack(action));
  w.be(nonce, 8);
  if (!vault) w.byte(0x00);
  else {
    if (vault.length !== 20) throw new Error('a vault address is 20 bytes');
    w.byte(0x01);
    w.bytes(vault);
  }
  return keccak_256(w.done());
}

/**
 * The EIP-712 document the venue actually checks.
 *
 * chainId 1337 and a zero verifying contract are not placeholders: they are the
 * venue's real Agent domain. Changing either produces a perfectly valid
 * signature over a domain nobody asked about, which is refused without
 * explanation.
 */
export function agentTypedData(connectionId: Uint8Array, source: string): TypedData {
  if (connectionId.length !== 32) throw new Error('connectionId is a bytes32');
  return {
    types: {
      EIP712Domain: [
        { name: 'name', type: 'string' },
        { name: 'version', type: 'string' },
        { name: 'chainId', type: 'uint256' },
        { name: 'verifyingContract', type: 'address' },
      ],
      Agent: [
        { name: 'source', type: 'string' },
        { name: 'connectionId', type: 'bytes32' },
      ],
    },
    primaryType: 'Agent',
    domain: {
      name: 'Exchange',
      version: '1',
      chainId: 1337,
      verifyingContract: '0x0000000000000000000000000000000000000000',
    },
    message: { source, connectionId: toHex(connectionId) },
  };
}

/** The 32 bytes to sign for an L1 action, in one step. */
export function digestFor(
  action: Packable,
  nonce: bigint,
  opts: { vault?: Uint8Array; testnet?: boolean } = {},
): Uint8Array {
  return eip712Digest(
    agentTypedData(actionHash(action, nonce, opts.vault), opts.testnet ? TESTNET_SOURCE : MAINNET_SOURCE),
  );
}

/* ---- proof, not confidence ---------------------------------------------- */

/**
 * MessagePack's own canonical encodings, from its specification.
 *
 * Every one of these is a shape a Hyperliquid action actually contains, and
 * each is chosen at a boundary where a wrong encoder still looks right: 127
 * versus 128 is where fixint ends, 255 versus 256 is where uint8 ends, and a
 * 31-versus-32 byte string is where fixstr ends. An encoder that is one byte
 * wide at any of those signs a hash the venue never computes.
 */
const VECTORS: Array<[Packable, string]> = [
  [true, 'c3'],
  [false, 'c2'],
  [0, '00'],
  [127, '7f'],
  [128, 'cc80'],
  [255, 'ccff'],
  [256, 'cd0100'],
  [65535, 'cdffff'],
  [65536, 'ce00010000'],
  [4294967295, 'ceffffffff'],
  [4294967296n, 'cf0000000100000000'],
  [-1, 'ff'],
  [-32, 'e0'],
  [-33, 'd0df'],
  ['', 'a0'],
  ['a', 'a161'],
  ['a'.repeat(31), 'bf' + '61'.repeat(31)],
  ['a'.repeat(32), 'd920' + '61'.repeat(32)],
  [[], '90'],
  [[1, 2, 3], '930102 03'.replace(/ /g, '')],
  [{}, '80'],
  [{ a: 1 }, '81a16101'],
  // Insertion order, not alphabetical: this is the property the venue depends on.
  [{ b: 1, a: 2 }, '82a16201a16102'],
];

let packerProven: boolean | null = null;

function hexOf(u8: Uint8Array): string {
  let s = '';
  for (const b of u8) s += b.toString(16).padStart(2, '0');
  return s;
}

/**
 * Refuse to pack anything unless this encoder reproduces MessagePack's own
 * canonical bytes. Cheap, and the alternative is discovering a one-byte
 * disagreement as a rejected order against real margin.
 */
export function assertPackerTrustworthy(): void {
  if (packerProven === true) return;
  if (packerProven === false) throw new Error('msgpack: encoder failed its own check');
  for (const [value, expected] of VECTORS) {
    const w = new Writer();
    write(w, value);
    if (hexOf(w.done()) !== expected) {
      packerProven = false;
      throw new Error(
        `msgpack: this encoder does not produce the specification's bytes for `
          + `${JSON.stringify(value, (_k, v) => (typeof v === 'bigint' ? String(v) : v))}, `
          + 'so nothing it packs may be signed',
      );
    }
  }
  packerProven = true;
}
