import test from 'node:test';
import assert from 'node:assert/strict';
import * as copy from './signature-phrases.mjs';
import { HOLIDAYS, holidayFor } from './signature-holidays.mjs';
const { PHRASES, formatPhysiologyTitle, formatHrvObservationHeading } = copy;
test('state-linked emoji vary deterministically without changing the fixed status label', () => {
  assert.ok(copy.STATE_EMOJIS);
  for (const [key, icons] of Object.entries(copy.STATE_EMOJIS)) {
    assert.equal(icons.length, 3);
    const selected = new Set();
    for (let d = 1; d <= 28; d++) {
      const measuredAt = Date.parse(`2026-08-${String(d).padStart(2, '0')}T11:53:00+08:00`);
      const title = key in PHRASES ? formatPhysiologyTitle({ state: key, measuredAt,
        features: { hrv: { latest: 41 }, resting: { current: 63 } } })
        : formatHrvObservationHeading({ position: key, current: 41, measuredAt });
      const { icon, phrase } = copy.selectSignatureCopy(measuredAt, key);
      const prose = `${icon} ${phrase}`;
      const selectedIcon = icons.find(value => prose.startsWith(value + ' '));
      assert.ok(selectedIcon, key + ': ' + title);
      selected.add(selectedIcon);
      assert.doesNotMatch(title, /🫀/);
    }
    assert.equal(selected.size, 3, key);
  }
});
test('all four states have four styles and compact dated, deterministic original copy', () => {
  const seen = new Set();
  for (const [state, entry] of Object.entries(PHRASES)) {
    for (const style of ['light', 'natural', 'developer', 'corporate']) {
      assert.equal(entry[style]?.length, 3, `${state}/${style} has three phrases`);
      for (const phrase of entry[style]) {
        assert.ok(!seen.has(phrase)); seen.add(phrase);
      }
    }
    for (let d = 1; d <= 28; d++) {
      const input = { state, measuredAt: Date.parse(`2026-09-${String(d).padStart(2, '0')}T11:53:00+08:00`),
        features: { hrv: { latest: 87.15 }, resting: { current: 48 } } };
      const title = formatPhysiologyTitle(input);
      assert.equal(title, formatPhysiologyTitle(input));
      assert.ok(title.startsWith(entry.label));
      assert.ok([...title].length <= 60);
      assert.match(title, /\nHRV 87 · RHR 48｜09\/[\d]{2} 11:53$/);
    }
  }
  assert.equal(seen.size, 48);
  assert.equal(formatPhysiologyTitle({ state: 'learning' }), null);
});

test('every verified holiday has gentle and corporate copy for all seven states, within the signature budget', () => {
  const seen = new Set();
  assert.equal(HOLIDAYS.length, 7);
  for (const holiday of HOLIDAYS) {
    assert.equal(holidayFor(Date.parse(`${holiday.start}T00:00:00+08:00`)), holiday);
    assert.equal(holidayFor(Date.parse(`${holiday.end}T23:59:59+08:00`)), holiday);
    for (const key of [...Object.keys(PHRASES), ...Object.keys(copy.HRV_COPY)]) {
      const entry = holiday.copy[key];
      assert.deepEqual(Object.keys(entry), ['natural', 'corporate']);
      for (const text of Object.values(entry)) {
        assert.ok(text.includes(holiday.name));
        assert.ok([...text].length <= 22, text);
        assert.ok(!seen.has(text), text); seen.add(text);
        if (holiday.id === 'qingming') assert.doesNotMatch(text, /快乐|庆祝|狂欢|冲刺|团圆/);
      }
      // Exercise the actual formatter for each holiday day, including both holiday styles.
      const selected = new Set();
      for (let at = Date.parse(`${holiday.start}T12:00:00+08:00`); at <= Date.parse(`${holiday.end}T12:00:00+08:00`); at += 86400000) {
        const title = key in PHRASES ? formatPhysiologyTitle({ state: key, measuredAt: at,
          features: { hrv: { latest: 41 }, resting: { current: 63 } } })
          : formatHrvObservationHeading({ position: key, current: 41, measuredAt: at });
        const selectedCopy = copy.selectSignatureCopy(at, key);
        const prose = `${selectedCopy.icon} ${selectedCopy.phrase}`;
        const phrase = Object.values(entry).find(p => prose.endsWith(' ' + p));
        assert.ok(phrase);
        assert.ok(title.includes(phrase), 'public title must use the holiday-specific copy');
        if (holiday.id === 'qingming') assert.equal(phrase, entry.natural);
        if (holiday.id === 'qingming') assert.ok(prose.startsWith('🌿 '));
        assert.ok([...title].length <= 60);
        selected.add(phrase);
      }
      assert.equal(selected.size, holiday.id === 'qingming' ? 1 : 2, holiday.id + '/' + key);
    }
  }
  assert.equal(seen.size, 98);
  for (const date of ['2026-01-04', '2026-02-14', '2026-02-28', '2026-05-09', '2026-09-20', '2026-09-28', '2026-10-10', '2027-02-15']) {
    assert.equal(holidayFor(Date.parse(`${date}T12:00:00+08:00`)), null);
  }
});

