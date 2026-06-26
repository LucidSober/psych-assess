const { loadScale } = require('./scales');
const { initState } = require('./state');
const config = require('./config');
const { stubMap } = require('./llmStub');
const { processTurn, startSession, checkCrisis } = require('./engine');

const SAS = loadScale('SAS');
const mk = () => ({ scale: SAS, config, state: initState(SAS, config), mapFn: stubMap });

(async () => {
  console.assert(SAS.meta.total_items === 20, 'total_items 错');
  console.assert(SAS.crisis_rule === null, 'crisis_rule 应为 null');
  console.log('1 加载 ✓', SAS.meta.scale_name);

  // 全选 option_no=1 → 35 → floor(43.75)=43 → 无焦虑
  const ctx = mk(); startSession(ctx);
  let last;
  for (let i = 0; i < 20; i++) last = await processTurn(ctx, '1');
  console.assert(ctx.state.status === 'completed', '状态错: ' + ctx.state.status);
  console.assert(ctx.state.score_result.raw_score === 35, '粗分错');
  console.assert(ctx.state.score_result.standard_score === 43, '标准分错');
  console.log('2 全1计分 ✓', ctx.state.score_result.severity_label);

  const ctx3 = mk(); startSession(ctx3);
  console.assert(checkCrisis(ctx3, { item_id: '20', option_no: 4, confidence: 1 }) === false,
    'SAS 不应触发结构化危机');
  console.log('3 无结构化危机 ✓');

  console.log('\nSAS 用例通过（离线 stub）');
})();