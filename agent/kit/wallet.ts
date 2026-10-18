/**
 * The agent's own wallet: one recovery phrase, held on this machine only.
 *
 * GhosterDex never sees it. The phrase derives a single Ed25519 key, and that
 * key is everything: it proves who the agent is, it signs every private move
 * of the vault, and it owns the public Gram wallet (Wallet v5, the same
 * contract the phone makes). The phrase is a standard 24 word TON phrase, so
 * the owner can import it into GhosterDex on a phone and see the same money.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
/* Deep imports: the packages' front doors also load an HTTP client and a
   schema library the kit never uses, which tripled the file. */
import { mnemonicToPrivateKey, mnemonicValidate } from '@ton/crypto/dist/mnemonic/mnemonic';
import { wordlist as mnemonicWordList } from '@ton/crypto/dist/mnemonic/wordlist';
import { WalletContractV5R1 } from '@ton/ton/dist/wallets/v5r1/WalletContractV5R1';
import { WalletContractV4 } from '@ton/ton/dist/wallets/WalletContractV4';
import { strongBytes } from './entropy';

export type Keystore = {
  v: 1;
  kind: 'ghosterdex-agent';
  name: string;
  created: string;
  mnemonic: string;
  publicKey: string;
  /** raw form, 0:<64 hex>, the form the worker compares */
  address: string;
  /** user-friendly, non-bounceable: what people paste to send Gram */
  friendly: string;
  version: 'v5r1';
  /** the device id header every GhosterDex client sends */
  uid: string;
  server: string;
  session?: { token: string; exp: number };
  /**
   * The owner key pinned at pairing: only devices it approved get a sealed
   * copy (seal.ts), and only its wallets act for the Gram wallet. `via` says
   * how it was set: 'pair' by an explicit pairing on this machine, 'first' at
   * first sight of an owner paired before the kit pinned (seal.ts pinOwner).
   */
  owner?: { key: string; pinnedAt: string; via?: 'pair' | 'first' };
  /**
   * The owner wallets this kit made extensions of its Gram wallet
   * (keepOwnerControl), each with the pinned key it was derived from. The
   * kit only ever manages these, never an extension it did not add.
   */
  ownerExt?: Array<{ key: string; address: string; at: string }>;
};

export type Keys = { publicKey: Buffer; secretKey: Buffer };

export const DEFAULT_SERVER = 'https://ghosterdex.com';

export function homeDir(): string {
  return process.env.GHOSTERDEX_HOME || join(homedir(), '.ghosterdex');
}

export function keystorePath(): string {
  return join(homeDir(), 'wallet.json');
}

function ensureHome(): string {
  const dir = homeDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    chmodSync(dir, 0o700);
  } catch {
    /* Windows keeps its own ACLs */
  }
  return dir;
}

export function hasKeystore(): boolean {
  return existsSync(keystorePath());
}

export function loadKeystore(): Keystore {
  const file = keystorePath();
  if (!existsSync(file)) {
    throw new Error(`No GhosterDex wallet on this machine yet. Run: gdx init --name "<your name>"`);
  }
  const ks = JSON.parse(readFileSync(file, 'utf8')) as Keystore;
  if (ks.kind !== 'ghosterdex-agent' || !ks.mnemonic) throw new Error(`${file} is not a GhosterDex agent wallet.`);
  return ks;
}

/**
 * What this machine has come to trust, carried over from the file on disk.
 * Several kit processes share wallet.json (a long-running MCP server beside
 * one-off commands), each saving the copy it loaded. Without this, a process
 * that loaded the file before the owner key was pinned would save it back
 * unpinned, and the next command would pin again at first sight, reopening
 * the window pairing closed. The later pin wins; recorded controls add up.
 */
export function keepTrust(ks: Keystore, disk: Keystore | null): void {
  if (!disk || disk.publicKey !== ks.publicKey) return;
  const at = (o?: { pinnedAt?: string }) => Date.parse(o?.pinnedAt || '') || 0;
  if (disk.owner && at(disk.owner) > at(ks.owner)) ks.owner = disk.owner;
  const ext = [...(ks.ownerExt || [])];
  for (const e of disk.ownerExt || []) if (!ext.some((x) => x.key === e.key && x.address === e.address)) ext.push(e);
  if (ext.length) ks.ownerExt = ext;
}