test('each HRV comparison has all four styles and puts corporate jokes in the normal rotation', () => {
  assert.ok(copy.HRV_COPY);
  for (const [position, entry] of Object.entries(copy.HRV_COPY)) {
    for (const style of ['light', 'natural', 'developer', 'corporate']) assert.equal(entry[style].length, 3);
    const seen = new Set();
    for (let d = 1; d <= 28; d++) {
      const input = { position, current: 41, measuredAt: Date.parse(`2026-08-${String(d).padStart(2, '0')}T10:00:00+08:00`) };
      const title = formatHrvObservationHeading(input);
      assert.equal(title, formatHrvObservationHeading(input));
      assert.ok(title.includes(` ${entry.label}｜`));
      assert.ok(title.includes(copy.selectSignatureCopy(input.measuredAt, position).shortPhrase));
      assert.ok([...title].length <= 24);
      assert.doesNotMatch(title, /🫀|状态优秀|状态正常|注意压力|压力过载/);
      const selectedCopy = copy.selectSignatureCopy(input.measuredAt, position);
      const prose = `${selectedCopy.icon} ${selectedCopy.phrase}`;
      seen.add(copy.COPY_STYLES.flatMap(style => entry[style]).find(p => prose.endsWith(' ' + p)));
    }
    for (const style of ['light', 'natural', 'developer', 'corporate']) assert.ok(entry[style].some(p => seen.has(p)), position + style);
  }
});

test('holiday copy follows the measurement date in Shanghai and does not change state or metrics', () => {
  const input = { state: 'high', measuredAt: Date.parse('2026-10-01T00:00:00+08:00'),
    features: { hrv: { latest: 41 }, resting: { current: 63 } } };
  assert.match(formatPhysiologyTitle(input), /^🔴 压力过载｜.*国庆.+\nHRV 41 · RHR 63｜10\/01 00:00$/);
  assert.match(copy.selectSignatureCopy(input.measuredAt, 'high').phrase, /国庆/);
  assert.doesNotMatch(copy.selectSignatureCopy(input.measuredAt - 1, 'high').phrase, /国庆/);
  assert.doesNotMatch(copy.selectSignatureCopy(Date.parse('2026-10-10T10:00:00+08:00'), 'high').phrase, /国庆/);
  const hrv = { position: 'below', current: 41, measuredAt: input.measuredAt };
  assert.match(formatHrvObservationHeading(hrv), /^\S+ 偏低｜.*国庆/);
  assert.match(copy.selectSignatureCopy(input.measuredAt, 'below').phrase, /国庆/);
  assert.doesNotMatch(copy.selectSignatureCopy(Date.parse('2027-10-02T10:00:00+08:00'), 'below').phrase, /国庆/);
});

test('public signature has concise prose, ordered metrics and one explicit overview timestamp', () => {
  for (const state of Object.keys(PHRASES)) {
    const title = formatPhysiologyTitle({ state, measuredAt: Date.parse('2026-09-28T07:52:45+08:00'),
      features: { hrv: { latest: 55 }, resting: { current: 46 } } });
    assert.equal(title, `${PHRASES[state].label}｜${copy.selectSignatureCopy(Date.parse('2026-09-28T07:52:45+08:00'), state).shortPhrase.replace(/^\S+ /u, '')}\nHRV 55 · RHR 46｜09/28 07:52`);
    assert.equal(title.match(/\d{2}:\d{2}/g).length, 1);
  }
  assert.equal(formatHrvObservationHeading({ position: 'usual', current: 55,
    measuredAt: Date.parse('2026-09-28T07:52:45+08:00') }), '🍃 近常态｜对齐节奏，稳步推进');
});

test('each state has four concise styles with varied four-tier icon and phrase pairs', () => {
  for (const [state, phrases] of Object.entries(copy.SHORT_PHRASES)) {
    const count = state in PHRASES ? 12 : 4;
    assert.equal(phrases.length, count);
    assert.equal(new Set(phrases).size, count);
    for (const phrase of phrases) assert.ok([...phrase].length <= (state in PHRASES ? 16 : 13), state + phrase);
  }
});


test('latest-sample four-tier signatures label the displayed HRV against its own baseline', () => {
  for (const [changePercent, label] of [[-36, '↓'], [0, ''], [25, '↑']]) {
    const title = formatPhysiologyTitle({ state: 'tense', measuredAt: Date.parse('2026-09-28T15:02:50+08:00'),
      features: { hrv: { latest: 42, current: 42, changePercent, currentAggregation: 'latest_sample' }, heart: { current: 58 } } });
    assert.ok(title.includes(`HRV 42${label} · HR 58`));
  }
});
