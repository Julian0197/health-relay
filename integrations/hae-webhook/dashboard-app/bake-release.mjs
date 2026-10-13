#!/usr/bin/env node
// Bake the publish copy of the dashboard HTML box.
//
//   node bake-release.mjs \
//     --base "$DISPLAY_BASE_TOKEN" --table "$DISPLAY_TABLE_ID" \
//     --record "$DISPLAY_RECORD_ID" --init-code-file /absolute/private/magic-init-code \
//     --out /absolute/private/dashboard.deploy.html
//
// The repo source stays placeholder-only: Base IDs and the Miaobi-issued init code
// live in this machine's env/files, never in Git. The script fails loudly on any
// leftover placeholder or malformed id.
import { readFileSync, writeFileSync, realpathSync, lstatSync, mkdtempSync, renameSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { basename, dirname, join, resolve } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { safeReopenUrl } from './src/config.mjs';

const args = Object.fromEntries(process.argv.slice(2).flatMap((a, i, arr) =>
  a.startsWith('--') ? [[a.slice(2), arr[i + 1] && !arr[i + 1].startsWith('--') ? arr[i + 1] : true]] : []));

const required = ['base', 'table', 'record', 'init-code-file', 'out'];
for (const k of required) if (!args[k]) { console.error(`missing --${k}`); process.exit(2); }
const reopenUrl = args['reopen-url'] === undefined ? '' : safeReopenUrl(args['reopen-url']);
if (reopenUrl === null) { console.error('--reopen-url must be an HTTPS URL without credentials'); process.exit(2); }

const here = dirname(fileURLToPath(import.meta.url));
let html = readFileSync(args.input ? resolve(args.input) : join(here, 'dist/dashboard.html'), 'utf8');
const initCode = readFileSync(args['init-code-file'], 'utf8').trim();

const checks = [
  [/^[A-Za-z0-9]{20,}$/, args.base, 'base token'],
  [/^tbl[A-Za-z0-9]{10,}$/, args.table, 'table id'],
  [/^rec[A-Za-z0-9]{10,}$/, args.record, 'record id'],
  [/^[\w/:+\-=.]{30,}$/, initCode, 'init code'],
];
for (const [re, value, label] of checks) {
  if (!re.test(value)) { console.error(`configuration invalid: ${label}`); process.exit(2); }
}

// Feishu record ids have variable length, so a typo like a dropped trailing char passes
// shape validation. Verify the record actually exists in the target table before baking.
if (!args['no-verify']) {
  const cli = args['lark-cli'] || 'lark-cli';
  let listing;
  try {
    listing = execFileSync(cli, [
      'base', '+record-get', '--base-token', args.base, '--table-id', args.table,
      '--record-id', args.record, '--format', 'json', '--as', 'user',
    ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch {
    console.error('record verification failed: cli_error');
    process.exit(2);
  }
  let response;
  try { response = JSON.parse(listing); }
  catch { console.error('record verification failed: invalid_json'); process.exit(2); }
  const ids = response?.data?.record_id_list;
  if (!Array.isArray(ids)) {
    console.error('record verification failed: invalid_response');
    process.exit(2);
  }
  if (!ids.includes(args.record)) {
    console.error('record verification failed: record_not_found');
    process.exit(2);
  }
}

const anchor = "const MAGIC_INIT_CODE = '__UNBAKED_MAGIC_INIT__';";
if (!html.includes(anchor)) { console.error('init-code anchor not found in source'); process.exit(2); }
html = html.split(anchor).join(`const MAGIC_INIT_CODE = ${JSON.stringify(initCode)};`);
const reopenAnchor = "'__REOPEN_URL__'";
if (!html.includes(reopenAnchor)) { console.error('reopen URL anchor not found in source'); process.exit(2); }
html = html.replace(reopenAnchor, () => JSON.stringify(reopenUrl).replace(/</g, '\\u003c'));

for (const [placeholder, value] of [
  ['__BASE_APP_TOKEN__', args.base],
  ['__BASE_TABLE_ID__', args.table],
  ['__BASE_RECORD_ID__', args.record],
]) {
  if (!html.includes(placeholder)) { console.error(`placeholder missing: ${placeholder}`); process.exit(2); }
  html = html.split(placeholder).join(value);
}

// The sentinel must survive exactly once: the runtime gate compares against it,
// and a second leftover would mean the anchor replacement misfired.
const packed = html.match(/<script id="dashboard-bundle" type="application\/gzip">([A-Za-z0-9+/=]+)<\/script>/);
const runtime = packed ? gunzipSync(Buffer.from(packed[1], 'base64')).toString('utf8') : '';
const sentinelCount = ((html + runtime).match(/__UNBAKED_MAGIC_INIT__/g) ?? []).length;
if (sentinelCount !== 1) { console.error(`expected sentinel once, got ${sentinelCount}`); process.exit(2); }
if (html.includes('__BASE_APP_TOKEN__') || html.includes('__BASE_TABLE_ID__') || html.includes('__BASE_RECORD_ID__')) {
  console.error('a Base placeholder survived substitution'); process.exit(2);
}
// Check the real parent so a directory alias cannot bypass the Git boundary.
const requested = resolve(args.out);
const output = join(realpathSync(dirname(requested)), basename(requested));
if (lstatSync(output, { throwIfNoEntry: false })?.isSymbolicLink()) {
  console.error('baked output must not be a symlink'); process.exit(2);
}
// Baked output carries a capability: only permit paths outside Git or explicitly ignored.
let gitRoot;
try { gitRoot = execFileSync('git', ['-C', dirname(output), 'rev-parse', '--show-toplevel'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch {}
if (gitRoot) {
  try { execFileSync('git', ['-C', gitRoot, 'check-ignore', '--quiet', '--', output], { stdio: 'ignore' }); }
  catch { console.error('baked output must be outside Git or in an ignored directory'); process.exit(2); }
}
// Rename a private file into place instead of following or truncating an existing link.
const staging = mkdtempSync(join(dirname(output), '.dashboard-bake-'));
try {
  const file = join(staging, 'dashboard.html');
  writeFileSync(file, html, { mode: 0o600 });
  renameSync(file, output);
} finally {
  rmSync(staging, { recursive: true, force: true });
}
console.log(`baked ${args.out}: ${Buffer.byteLength(html)} bytes`);
