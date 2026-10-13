// Pushes dashboard DTOs without sleep boundaries into an independent display Base.
// The HTML box reads through Miaobi; it never receives a Worker API key.
// Base sharing and the Miaobi app's read-only membership bound reader access.
//
// Required env: DASHBOARD_CACHE_TABLE_ID + DASHBOARD_CACHE_RECORD_ID;
// base token defaults to SIGNATURE_BASE_TOKEN (same private Base), overridden by
// DASHBOARD_CACHE_BASE_TOKEN. The Worker's Feishu app needs edit access to the record.
import { MiaobiPublisher } from './miaobi.mjs';
import { dashboardForReaders } from './dashboard.mjs';

// 7d minute windows would overflow a text cell; 10-min buckets keep it well under 100k chars
// while staying far above the ~640px chart resolution for a week. Bucketing happens inside
// buildDashboard BEFORE the 5000-point cap, otherwise the cap truncates 10080 minutes to the
// newest 5000 and the buckets only cover ~3.5 of the 7 days.
export const CACHE_HEART_BUCKET_MS = 10 * 60000;

export const dashboardCacheEnabled = env =>
  ['DASHBOARD_CACHE_TABLE_ID', 'DASHBOARD_CACHE_RECORD_ID'].every(key => Boolean(env[key])) &&
  Boolean(env.DASHBOARD_CACHE_BASE_TOKEN || env.SIGNATURE_BASE_TOKEN) &&
  ['FEISHU_APP_ID', 'FEISHU_APP_SECRET'].every(key => Boolean(env[key]));

export class DashboardCachePublisher extends MiaobiPublisher {
  async publish({ payload24h, payload7d, generatedAt }) {
    const reader24h = JSON.stringify(dashboardForReaders(JSON.parse(payload24h)));
    const reader7d = JSON.stringify(dashboardForReaders(JSON.parse(payload7d)));
    const base = encodeURIComponent(this.env.DASHBOARD_CACHE_BASE_TOKEN || this.env.SIGNATURE_BASE_TOKEN);
    const table = encodeURIComponent(this.env.DASHBOARD_CACHE_TABLE_ID);
    const expectedRecordId = this.env.DASHBOARD_CACHE_RECORD_ID;
    return this.withToken(async token => {
      const result = await this.request(
        `bitable/v1/apps/${base}/tables/${table}/records/${encodeURIComponent(expectedRecordId)}`,
        'PUT',
        { fields: { payload_24h: reader24h, payload_7d: reader7d, generated_at: generatedAt } },
        token,
      );
      if (!result.ok) return result;
      if (result.data.data?.record?.record_id !== expectedRecordId) {
        return { ok: false, error: { reason: 'invalid_record_response' } };
      }
      const fields = result.data.data.record.fields;
      const mismatched = ['payload_24h', 'payload_7d'].filter(key => fields?.[key] !== (key === 'payload_24h' ? reader24h : reader7d));
      if (mismatched.length) return { ok: false, error: { reason: 'partial_record_response', fields: mismatched } };
      return { ok: true };
    });
  }
}
