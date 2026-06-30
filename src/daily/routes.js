// src/daily/routes.js
// 挂到老 server 上的路由:POST /api/daily/report
// 用法(在 server.js 里):
//   const dailyRoutes = require('./daily/routes');
//   app.use('/api/daily', dailyRoutes({ useDeepseek: USE_DEEPSEEK }));
const express = require('express');
const { runDailyReview } = require('./index');
const { deepseekDailyMap, stubDailyMap, deepseekDailyReply, cannedDailyReply, CRISIS_REGEX } = require('./llmDaily');
const { CRISIS_REPLY } = require('./reporter');

module.exports = function dailyRoutes({ useDeepseek = false } = {}) {
  const router = express.Router();
  const mapFn = useDeepseek ? deepseekDailyMap : stubDailyMap;

  router.get('/health', (req, res) => {
    res.json({ feature: 'daily-review', mode: useDeepseek ? 'DeepSeek' : 'stub' });
  });

  // body: { messages:[{role,content}] } —— 自由聊的实时共情回应(走真 DeepSeek)
  // 安全:本轮先用确定性正则拦危机,命中直接回危机话术,不交给 LLM。
  router.post('/reply', async (req, res) => {
    const { messages } = req.body || {};
    if (!Array.isArray(messages) || messages.length === 0)
      return res.status(400).json({ error: 'messages 必须是非空数组' });
    const lastUser = [...messages].reverse().find(m => m && m.role === 'user');
    if (lastUser && CRISIS_REGEX.test(String(lastUser.content))) {
      return res.json({ crisis: true, reply: CRISIS_REPLY });
    }
    try {
      const reply = useDeepseek ? await deepseekDailyReply(messages) : cannedDailyReply();
      res.json({ crisis: false, reply: reply || cannedDailyReply() });
    } catch (e) {
      console.warn('[daily/reply] 降级:', e.message);
      res.json({ crisis: false, reply: cannedDailyReply() }); // 永不崩
    }
  });

  // body: { messages:[{role,content,ts?}], consent:bool }
  router.post('/report', async (req, res) => {
    const { messages, consent } = req.body || {};
    if (!Array.isArray(messages))
      return res.status(400).json({ error: 'messages 必须是数组' });
    if (consent !== true)
      return res.status(403).json({ error: 'need_consent', status: 'no_consent',
        report: { text: '被动情绪分析需要你先同意开启。' } });
    try {
      const out = await runDailyReview(messages, { mapFn, consent: true });
      // 只把给用户看的部分回出去;profile/soft 是内部量,默认不外泄
      res.json({
        status: out.status,
        crisis: out.crisis,
        report: {
          text: out.report.text,
          sections: out.report.sections || null,
          recommendations: out.report.recommendations || [],
        },
      });
    } catch (e) {
      console.error('[daily/report]', e);
      res.status(500).json({ error: '生成日报失败', detail: String(e && e.message || e) });
    }
  });

  return router;
};