/**
 * This process's copy brought up to what the file trusts now. Called before
 * any decision that trust feeds: a copy loaded before the owner was pinned
 * must never pin again at first sight while the file already holds a pin.
 */
export function refreshTrust(ks: Keystore): void {
  try {
    const file = keystorePath();
    keepTrust(ks, existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as Keystore) : null);
  } catch {
    /* an unreadable file has nothing to add */
  }
}

/** Atomic write: a crash mid-save must never leave half a key file. */
export function saveKeystore(ks: Keystore): void {
  ensureHome();
  const file = keystorePath();
  refreshTrust(ks);
  const tmp = file + '.tmp';
  writeFileSync(tmp, JSON.stringify(ks, null, 2), { mode: 0o600 });
  renameSync(tmp, file);
  try {
    chmodSync(file, 0o600);
  } catch {
    /* Windows */
  }
}

/**
 * A fresh 24 word phrase from checked randomness.
 *
 * TON phrases are not BIP39: any 24 words qualify only if their PBKDF2 check
 * byte is zero (about one draw in 256), so draws repeat until one does, exactly
 * as tonlib's own generator does, with every draw from the guarded source.
 */
async function newMnemonic(): Promise<string[]> {
  const words = mnemonicWordList;
  for (let attempt = 0; attempt < 20000; attempt++) {
    const bytes = strongBytes(48, ensureHome());
    const phrase: string[] = [];
    for (let i = 0; i < 24; i++) phrase.push(words[((bytes[i * 2] << 8) | bytes[i * 2 + 1]) & 2047]);
    if (await mnemonicValidate(phrase)) return phrase;
  }
  throw new Error('Could not make a recovery phrase. Try again.');
}

export function walletFor(publicKey: Buffer): WalletContractV5R1 {
  return WalletContractV5R1.create({ workchain: 0, publicKey });
}

/**
 * The two wallets an owner key can keep its Gram in, as GhosterDex makes
 * them, raw: W5 (mainnet, workchain 0, subwallet 0, the one new wallets get)
 * and v4R2 (wallet id 698983191, what some imported wallets are). The only
 * addresses the kit will ever let act for its Gram wallet, and it works them
 * out itself from the key it pinned: an address the server names counts only
 * when it is one of these.
 */
export function ownerGramWallets(ownerKeyHex: string): string[] {
  if (!/^[0-9a-f]{64}$/.test(ownerKeyHex)) return [];
  const publicKey = Buffer.from(ownerKeyHex, 'hex');
  return [
    WalletContractV5R1.create({ workchain: 0, publicKey }).address.toRawString(),
    WalletContractV4.create({ workchain: 0, publicKey }).address.toRawString(),
  ];
}

export async function keysOf(ks: Keystore): Promise<Keys> {
  const kp = await mnemonicToPrivateKey(ks.mnemonic.split(' '));
  if (kp.publicKey.toString('hex') !== ks.publicKey) {
    throw new Error('wallet.json does not match its own recovery phrase. It may have been edited.');
  }
  return kp;
}

export async function createKeystore(opts: { name: string; server: string; mnemonic?: string }): Promise<Keystore> {
  const phrase = opts.mnemonic ? opts.mnemonic.trim().toLowerCase().split(/\s+/) : await newMnemonic();
  if (phrase.length !== 24 || !(await mnemonicValidate(phrase))) {
    throw new Error('That is not a valid 24 word TON recovery phrase.');
  }
  const kp = await mnemonicToPrivateKey(phrase);
  const w = walletFor(kp.publicKey);
  return {
    v: 1,
    kind: 'ghosterdex-agent',
    name: opts.name,
    created: new Date().toISOString(),
    mnemonic: phrase.join(' '),
    publicKey: kp.publicKey.toString('hex'),
    address: w.address.toRawString(),
    friendly: w.address.toString({ bounceable: false, urlSafe: true }),
    version: 'v5r1',
    uid: randomUUID(),
    server: opts.server,
  };
}
