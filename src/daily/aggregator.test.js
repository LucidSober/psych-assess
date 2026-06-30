// test/aggregator.test.js  ——  `node test/aggregator.test.js`
const assert = require('assert');
const { aggregate, mergeIntensity, freqBandFromMentions } = require('./aggregator');
const { loadDeps } = require('./index');
const config = require('./config');

const { signals } = loadDeps();
const ev = (dimension, intensity_hint, valence = 'negative', confidence = 0.8, evidence = '') =>
  ({ snippet: `s_${dimension}_${Math.random().toString(36).slice(2, 6)}`,
     dimension, valence, intensity_hint, confidence, evidence });
const agg = (items) => aggregate({ items, signals, config });

let pass = 0, fail = 0;
const t = (name, fn) => { try { fn(); console.log('  ✓', name); pass++; }
  catch (e) { console.log('  ✗', name, '\n    ', e.message); fail++; } };

console.log('aggregator.test');

t('频率档:几乎天天提≈3', () => {
  const items = Array.from({ length: 5 }, () => ev('PHQ9_item3', 2));
  const d = agg(items).dimensions['PHQ9_item3'];
  assert.strictEqual(d.frequency_band, 3, `5 次提及应为档 3,实际 ${d.frequency_band}`);
});

t('频率档:偶尔一次≈1', () => {
  const d = agg([ev('PHQ9_item3', 2)]).dimensions['PHQ9_item3'];
  assert.strictEqual(d.frequency_band, 1);
});

t('频率档:中间档(3 次→2)', () => {
  const items = Array.from({ length: 3 }, () => ev('PHQ9_item4', 2));
  assert.strictEqual(agg(items).dimensions['PHQ9_item4'].frequency_band, 2);
});

t('一句重话不拉满:单条 intensity=3 → 合并 ≤ single_cap', () => {
  assert.strictEqual(mergeIntensity([3], config.intensity), config.intensity.single_cap);
  const d = agg([ev('PHQ9_item2', 3)]).dimensions['PHQ9_item2'];
  assert.ok(d.intensity <= config.intensity.single_cap, `实际 ${d.intensity}`);
});

t('强度偏重带衰减:多条重话才逼近 3', () => {
  const merged = mergeIntensity([3, 3, 2], config.intensity); // 3 + 3*.35 + 2*.1225
  assert.ok(merged > config.intensity.single_cap && merged <= 3, `实际 ${merged}`);
});

t('矛盾证据:正向更强 → 判为改善且不计入 fired', () => {
  const items = [ev('PHQ9_item3', 1, 'negative', 0.5), ev('PHQ9_item3', 3, 'positive', 0.9)];
  const r = agg(items);
  const d = r.dimensions['PHQ9_item3'];
  assert.strictEqual(d.net_valence, 'improving', `净方向应为 improving,实际 ${d.net_valence}`);
  assert.strictEqual(d.insufficient, true);
  assert.ok(!r.fired_dimensions.includes('PHQ9_item3'));
});

t('矛盾证据:负向更强 → 判为 mixed 且强度打折', () => {
  const items = [ev('GAD7_item1', 3, 'negative', 0.9), ev('GAD7_item1', 1, 'positive', 0.5)];
  const d = agg(items).dimensions['GAD7_item1'];
  assert.strictEqual(d.net_valence, 'mixed');
});

t('证据太少/置信太低 → 信号不足', () => {
  const d = agg([ev('PHQ9_item7', 1, 'negative', 0.2)]).dimensions['PHQ9_item7'];
  assert.strictEqual(d.insufficient, true, '低置信单条应判信号不足');
});

t('freqBandFromMentions 边界', () => {
  assert.strictEqual(freqBandFromMentions(0, config), 0);
  assert.strictEqual(freqBandFromMentions(2, config), 1);
});

console.log(`aggregator: ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
