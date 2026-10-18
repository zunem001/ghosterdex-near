/**
 * Builds the agent kit and the pages agents read.
 *
 *   node agent/build.mjs
 *
 * public/agent/gdx.mjs            the kit, one file, Node 18+, no install
 * public/agent/gdx-<version>.mjs  the same bytes under a name that never changes
 * public/agent.md, skill.md       the instructions an agent follows
 * public/llms.txt                 the short index machine readers look for
 *
 * The kit's SHA-256 is written into agent.md, so an agent (or its human) can
 * check the file it downloaded is the file this build made.
 */
import { build } from 'esbuild';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(root, 'public', 'agent');
mkdirSync(outDir, { recursive: true });

const version = /KIT_VERSION = '([^']+)'/.exec(readFileSync(join(root, 'agent/kit/client.ts'), 'utf8'))[1];

const result = await build({
  entryPoints: [join(root, 'agent/kit/main.ts')],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node18',
  write: false,
  minify: false,
  legalComments: 'eof',
  logLevel: 'warning',
  banner: {
    js: [
      '#!/usr/bin/env node',
      `// GhosterDex agent kit ${version}. https://ghosterdex.com/agent.md`,
      '// Your key is made and kept on this machine (~/.ghosterdex/wallet.json). GhosterDex never sees it.',
      'import { createRequire as __gdxRequire } from "node:module"; const require = __gdxRequire(import.meta.url);',
    ].join('\n'),
  },
});

/* LF everywhere: a CRLF build would hash differently on every checkout */
const code = Buffer.from(result.outputFiles[0].text.replace(/\r\n/g, '\n'), 'utf8');
const sha = createHash('sha256').update(code).digest('hex');
writeFileSync(join(outDir, 'gdx.mjs'), code);
writeFileSync(join(outDir, `gdx-${version}.mjs`), code);
writeFileSync(join(outDir, 'gdx.mjs.sha256'), `${sha}  gdx.mjs\n`);

const fill = (s) =>
  s
    .replaceAll('{{VERSION}}', version)
    .replaceAll('{{SHA256}}', sha)
    .replaceAll('{{KB}}', String(Math.round(code.length / 1024)));
const doc = fill(readFileSync(join(root, 'agent/agent.md'), 'utf8')).replace(/\r\n/g, '\n');
writeFileSync(join(root, 'public', 'agent.md'), doc);
writeFileSync(join(root, 'public', 'skill.md'), doc);
writeFileSync(join(root, 'public', 'llms.txt'), fill(readFileSync(join(root, 'agent/llms.txt'), 'utf8')).replace(/\r\n/g, '\n'));

if (/\u2014/.test(doc)) throw new Error('agent.md carries an em dash; rewrite the sentence.');
console.log(`gdx ${version}: ${Math.round(code.length / 1024)} KB, sha256 ${sha}`);
