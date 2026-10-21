import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const factory = require('./magic-preview.cjs');
const target = 'https://example.com/details';
test('Magic preview emits official inline JSON using only the bound title and fixed destination', async () => {
  assert.equal(typeof factory, 'function', 'Magic preview factory must exist');
  const sdk = { base_records_search: async () => ({ data: { records: [{ record_id: 'rec1', fields: {
    title: '🔵 状态正常｜HRV49 心率55｜详情 ↗', url: 'https://untrusted.example', secret: 'never output' } }] } }) };
  const handler = factory({ baseToken: 'base', tableId: 'table', viewId: 'view', recordId: 'rec1', targetUrl: target });
  const response = await handler(new Request('https://preview.test'), { magic: sdk });
  assert.equal(response.status, 200); assert.match(response.headers.get('content-type'), /application\/json/);
  const body = await response.json();
  assert.equal(body.inline.i18n_title.zh_cn, '🔵 状态正常｜HRV49 心率55｜详情 ↗');
  assert.equal(body.inline.url.pc, target); assert.equal(body.inline.url.ios, target);
  assert.equal(body.expire_strategy, '60s'); assert.ok(!JSON.stringify(body).includes('never output'));
});
test('Magic preview fails visibly without leaking SDK errors or using another record', async () => {
  assert.equal(typeof factory, 'function', 'Magic preview factory must exist');
  const handler = factory({ baseToken: 'base', tableId: 'table', recordId: 'rec1', targetUrl: target });
  for (const sdk of [{ base_records_search: async () => { throw Error('private credentials'); } },
    { base_records_search: async () => ({ data: { records: [{ record_id: 'other', fields: { title: 'wrong' } }] } }) }]) {
    const body = await (await handler(new Request('https://preview.test'), { magic: sdk })).json();
    assert.equal(body.inline.i18n_title.zh_cn, '⌚ 健康状态读取中｜详情 ↗');
    assert.ok(!JSON.stringify(body).includes('private credentials')); assert.ok(!JSON.stringify(body).includes('wrong'));
  }
});

test('Magic preview reads the documented SDK items and rich text fields', async () => {
  const handler = factory({ baseToken: 'base', tableId: 'table', recordId: 'rec1', targetUrl: target });
  const sdk = { base_records_search: async () => ({ code: 0, data: { items: [{ record_id: 'rec1', fields: {
    title: [{ type: 'text', text: '状态正常｜' }, { type: 'text', text: 'HRV49 心率55' }] } }] } }) };
  const body = await (await handler(new Request('https://preview.test'), { magic: sdk })).json();
  assert.equal(body.inline.i18n_title.zh_cn, '状态正常｜HRV49 心率55');
});

test('Magic preview shows the bound pet image from plain or rich text without changing the destination', async () => {
  const imageKey = 'img_v3_02e1_3d5a0bd3-c622-4c1b-b16b-ac9db68258cg';
  const handler = factory({ baseToken: 'base', tableId: 'table', recordId: 'rec1', targetUrl: target });
  for (const image of [imageKey, [{ type: 'text', text: imageKey }]]) {
    const sdk = { base_records_search: async () => ({ code: 0, data: { items: [
      { record_id: 'other', fields: { image_key: 'img_other' } },
      { record_id: 'rec1', fields: { title: '状态正常', image_key: image, url: 'https://untrusted.example' } },
    ] } }) };
    const body = await (await handler(new Request('https://preview.test'), { magic: sdk })).json();
    assert.equal(body.inline.image_key, imageKey);
    assert.equal(body.inline.i18n_title.zh_cn, '状态正常');
    for (const platform of ['copy_url', 'pc', 'ios', 'android', 'web']) assert.equal(body.inline.url[platform], target);
    assert.equal(body.target_url, target);
  }
});

test('Magic preview omits absent or invalid image keys while keeping the health title', async () => {
  const handler = factory({ baseToken: 'base', tableId: 'table', recordId: 'rec1', targetUrl: target });
  for (const image of [undefined, '', 'https://example.com/pet.gif', 'img_invalid?query', [{ type: 'mention', text: 'img_wrong' }]]) {
    const sdk = { base_records_search: async () => ({ data: { records: [
      { record_id: 'rec1', fields: { title: '状态正常', image_key: image } },
    ] } }) };
    const body = await (await handler(new Request('https://preview.test'), { magic: sdk })).json();
    assert.ok(!Object.hasOwn(body.inline, 'image_key'));
    assert.equal(body.inline.i18n_title.zh_cn, '状态正常');
  }
});
