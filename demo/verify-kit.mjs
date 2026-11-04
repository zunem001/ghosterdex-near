/**
 * Proves the kit in this repository is the kit GhosterDex serves: it compares the build you just made
 * with the versioned file on ghosterdex.com, byte for byte. Versioned files never change.
 *
 *   npm run build:kit
 *   npm run verify:kit
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

const sha = (b) => createHash('sha256').update(b).digest('hex');
const version = /KIT_VERSION = '([^']+)'/.exec(readFileSync('agent/kit/client.ts', 'utf8'))[1];
const built = readFileSync('public/agent/gdx.mjs');
const url = `https://ghosterdex.com/agent/gdx-${version}.mjs`;
const res = await fetch(url);
if (!res.ok) throw new Error(`${url} answered ${res.status}`);
const live = Buffer.from(await res.arrayBuffer());

console.log(`built here   ${sha(built)}  ${built.length} bytes`);
console.log(`${url}\nserved       ${sha(live)}  ${live.length} bytes`);
if (!built.equals(live)) {
  console.error('\nDIFFERENT. Run npm ci first, on the commit that set this version.');
  process.exit(1);
}
console.log('\nSAME BYTES: the file agents download is built from this source.');
