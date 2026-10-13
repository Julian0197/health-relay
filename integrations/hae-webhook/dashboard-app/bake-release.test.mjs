import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, statSync, lstatSync, symlinkSync, linkSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import vm from 'node:vm';
import { buildDashboard } from './build.mjs';
const script = new URL('./bake-release.mjs', import.meta.url);
const initCode = 'synthetic_init_code_for_testing_only_123456789';
const ids = { base: 'ABCDEFGHIJKLMNOPQRSTUVWX', table: 'tbl12345678901', record: 'rec12345678901' };
const source = (await buildDashboard({ write: false })).html;

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'dashboard-bake-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const input = join(dir, 'input.html'), code = join(dir, 'init'), cli = join(dir, 'synthetic-cli');
  writeFileSync(input, source);
  writeFileSync(code, initCode);
  writeFileSync(cli, `#!${process.execPath}\nif (!process.argv.includes('+record-get') || !process.argv.includes('--record-id')) process.exit(1);\nprocess.stdout.write(JSON.stringify({ok:true,data:{record_id_list:['${ids.record}']}}));\n`, { mode: 0o700 });
  const args = [script.pathname, '--input', input, '--base', ids.base, '--table', ids.table, '--record', ids.record, '--init-code-file', code, '--lark-cli', cli];
  return { dir, cli, code, run: (out, extra = []) => spawnSync(process.execPath, [...args, '--out', out, ...extra], { encoding: 'utf8' }) };
}

function bakedConfig(out) {
  const html = readFileSync(out, 'utf8');
  const context = { window: {} };
  vm.runInNewContext(html.match(/<script>([\s\S]*?)<\/script>/)[1], context);
  return context.window.__HEALTH_DASHBOARD_CONFIG__;
}

function privateFailure(result, out, message, sensitive = []) {
  assert.equal(result.status, 2);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, `${message}\n`);
  for (const value of [initCode, ...Object.values(ids), ...sensitive]) {
    assert.ok(!(result.stdout + result.stderr).includes(value));
  }
  assert.doesNotMatch(result.stderr, /--no-verify/);
  assert.equal(existsSync(out), false);
}

for (const [arg, label] of [['base', 'base token'], ['table', 'table id'], ['record', 'record id']]) {
  test(`bake reports malformed ${arg} without logging its value`, t => {
    const { dir, run } = fixture(t), out = join(dir, 'release.html');
    const value = `synthetic_private_${arg}!`;
    privateFailure(run(out, [`--${arg}`, value]), out, `configuration invalid: ${label}`, [value]);
  });
}

test('bake reports malformed init capability without logging its contents', t => {
  const { dir, code, run } = fixture(t), out = join(dir, 'release.html');
  const value = 'synthetic_private_init_capability!';
  writeFileSync(code, value);
  privateFailure(run(out), out, 'configuration invalid: init code', [value]);
});

test('bake suppresses CLI stderr and thrown command details on verification failure', t => {
  const { dir, cli, run } = fixture(t), out = join(dir, 'release.html');
  const raw = `synthetic_private_cli_diagnostic ${initCode} ${Object.values(ids).join(' ')}`;
  writeFileSync(cli, `#!${process.execPath}\nprocess.stdout.write(${JSON.stringify(raw)});\nthrow new Error(${JSON.stringify(raw)});\n`);
  privateFailure(run(out), out, 'record verification failed: cli_error', [raw, cli]);
});

test('bake suppresses missing executable command details on verification failure', t => {
  const { dir, run } = fixture(t), out = join(dir, 'release.html');
  const missing = join(dir, `missing-${ids.base}`);
  privateFailure(run(out, ['--lark-cli', missing]), out, 'record verification failed: cli_error', [missing]);
});

test('bake reports malformed JSON without logging response content', t => {
  const { dir, cli, run } = fixture(t), out = join(dir, 'release.html');
  const raw = `synthetic_private_json ${initCode} ${Object.values(ids).join(' ')}`;
  writeFileSync(cli, `#!${process.execPath}\nprocess.stdout.write(${JSON.stringify(raw)});\n`);
  privateFailure(run(out), out, 'record verification failed: invalid_json', [raw]);
});

test('bake reports invalid response shape without logging response content', t => {
  const { dir, cli, run } = fixture(t), out = join(dir, 'release.html');
  const raw = { data: { record_id_list: { private: initCode, ...ids } } };
  writeFileSync(cli, `#!${process.execPath}\nprocess.stdout.write(${JSON.stringify(JSON.stringify(raw))});\n`);
  privateFailure(run(out), out, 'record verification failed: invalid_response');
});

test('bake reports missing record without logging requested or returned identifiers', t => {
  const { dir, cli, run } = fixture(t), out = join(dir, 'release.html');
  const otherRecord = 'recSyntheticOtherRecord12345';
  const raw = { data: { record_id_list: [otherRecord] }, private: initCode };
  writeFileSync(cli, `#!${process.execPath}\nprocess.stdout.write(${JSON.stringify(JSON.stringify(raw))});\n`);
  privateFailure(run(out), out, 'record verification failed: record_not_found', [otherRecord]);
});

test('bake verifies a synthetic record and writes mode 0600 without logging capabilities or resource IDs', t => {
  const { dir, run } = fixture(t), out = join(dir, 'release.html');
  writeFileSync(out, 'old release', { mode: 0o644 });
  const result = run(out);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(statSync(out).mode & 0o777, 0o600);
  const config = bakedConfig(out);
  assert.equal(config.initCode, initCode);
  for (const [key, value] of Object.entries(ids)) assert.equal(config[key], value);
  assert.equal(config.reopenUrl, '');
  for (const value of [initCode, ...Object.values(ids)]) assert.ok(!(result.stdout + result.stderr).includes(value));
});

