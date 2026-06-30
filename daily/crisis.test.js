// test/crisis.test.js  ——  `node test/crisis.test.js`
// 重点测试:危机表述必须触发旁路,且不被聚合吞掉。
const assert = require('assert');
const { runDailyReview } = require('./index');
const { extract, CRISIS_REGEX } = require('./extractor');
const { stubDailyMap } = require('./llmDaily');
const { loadDeps } = require('./index');
const config = require('./config');
const { CRISIS_REPLY } = require('./reporter');

const { signals } = loadDeps();
let pass = 0, fail = 0;
const it = (name, fn) => Promise.resolve().then(fn)
  .then(() => { console.log('  ✓', name); pass++; })
  .catch(e => { console.log('  ✗', name, '\n    ', e.message); fail++; });

(async () => {
  console.log('crisis.test');

  await it('危机句触发旁路:status=crisis,不产出 profile/soft', async () => {
    const msgs = [
      { role: 'user', content: '今天还行吧' },
      { role: 'user', content: '我真的不想活了' },
    ];
    const out = await runDailyReview(msgs, { consent: true });
    assert.strictEqual(out.status, 'crisis');
    assert.strictEqual(out.crisis, true);
    assert.strictEqual(out.profile, undefined, '危机时绝不应进入聚合');
    assert.strictEqual(out.soft, undefined, '危机时绝不应进入 softScore');
    assert.strictEqual(out.report.text, CRISIS_REPLY);
    assert.deepStrictEqual(out.report.recommendations, []);
  });

  await it('危机不被普通信号淹没:同条对话里即便有大量可聚合信号也优先旁路', async () => {
    const msgs = [
      { role: 'user', content: '凌晨三四点就醒,睡不着' },     // 睡眠
      { role: 'user', content: '什么都提不起劲,好累' },       // 兴趣+疲劳
      { role: 'user', content: '总觉得要出事,放松不下来' },   // 焦虑
      { role: 'user', content: '有时候觉得不如死掉算了' },     // 危机
    ];
    const out = await runDailyReview(msgs, { consent: true });
    assert.strictEqual(out.status, 'crisis', '即使有多条普通信号,危机仍须最高优先级');
    assert.strictEqual(out.profile, undefined);
  });

  await it('extractor 层:危机置位且不产出可聚合片段', async () => {
    const msgs = [
      { role: 'user', content: '最近压力好大' },
      { role: 'user', content: '想结束生命的念头又冒出来了' },
    ];
    const r = await extract({ messages: msgs, signals, mapFn: stubDailyMap, config });
    assert.strictEqual(r.crisis, true);
    assert.strictEqual(r.items.length, 0, '危机时不得把任何片段交给聚合');
  });

  await it('危机正则覆盖关键表述', async () => {
    for (const s of ['不想活了', '想自杀', '不如死掉', '活着没意思', '了结自己', '消失算了']) {
      assert.ok(CRISIS_REGEX.test(s), `应命中: ${s}`);
    }
  });

  await it('无危机表述不会误触发', async () => {
    const out = await runDailyReview(
      [{ role: 'user', content: '今天累死了,这工作要把我累死' }], { consent: true });
    assert.strictEqual(out.crisis, false, '"累死了"等夸张说法不应误判为危机');
    assert.strictEqual(out.status, 'ok');
  });

  console.log(`crisis: ${pass} passed, ${fail} failed\n`);
  process.exit(fail ? 1 : 0);
})();
