// src/deepseek.test.js
const { loadScale } = require('./scales');
const { initState } = require('./state');
const config = require('./config');
const { deepseekMap, deepseekAdvice } = require('./llmDeepSeek');
const { processTurn, startSession } = require('./engine');

const SAS = loadScale('SAS');
(async () => {
  const ctx = { scale: SAS, config, state: initState(SAS, config),
                mapFn: deepseekMap, adviceFn: deepseekAdvice };
  startSession(ctx);
  // 用自然语言答第1题，看模型能否映射
  const r = await processTurn(ctx, '这一周我基本天天都很紧张，几乎没停过');
  console.log('模型映射后系统回复：', r.reply);
  console.log('第1题落库：', ctx.state.answers[0]);
})();