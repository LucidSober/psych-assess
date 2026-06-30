// test/extractor.test.js  ——  `node test/extractor.test.js`
const assert = require('assert');
const { extract } = require('./extractor');
const { stubDailyMap } = require('./llmDaily');
const { loadDeps } = require('./index');
const config = require('./config');

const { signals } = loadDeps();
const run = (messages) => extract({ messages, signals, mapFn: stubDailyMap, config });

let pass = 0, fail = 0;
const it = (name, fn) => fn().then(() => { console.log('  ✓', name); pass++; })
  .catch(e => { console.log('  ✗', name, '\n    ', e.message); fail++; });

(async () => {
  console.log('extractor.test');

  await it('无关闲聊不产生任何片段', async () => {
    const msgs = [
      { role: 'user', content: '今天天气不错,出门带不带伞?' },
      { role: 'user', content: '帮我查下快递到哪了' },
      { role: 'user', content: '晚上几点开会来着' },
    ];
    const r = await run(msgs);
    assert.strictEqual(r.crisis, false);
    assert.strictEqual(r.items.length, 0, `期望 0 片段,实际 ${r.items.length}`);
  });

  await it('无关键词但语气低落的句子要被捞到', async () => {
    const msgs = [{ role: 'user', content: '感觉自己像个空壳,一天就这么晃过去了' }];
    const r = await run(msgs);
    assert.strictEqual(r.crisis, false);
    assert.ok(r.items.length >= 1, '低落句应至少产出一条片段');
    assert.ok(r.items.some(i => i.dimension === 'PHQ9_item2'),
      '应映射到情绪低落维度 PHQ9_item2');
  });

  await it('明确症状句走词典命中', async () => {
    const msgs = [{ role: 'user', content: '昨晚凌晨三四点就醒,再也睡不着' }];
    const r = await run(msgs);
    assert.ok(r.items.some(i => i.dimension === 'PHQ9_item3'), '应命中睡眠维度');
  });

  await it('危机句被旁路,且不进细筛/不产出可聚合片段', async () => {
    const msgs = [
      { role: 'user', content: '昨晚又没睡好' },              // 本可聚合
      { role: 'user', content: '其实我最近一直在想,不如死掉算了' },
    ];
    const r = await run(msgs);
    assert.strictEqual(r.crisis, true, '必须置危机位');
    assert.strictEqual(r.items.length, 0, '危机时不得产出聚合片段(防止被普通信号淹没)');
  });

  console.log(`extractor: ${pass} passed, ${fail} failed\n`);
  process.exit(fail ? 1 : 0);
})();