test('bake accepts ignored output and rejects nonignored or tracked destinations without modifying them', t => {
  const { dir, run } = fixture(t), repo = join(dir, 'repo');
  mkdirSync(repo);
  execFileSync('git', ['init', '--quiet', repo]);
  writeFileSync(join(repo, '.gitignore'), '.private/\n');
  mkdirSync(join(repo, '.private'));
  const ignored = join(repo, '.private', 'release.html');
  const accepted = run(ignored);
  assert.equal(accepted.status, 0, accepted.stderr);
  assert.equal(statSync(ignored).mode & 0o777, 0o600);
  const tracked = join(repo, '.private', 'tracked.html'), nonignored = join(repo, 'release.html');
  writeFileSync(tracked, 'keep tracked');
  writeFileSync(nonignored, 'keep nonignored');
  execFileSync('git', ['-C', repo, 'add', '--force', '.private/tracked.html']);
  for (const out of [tracked, nonignored]) {
    const before = readFileSync(out, 'utf8'), rejected = run(out);
    assert.equal(rejected.status, 2);
    assert.match(rejected.stderr, /outside Git/);
    assert.equal(readFileSync(out, 'utf8'), before);
  }
});

test('bake refuses a symlink output outside Git without changing its tracked target', t => {
  const { dir, run } = fixture(t), repo = join(dir, 'repo');
  mkdirSync(repo);
  execFileSync('git', ['init', '--quiet', repo]);
  const target = join(repo, 'tracked.html'), out = join(dir, 'release.html');
  writeFileSync(target, 'keep tracked', { mode: 0o644 });
  execFileSync('git', ['-C', repo, 'add', 'tracked.html']);
  symlinkSync(target, out);
  const result = run(out);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /symlink/);
  assert.equal(readFileSync(target, 'utf8'), 'keep tracked');
  assert.equal(statSync(target).mode & 0o777, 0o644);
  assert.equal(lstatSync(out).isSymbolicLink(), true);
});

test('bake checks the canonical parent instead of accepting an ignored directory symlink to tracked data', t => {
  const { dir, run } = fixture(t), repo = join(dir, 'repo');
  mkdirSync(repo);
  execFileSync('git', ['init', '--quiet', repo]);
  writeFileSync(join(repo, '.gitignore'), '.private/\n');
  mkdirSync(join(repo, '.private'));
  mkdirSync(join(repo, 'assets'));
  const target = join(repo, 'assets', 'tracked.html');
  writeFileSync(target, 'keep tracked', { mode: 0o644 });
  execFileSync('git', ['-C', repo, 'add', 'assets/tracked.html']);
  const alias = join(repo, '.private', 'alias');
  symlinkSync(join(repo, 'assets'), alias);
  const result = run(join(alias, 'tracked.html'));
  assert.equal(result.status, 2);
  assert.match(result.stderr, /outside Git/);
  assert.equal(readFileSync(target, 'utf8'), 'keep tracked');
  assert.equal(statSync(target).mode & 0o777, 0o644);
});

test('bake accepts a directory alias only when its canonical destination is allowed', t => {
  const { dir, run } = fixture(t), repo = join(dir, 'repo');
  mkdirSync(repo);
  execFileSync('git', ['init', '--quiet', repo]);
  writeFileSync(join(repo, '.gitignore'), '.private/\n');
  mkdirSync(join(repo, '.private'));
  const alias = join(dir, 'allowed');
  symlinkSync(join(repo, '.private'), alias);
  const result = run(join(alias, 'release.html'));
  assert.equal(result.status, 0, result.stderr);
  const out = join(repo, '.private', 'release.html');
  assert.equal(statSync(out).mode & 0o777, 0o600);
  assert.equal(bakedConfig(out).initCode, initCode);
});

test('bake replaces an existing output without mutating another hard link to the old file', t => {
  const { dir, run } = fixture(t), original = join(dir, 'original.html'), out = join(dir, 'release.html');
  writeFileSync(original, 'keep original', { mode: 0o644 });
  linkSync(original, out);
  const result = run(out);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(readFileSync(original, 'utf8'), 'keep original');
  assert.equal(statSync(original).mode & 0o777, 0o644);
  assert.equal(statSync(out).mode & 0o777, 0o600);
  assert.equal(bakedConfig(out).initCode, initCode);
});

test('bake stores an optional HTTPS reopen URL in executable configuration without script injection', t => {
  const { dir, run } = fixture(t), out = join(dir, 'release.html');
  const reopenUrl = 'https://example.com/health?view=dashboard#</script><script>alert(1)</script>';
  const result = run(out, ['--reopen-url', reopenUrl]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(bakedConfig(out).reopenUrl, new URL(reopenUrl).href);
  assert.doesNotMatch(readFileSync(out, 'utf8'), /<script>alert\(1\)<\/script>/);
});

test('bake rejects unsafe reopen destinations without writing a release or logging the URL', t => {
  const { dir, run } = fixture(t), out = join(dir, 'release.html');
  for (const reopenUrl of ['javascript:alert(1)', 'http://example.com', '//example.com', '/health', 'https://user:password@example.com/']) {
    const result = run(out, ['--reopen-url', reopenUrl]);
    assert.equal(result.status, 2, reopenUrl);
    assert.match(result.stderr, /reopen-url/);
    assert.ok(!(result.stdout + result.stderr).includes(reopenUrl));
    assert.equal(existsSync(out), false);
  }
});
