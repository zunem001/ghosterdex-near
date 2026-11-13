/**
 * An EVM transaction, built and signed here: EIP-1559 (type 2), RLP, keccak,
 * secp256k1. For the browser-held trading key, which until now could sign
 * Hyperliquid's documents and Aster's requests but no transaction, while the
 * Android plugin always could (signEvmTransaction). Aster is funded on chain,
 * by a transfer from the trading address to Aster's vault contract, so the
 * browser's key needs the same door.
 *
 * Hand-rolled on @noble like the rest of this folder (no ethers, no viem in
 * the bundle). scripts/check-evmtx.mts holds it to ethers' own serialization
 * and recovers the signer, so a byte out of place fails there and not on
 * chain.
 */
import * as secp from '@noble/secp256k1';
import { hmac } from '@noble/hashes/hmac';
import { sha256 } from '@noble/hashes/sha256';
import { keccak_256 } from '@noble/hashes/sha3';
import { fromHex, toHex } from './eip712';

secp.etc.hmacSha256Sync = (k: Uint8Array, ...m: Uint8Array[]) =>
  hmac(sha256, k, secp.etc.concatBytes(...m));

export interface EvmTx {
  chainId: number | string;
  nonce: number | string;
  maxPriorityFeePerGas: number | string | bigint;
  maxFeePerGas: number | string | bigint;
  gasLimit: number | string | bigint;
  to: string;
  value: number | string | bigint;
  data?: string;
}

function cat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/** A non-negative integer as RLP's minimal big-endian bytes; zero is empty. */
export function intBytes(v: number | string | bigint): Uint8Array {
  const n = BigInt(v);
  if (n < 0n) throw new Error('evmtx: negative integers are not used here');
  if (n === 0n) return new Uint8Array(0);
  let h = n.toString(16);
  if (h.length % 2) h = '0' + h;
  return fromHex(h);
}

function lengthPrefix(len: number, offset: number): Uint8Array {
  if (len < 56) return Uint8Array.from([offset + len]);
  const lb = intBytes(len);
  return cat(Uint8Array.from([offset + 55 + lb.length]), lb);
}

export type RlpItem = Uint8Array | RlpItem[];

/** RLP, the two rules: a byte string, or a list of items. */
export function rlp(item: RlpItem): Uint8Array {
  if (item instanceof Uint8Array) {
    if (item.length === 1 && item[0] < 0x80) return item;
    return cat(lengthPrefix(item.length, 0x80), item);
  }
  const body = cat(...item.map(rlp));
  return cat(lengthPrefix(body.length, 0xc0), body);
}

function addressBytes(a: string): Uint8Array {
  if (!/^0x[0-9a-fA-F]{40}$/.test(a)) throw new Error('evmtx: that is not an address');
  return fromHex(a);
}

function dataBytes(d?: string): Uint8Array {
  if (!d || d === '0x') return new Uint8Array(0);
  if (!/^0x([0-9a-fA-F]{2})*$/.test(d)) throw new Error('evmtx: data is not even hex');
  return fromHex(d);
}

/** The fields of an EIP-1559 transaction, in the order the type signs them. */
function fields(tx: EvmTx): RlpItem[] {
  return [
    intBytes(tx.chainId),
    intBytes(tx.nonce),
    intBytes(tx.maxPriorityFeePerGas),
    intBytes(tx.maxFeePerGas),
    intBytes(tx.gasLimit),
    addressBytes(tx.to),
    intBytes(tx.value),
    dataBytes(tx.data),
    [], // access list: none
  ];
}

/** keccak(0x02 || rlp(fields)): what the key signs. */
export function signingHash(tx: EvmTx): Uint8Array {
  return keccak_256(cat(Uint8Array.from([0x02]), rlp(fields(tx))));
}

/** The signed transaction as the hex `eth_sendRawTransaction` takes. */
export function signEvmTx(tx: EvmTx, priv: Uint8Array): string {
  const sig = secp.sign(signingHash(tx), priv, { lowS: true });
  const signed = rlp([
    ...fields(tx),
    intBytes(sig.recovery), // y parity, 0 or 1
    /* integers: RLP gives them no leading zero, so r and s are as long as their values */
    intBytes(sig.r),
    intBytes(sig.s),
  ]);
  return toHex(cat(Uint8Array.from([0x02]), signed));
}

/** The address a private key spends from. */
export function evmAddress(priv: Uint8Array): string {
  const pub = secp.getPublicKey(priv, false).slice(1);
  return '0x' + toHex(keccak_256(pub)).slice(-40);
}

/** ERC-20 `transfer(address,uint256)` calldata. */
export function erc20Transfer(to: string, amount: bigint): string {
  if (amount < 0n) throw new Error('evmtx: a transfer cannot be negative');
  const dest = addressBytes(to);
  return '0xa9059cbb' + toHex(dest).slice(2).padStart(64, '0') + amount.toString(16).padStart(64, '0');
}

/** ERC-20 `balanceOf(address)` calldata, for a read. */
export function erc20BalanceOf(owner: string): string {
  return '0x70a08231' + toHex(addressBytes(owner)).slice(2).padStart(64, '0');
}
