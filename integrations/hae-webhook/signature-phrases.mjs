// Supportive, non-diagnostic copy: encourage ease, care and pacing without promising recovery.
// The observation date, not upload time, selects a phrase.
import { holidayFor } from './signature-holidays.mjs';
export const COPY_STYLES = ['light', 'natural', 'developer', 'corporate'];
// Four-tier markers stay fixed; descriptive HRV headings use a state-linked icon.
export const STATE_EMOJIS = {
  relaxed: ['😌', '🌿', '🫧'], balanced: ['🙂', '🧭', '🌤️'],
  tense: ['😮‍💨', '🍃', '🧘'], high: ['🌱', '🫖', '🛋️'],
  above: ['🌱', '🌼', '✨'], usual: ['🍃', '☕', '〰️'], below: ['🍵', '🌙', '🫧'],
};
export const PHRASES = {
  relaxed: { label: '🟢 状态优秀',
    light: ['把日子调成微风档', '轻松这件事，今天有点天赋', '今天慢慢来，也很好'],
    natural: ['留点空白，装下好天气', '轻装上阵，顺着节奏走', '风吹到哪里，就舒展到哪里'],
    developer: ['写点自己喜欢的代码', '灵感来了，随手记两行', '代码之外，也有好风景'],
    corporate: ['松弛感已形成正向飞轮', '今日核心产出：情绪价值', '把舒适区做成长期主义'] },
  balanced: { label: '🔵 状态正常',
    light: ['步子刚好，好事慢慢来', '步子刚好，日子照常', '平常心也有好风景'],
    natural: ['沿着自己的节奏向前', '风有方向，我有步调', '一程一程，稳稳走'],
    developer: ['一行一行，慢慢写', '小步提交，稳稳向前', '写清楚，也想明白'],
    corporate: ['对齐好节奏，稳步向前', '稳步交付，把日子过好', '今日闭环：把今天过好'] },
  tense: { label: '🟡 注意压力',
    light: ['舒展一下，接住好心情', '喝口水，给自己一点余裕', '小小休息，也是好安排'],
    natural: ['给呼吸留一段空白', '轻轻调整，慢慢向前', '借一阵微风，舒展心绪'],
    developer: ['先保存，起来走走', '换个思路，顺便散个步', '离开屏幕，看看远处'],
    corporate: ['对齐呼吸，让节奏更舒展', '给从容增加一点资源预算', '小步推进，也有复利'] },
  high: { label: '🔴 压力过载',
    light: ['歇一小会，也在向前', '给自己一杯茶的温柔', '照顾好自己，就是好安排'],
    natural: ['让呼吸陪自己慢慢舒展', '留一处安静，盛一点阳光', '留些时间，温柔照顾自己'],
    developer: ['保存进度，先歇一会', '合上电脑，给自己点时间', '代码等一等，茶趁热喝'],
    corporate: ['今日P0：好好照顾自己', '把自我关怀纳入核心战略', '为从容配置长期资源'] },
};
export const HRV_COPY = {
  above: { label: '偏高',
    light: ['今天给好心情留个座', '日子可以多一点小期待', '顺手收集一点小快乐'],
    natural: ['把余白留给喜欢的事', '让步调舒展一点', '今天给从容多留一格'],
    developer: ['给喜欢的小项目留点时间', '有个新点子，先记下来', '写完这一段，去看看风景'],
    corporate: ['今日增量：给生活一点想象力', '今日OKR：接住小快乐', '把留白纳入长期规划'] },
  usual: { label: '近常态',
    light: ['普普通通，也挺好', '今天先按熟悉的步调走', '小小日常，也值得期待'],
    natural: ['就按这个节奏，慢慢往前', '平常的一刻，也值得记录', '给寻常日子留一点耐心'],
    developer: ['按自己的节奏写代码', '今天也从一个小改动开始', '代码慢慢写，日子慢慢过'],
    corporate: ['稳稳推进，积累日常小收获', '今日方法论：认真照顾自己', '把日常小快乐做成长期主义'] },
  below: { label: '偏低',
    light: ['留点余裕，也能走得很好', '舒展肩膀，慢慢向前', '给日子留一点柔软空间'],
    natural: ['把下一步走得轻一点', '借一点安静，留给自己', '珍惜这一刻，慢慢就好'],
    developer: ['先放下键盘，伸个懒腰', '保存好了，就去歇歇', '问题先记下，喝口水再看'],
    corporate: ['今日抓手：把自己照顾好', '把休息升为最高优先级', '把关怀自己纳入日常闭环'] },
};
// Four-tier copy has three concise icon/phrase pairs per style; HRV descriptions retain one.
// Keep the colored status marker separate from the decorative phrase icon.
export const SHORT_PHRASES = {
  relaxed: [
    '😌 今天和世界相处不错', '🫧 今天慢慢来，也很好', '🪁 轻装上阵，慢慢展开',
    '🍃 把日子调成微风档', '🌿 留点空白，装下好天气', '🌼 沿途的小美好慢慢收集',
    '⌨️ 写点自己喜欢的代码', '💡 灵感来了，随手记两行', '🌳 代码之外，也有好风景',
    '🪴 从容也是核心竞争力', '✨ 今日产出：一点小快乐', '🌱 把松弛做成长期主义',
  ],
  balanced: [
    '🙂 步子刚好，好事慢慢来', '☕ 平常日子也有好滋味', '🎵 今天也按喜欢的节拍走',
    '🧭 沿着自己的节奏走', '🌤️ 平常心也有好风景', '👣 一程一程，稳稳向前',
    '⌨️ 一行一行，慢慢写', '🌱 小步提交，稳稳向前', '📝 写清楚，也想明白',
    '📦 稳步交付，把日子过好', '🎯 对齐节奏，积累小快乐', '🌱 把好日常做成长期主义',
  ],
  tense: [
    '🙆 舒展一下，接住好心情', '🥤 喝口水，给自己点余裕', '🪟 看看窗外，再慢慢来',
    '🍃 借一阵风，舒展一下', '🌬️ 给呼吸留一段空白', '🌿 把下一步走得轻一点',
    '💾 先保存，起来走走', '🚶 换个思路，顺便散个步', '🪟 离开屏幕，看看远处',
    '🌬️ 先对齐呼吸，再展开', '🪴 给从容多一点资源预算', '👣 小步推进，也有复利',
  ],
  high: [
    '🫖 歇一小会，也在向前', '🛋️ 找个舒服的地方歇歇', '☕ 一杯茶的时间留给自己',
    '🌿 留些时间，温柔待己', '🌤️ 留一处安静，盛点阳光', '🍃 让呼吸陪自己慢慢舒展',
    '💾 保存进度，安心歇会儿', '💻 合上电脑，给自己点时间', '☕ 代码等一等，茶趁热喝',
    '🫶 今日P0：照顾好自己', '🫖 自我关怀，优先安排', '🛋️ 今日排期：好好休息',
  ],
  above: ['给好心情留个座', '把余白留给喜欢的事', '给小项目留点时间', '今日OKR：接住快乐'],
  usual: ['普普通通，也挺好', '就按自己的节奏走', '按自己的节奏写代码', '对齐节奏，稳步推进'],
  below: ['给自己一点小小关照', '借一阵风，轻轻向前', '放下键盘，伸个懒腰', '把关怀纳入日常闭环'],
};
export function selectSignatureCopy(measuredAt, key) {
  const entry = PHRASES[key] ?? HRV_COPY[key];
  if (!entry) return null;
  const date = new Date(measuredAt + 8 * 3600000).toISOString().slice(0, 10);
  const holiday = holidayFor(measuredAt);
  const phrases = COPY_STYLES.flatMap(style => entry[style]);
  let hash = 0;
  for (const char of `${date}:${key}:copy-v2`) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  const icons = STATE_EMOJIS[key];
  const icon = holiday?.id === 'qingming' ? '🌿' : icons[hash % icons.length];
  const short = SHORT_PHRASES[key];
  const phrase = holiday
    ? holiday.copy[key][holiday.id === 'qingming' || hash % 2 === 0 ? 'natural' : 'corporate']
    : phrases[hash % phrases.length];
  const shortIndex = short.length === 12 ? hash % 12 : Math.floor((hash % 12) / 3);
  const shortPhrase = holiday
    ? `${PHRASES[key] ? icon + ' ' : ''}${phrase}`
    : short[shortIndex];
  return { icon, phrase, shortPhrase };
}
export function formatHrvObservationHeading(comparison) {
  const entry = HRV_COPY[comparison.position];
  const copy = selectSignatureCopy(comparison.measuredAt, comparison.position);
  return `${copy.icon} ${entry.label}｜${copy.shortPhrase}`;
}
export function formatNeutralHeading(decision) {
  if (decision.hrvComparison) return formatHrvObservationHeading(decision.hrvComparison);
  // Sampling context belongs in diagnostics, not in a public status label.
  return '🍃 按自己的节奏走';
}
export function formatSignatureMetrics(decision) {
  const stamp = new Date((decision.asOfAt ?? decision.measuredAt) + 8 * 3600000).toISOString();
  const heart = decision.features.heart;
  const resting = decision.features.resting;
  const metric = heart ? ` · HR ${Math.round(heart.current)}` : resting ? ` · RHR ${Math.round(resting.current)}` : '';
  const hrv = decision.features.hrv;
  const position = decision.hrvComparison?.position ?? (
    hrv.currentAggregation === 'latest_sample' && Number.isFinite(hrv.changePercent)
      ? hrv.changePercent <= -20 ? 'below' : hrv.changePercent >= 20 ? 'above' : 'usual'
      : null
  );
  // Arrows describe position relative to the personal baseline, not change since the previous sample.
  const label = ({ above: '↑', usual: '', below: '↓' })[position] ?? '';
  return `HRV ${Math.round(decision.features.hrv.latest)}${label}${metric}｜${stamp.slice(5, 10).replace('-', '/')} ${stamp.slice(11, 16)}`;
}
export function formatPhysiologyTitle(decision) {
  const entry = PHRASES[decision.state];
  if (!entry) return null;
  const copy = selectSignatureCopy(decision.measuredAt, decision.state);
  // Four-tier phrases start with a decorative icon; retain only the fixed state marker in the title.
  const phrase = copy.shortPhrase.slice(copy.shortPhrase.indexOf(' ') + 1);
  return `${entry.label}｜${phrase}\n${formatSignatureMetrics(decision)}`;
}
