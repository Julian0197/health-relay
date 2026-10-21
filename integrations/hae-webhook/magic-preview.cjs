// Bake only resource IDs into a private deployment copy; no credentials belong here.
function createHealthPreview(binding) {
  const { baseToken, tableId, viewId, recordId, targetUrl } = binding;
  const textValue = raw => Array.isArray(raw)
    ? raw.filter(v => v?.type === 'text' && typeof v.text === 'string').map(v => v.text).join('') : raw;
  return async function healthPreview(request, context = {}) {
    let title = '⌚ 健康状态读取中｜详情 ↗';
    let imageKey;
    try {
      const sdk = context.magic ?? globalThis.magic ?? globalThis.window?.magic;
      const response = await sdk.base_records_search(baseToken, tableId, viewId, undefined, undefined, undefined, 200);
      if (response.code !== undefined && response.code !== 0) throw Error('read_failed');
      const records = response.data?.items ?? response.data?.records ?? [];
      const record = records.find(r => (r.record_id ?? r.id) === recordId);
      const value = textValue(record?.fields?.title);
      if (typeof value === 'string' && value.trim() && value.length <= 300) title = value;
      const image = textValue(record?.fields?.image_key);
      if (typeof image === 'string' && image.length <= 256 && /^img_[A-Za-z0-9_-]+$/.test(image.trim())) imageKey = image.trim();
    } catch { /* Keep a visible, bounded fallback without exposing API diagnostics. */ }
    return new Response(JSON.stringify({
      inline: { i18n_title: { zh_cn: title, en_us: title },
        ...(imageKey ? { image_key: imageKey } : {}),
        url: { copy_url: targetUrl, pc: targetUrl, ios: targetUrl, android: targetUrl, web: targetUrl } },
      url: targetUrl, target_url: targetUrl, expire_strategy: '60s',
    }), { status: 200, headers: { 'Content-Type': 'application/json; charset=utf-8' } });
  };
}
module.exports = createHealthPreview;
