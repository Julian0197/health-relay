// Publishes only the compact device wrapper into one owner-provisioned private record.
// The raw device credential never leaves this Worker; readers validate its digest.
import { MiaobiPublisher } from './miaobi.mjs';

export const badgeCacheEnabled = env => ['FEISHU_APP_ID', 'FEISHU_APP_SECRET', 'BADGE_API_KEY',
  'BADGE_CACHE_BASE_TOKEN', 'BADGE_CACHE_TABLE_ID', 'BADGE_CACHE_RECORD_ID'].every(key => Boolean(env[key]));

export class BadgeCachePublisher extends MiaobiPublisher {
  async publish(cache) {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(this.env.BADGE_API_KEY));
    const fields = { payload: JSON.stringify(cache),
      credential_sha256: Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('') };
    const [base, table, record] = ['BADGE_CACHE_BASE_TOKEN', 'BADGE_CACHE_TABLE_ID', 'BADGE_CACHE_RECORD_ID']
      .map(key => encodeURIComponent(this.env[key]));
    return this.withToken(async token => {
      const result = await this.request(`bitable/v1/apps/${base}/tables/${table}/records/${record}`, 'PUT', { fields }, token);
      if (!result.ok) return result;
      const echo = result.data.data?.record;
      if (echo?.record_id !== this.env.BADGE_CACHE_RECORD_ID) return { ok: false, error: { reason: 'invalid_record_response' } };
      const mismatched = Object.keys(fields).filter(key => echo.fields?.[key] !== fields[key]);
      return mismatched.length ? { ok: false, error: { reason: 'partial_record_response', fields: mismatched } } : { ok: true };
    });
  }
}
