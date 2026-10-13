import test from "node:test";
import assert from "node:assert/strict";
import { buildDashboard } from "./build.mjs";
import { gunzipSync } from "node:zlib";
import { readFileSync } from "node:fs";
import vm from "node:vm";
test("production build is self-contained, placeholder-only and excludes demo data", async () => {
  const { html } = await buildDashboard({ write: false });
  assert.doesNotMatch(
    html,
    /<script[^>]+src=|<link[^>]+href=|演示数据 · 用于界面与交互验证，不是真实健康记录.*makeFixture/s,
  );
  const encoded = html.match(/<script id="dashboard-bundle" type="application\/gzip">([^<]+)<\/script>/)[1];
  const runtime = gunzipSync(Buffer.from(encoded, "base64")).toString("utf8");
  assert.ok(Buffer.byteLength(html) < 500_000);
  assert.equal(((html + runtime).match(/__UNBAKED_MAGIC_INIT__/g) ?? []).length, 2);
  for (const p of [
    "__BASE_APP_TOKEN__",
    "__BASE_TABLE_ID__",
    "__BASE_RECORD_ID__",
  ])
    assert.equal((html.match(new RegExp(p, "g")) ?? []).length, 1);
  assert.doesNotMatch(html + runtime, /v3-demo|v2-demo|night-v1-demo/);
  assert.match(html, /Apache License/);
  assert.match(html, /MIT License/);
  assert.match(html, /<style>/);
  assert.equal((html.match(/(?:^|\n)<script>/g) ?? []).length, 2);
  let appended, removed = false;
  await vm.runInNewContext(readFileSync(new URL('./boot.js', import.meta.url), 'utf8'), {
    Uint8Array, atob, Blob, Response, DecompressionStream,
    document: { getElementById: () => ({ textContent: encoded, remove() { removed = true; } }),
      createElement: () => ({}), body: { appendChild(script) { appended = script.textContent; } } },
  });
  assert.equal(appended, runtime);
  assert.equal(removed, true);
});

test("bundle load failure shows a readable recovery message", async () => {
  const root = {};
  await vm.runInNewContext(readFileSync(new URL('./boot.js', import.meta.url), 'utf8'), {
    Uint8Array, atob, Blob, Response,
    document: { getElementById: (id) => id === 'root' ? root : { textContent: 'AA==' } },
  });
  assert.match(root.textContent, /看板资源加载失败/);
});
