// src/server.js
const express = require('express');
const path = require('path');
const { loadScale } = require('./scales');
const { initState } = require('./state');
const config = require('./config');
const { processTurn, startSession } = require('./engine');
const { deepseekMap, deepseekAdvice, deepseekReply } = require('./llmDeepSeek');
const { stubMap } = require('./llmStub');
const dailyRoutes = require('./daily/routes'); // 新增:被动日报路由

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public')));

const sessions = new Map();

// ---- 模式判定 ----
const RAW_KEY = process.env.DEEPSEEK_API_KEY || '';
const KEY = RAW_KEY.trim();
const USE_DEEPSEEK = !!KEY;
const MODE = USE_DEEPSEEK ? 'DeepSeek' : 'stub';



// 启动诊断：把 key 读取情况打印出来，方便排查“为什么还是 stub”
console.log('--------------------------------------------------');
console.log(`[模式] ${MODE}`);
if (USE_DEEPSEEK) {
  // 只打印前缀和长度，不泄露完整 key
  console.log(`[诊断] 已读到 DEEPSEEK_API_KEY，前缀=${KEY.slice(0, 5)}... 长度=${KEY.length}`);
} else {
  console.log('[诊断] 未读到 DEEPSEEK_API_KEY（当前窗口环境变量为空）');
  console.log('       CMD  设置：set DEEPSEEK_API_KEY=sk-你的key');
  console.log('       PS   设置：$env:DEEPSEEK_API_KEY="sk-你的key"');
  console.log('       注意：必须在“同一个窗口”先 set 再 node，换窗口会失效。');
}
console.log('--------------------------------------------------');

// 统一描述当前模式，给前端用
function modeInfo() {
  return {
    mode: MODE,                       // 'DeepSeek' | 'stub'
    use_deepseek: USE_DEEPSEEK,
    note: USE_DEEPSEEK
      ? '已接入 DeepSeek，可用自然语言作答。'
      : '当前为本地 stub 模式（未检测到 API key），请用数字作答；自然语言无法被理解。',
  };
}

// ---- 新增:今日小结(被动分析)路由 ----
app.use('/api/daily', dailyRoutes({ useDeepseek: USE_DEEPSEEK }));

// ---- 健康检查：前端可随时查当前模式 ----
app.get('/api/health', (req, res) => {
  res.json(modeInfo());
});

// ---- 建会话 ----
app.post('/api/session', (req, res) => {
  const scaleId = (req.body && req.body.scale_id) || config.session.active_scale_id;
  let scale;
  try { scale = loadScale(scaleId); }
  catch (e) { return res.status(400).json({ error: `量表加载失败: ${e.message}` }); }

  const ctx = {
    scale, config,
    state: initState(scale, config),
    mapFn: USE_DEEPSEEK ? deepseekMap : stubMap,
    replyFn:  USE_DEEPSEEK ? deepseekReply  : undefined,   // ← 新增
    adviceFn: USE_DEEPSEEK ? deepseekAdvice : undefined,
  };
  sessions.set(ctx.state.session_id, ctx);
  const first = startSession(ctx);
  res.json({
    session_id: ctx.state.session_id,
    scale_name: scale.meta.scale_name,
    status: ctx.state.status,
    reply: first.reply,
    total_items: scale.meta.total_items,
    ...modeInfo(),                    // ← 把模式带给前端
  });
});

// ---- 提交一轮 ----
app.post('/api/session/:id/turn', async (req, res) => {
  const ctx = sessions.get(req.params.id);
  if (!ctx) return res.status(404).json({ error: '会话不存在或已过期' });
  const text = (req.body && req.body.text) || '';
  if (!String(text).trim()) return res.status(400).json({ error: '输入为空' });
  try {
    const r = await processTurn(ctx, String(text));
    res.json({
      reply: r.reply,
      status: r.status,
      reason: r.reason || null,
      answered_count: ctx.state.answered_count,
      total_items: ctx.scale.meta.total_items,
      score_result: ctx.state.status === 'completed' ? ctx.state.score_result : null,
      mode: MODE,
    });
  } catch (e) {
    console.error('[turn 出错]', e);
    // 区分 DeepSeek 调用失败的常见原因，回传给网页显示
    let hint = '服务器内部错误';
    const msg = String(e && e.message || e);
    if (/401|unauthor|invalid.*key|api key/i.test(msg)) {
      hint = 'DeepSeek 鉴权失败：API key 无效或拼写有误。';
    } else if (/402|insufficient|balance/i.test(msg)) {
      hint = 'DeepSeek 账户额度不足，请前往平台充值。';
    } else if (/429|rate/i.test(msg)) {
      hint = 'DeepSeek 请求过于频繁（429），请稍后再试。';
    } else if (/timeout|ETIMEDOUT|ECONNRESET|ENOTFOUND|network|fetch failed/i.test(msg)) {
      hint = '无法连接 DeepSeek 服务器：请检查网络或代理设置。';
    }
    res.status(500).json({ error: hint, mode: MODE, detail: msg });
  }
});

// ---- 查状态 ----
app.get('/api/session/:id', (req, res) => {
  const ctx = sessions.get(req.params.id);
  if (!ctx) return res.status(404).json({ error: '会话不存在' });
  res.json({
    session_id: ctx.state.session_id,
    status: ctx.state.status,
    answered_count: ctx.state.answered_count,
    total_items: ctx.scale.meta.total_items,
    score_result: ctx.state.score_result,
    mode: MODE,
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`psych-assess → http://localhost:${PORT}`));