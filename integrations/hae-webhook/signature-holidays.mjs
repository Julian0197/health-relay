// Mainland China holiday windows, verified against 国办发明电〔2025〕7号.
// https://www.gov.cn/zhengce/zhengceku/202511/content_7047091.htm
// Update from the annual official notice. Unknown years use everyday copy; never reuse lunar dates.
// These are calendar themes, not claims that the owner is off work or travelling.
export const HOLIDAYS = [
  { id: 'new_year', name: '元旦', start: '2026-01-01', end: '2026-01-03', copy: {
    relaxed: { natural: '元旦，把新一年过得舒展些', corporate: '元旦OKR：把从容规模化' },
    balanced: { natural: '元旦，按自己的步调开场', corporate: '元旦开局，先对齐生活节奏' },
    tense: { natural: '元旦，愿望慢慢写，不急着赶', corporate: '元旦小步启程，让愿望生长' },
    high: { natural: '元旦，先歇一会再迎接新年', corporate: '元旦首个P0：好好照顾自己' },
    above: { natural: '元旦，给新的日子留点期待', corporate: '元旦新增预算：一点小快乐' },
    usual: { natural: '元旦，从平常的小事开始', corporate: '元旦稳步开场，积累小美好' },
    below: { natural: '元旦，第一步可以轻一点', corporate: '元旦为自己预留从容预算' },
  } },
  { id: 'spring_festival', name: '春节', start: '2026-02-15', end: '2026-02-23', copy: {
    relaxed: { natural: '春节，给自在留个好位置', corporate: '春节核心竞争力：从容过年' },
    balanced: { natural: '春节，热闹与安静都刚好', corporate: '春节稳态运营，温暖按需交付' },
    tense: { natural: '春节，行程松一点也很好', corporate: '春节对齐好节奏，慢慢过' },
    high: { natural: '春节，先照顾自己再赶热闹', corporate: '春节核心交付：好好照顾自己' },
    above: { natural: '春节，留些空白装点年味', corporate: '春节增长点：给年味留预算' },
    usual: { natural: '春节，照自己的习惯慢慢过', corporate: '春节对齐自己的节奏就好' },
    below: { natural: '春节，热闹可以晚一点再赴', corporate: '春节给关怀自己多些资源' },
  } },
  { id: 'qingming', name: '清明', start: '2026-04-04', end: '2026-04-06', copy: {
    relaxed: { natural: '清明，把时间留给风与思念', corporate: '清明，把留白纳入时间预算' },
    balanced: { natural: '清明，慢慢走，静静想', corporate: '清明收拢日程，给安静留位' },
    tense: { natural: '清明，让脚步缓一些', corporate: '清明为安静预留时间预算' },
    high: { natural: '清明，给自己一处安静', corporate: '清明先照顾自己，再安排日程' },
    above: { natural: '清明，给心事一点空白', corporate: '清明的时间，留一些不排期' },
    usual: { natural: '清明，在平常里安放思念', corporate: '清明保留日常，也保留安静' },
    below: { natural: '清明，不催自己赶路', corporate: '清明少一点安排，多一点余地' },
  } },
  { id: 'labour_day', name: '劳动节', start: '2026-05-01', end: '2026-05-05', copy: {
    relaxed: { natural: '劳动节，把轻松留给自己', corporate: '劳动节，把松弛做成核心资产' },
    balanced: { natural: '劳动节，慢慢做喜欢的事', corporate: '劳动节稳定交付：好好生活' },
    tense: { natural: '劳动节，忙碌也该有个逗号', corporate: '劳动节给从容一点成长空间' },
    high: { natural: '劳动节，今天先让自己歇歇', corporate: '劳动节P0：温柔照顾自己' },
    above: { natural: '劳动节，给日子加一点趣味', corporate: '劳动节新增抓手：认真生活' },
    usual: { natural: '劳动节，平常的节奏也很好', corporate: '劳动节让日常小美好持续交付' },
    below: { natural: '劳动节，少赶一程也无妨', corporate: '劳动节给自己一份从容预算' },
  } },
  { id: 'dragon_boat', name: '端午', start: '2026-06-19', end: '2026-06-21', copy: {
    relaxed: { natural: '端午，粽香里慢慢过一天', corporate: '端午，把从容包进核心资产' },
    balanced: { natural: '端午，一口粽香，一点日常', corporate: '端午对齐口味，共享小快乐' },
    tense: { natural: '端午，先把日程松一松', corporate: '端午把从容纳入日程规划' },
    high: { natural: '端午，先歇一会再赶行程', corporate: '端午关怀专项：好好照顾自己' },
    above: { natural: '端午，把小期待包进日常', corporate: '端午的新增量，留给小期待' },
    usual: { natural: '端午，照自己的节奏过', corporate: '端午按自己的节奏稳步划桨' },
    below: { natural: '端午，今天不必划得太快', corporate: '端午补充能量，再划下一桨' },
  } },
  { id: 'mid_autumn', name: '中秋', start: '2026-09-25', end: '2026-09-27', copy: {
    relaxed: { natural: '中秋，月色和从容都留一点', corporate: '中秋核心产出：月色与松弛感' },
    balanced: { natural: '中秋，平常日子也有月光', corporate: '中秋对齐月亮，按原节奏运行' },
    tense: { natural: '中秋，先慢下来看看月亮', corporate: '中秋先对齐呼吸，再对齐月亮' },
    high: { natural: '中秋，借月色给自己歇一歇', corporate: '中秋把留白列为重点安排' },
    above: { natural: '中秋，把一点期待交给月光', corporate: '中秋新增排期：留一点时间赏月' },
    usual: { natural: '中秋，照常生活，也看看月亮', corporate: '中秋给赏月留一点时间预算' },
    below: { natural: '中秋，慢一点，月亮不会催', corporate: '中秋对齐温柔，再抬头看月' },
  } },
  { id: 'national_day', name: '国庆', start: '2026-10-01', end: '2026-10-07', copy: {
    relaxed: { natural: '国庆，把自在过成日常', corporate: '国庆核心战略：松弛感规模化' },
    balanced: { natural: '国庆，按喜欢的步调慢慢过', corporate: '国庆稳态运营，快乐按需交付' },
    tense: { natural: '国庆，行程不用排得太满', corporate: '国庆小步探索，舒展生活半径' },
    high: { natural: '国庆，先照顾自己再赶行程', corporate: '国庆优先安排：好好照顾自己' },
    above: { natural: '国庆，给喜欢的事留点空白', corporate: '国庆新增OKR：收集小美好' },
    usual: { natural: '国庆，平常地过也很不错', corporate: '国庆稳步交付，积累小快乐' },
    below: { natural: '国庆，慢一点也不算错过', corporate: '国庆把自我关怀做成长期主义' },
  } },
];

export function holidayFor(measuredAt) {
  const date = new Date(measuredAt + 8 * 3600000).toISOString().slice(0, 10);
  return HOLIDAYS.find(holiday => date >= holiday.start && date <= holiday.end) ?? null;
}
