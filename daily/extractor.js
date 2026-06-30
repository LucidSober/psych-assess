// src/daily/extractor.js
// 1 粗筛(词典/正则)→ 2 危机硬旁路(最高优先级,在 LLM 之前)→ 3 LLM 细筛 → 情绪片段。
// 产出: { items:[结构化片段], crisis:bool, candidates:[送审片段], skipped_clean:bool }

// 与房规一致的危机正则:确定性、不依赖 LLM。命中即旁路,绝不进聚合。
const CRISIS_REGEX = /想死|不想活|不想活了|自杀|结束生命|活着没意思|活着没意义|轻生|了结自己|不想醒来?|消失算了|不如死/;

// 一句话是否"值得送 LLM 细看":命中词典,或带情绪/第一人称信号(让无关键词的低落也有机会)。
const EMOTION_HINT = /(我|自己|心里|感觉|觉得|最近|这几天|今天).{0,12}(累|烦|丧|难受|哭|怕|慌|空|撑|扛|睡|没劲|不想|提不起|崩|堵)|(没意思|无所谓|麻木|焦虑|压抑)/;

function splitUtterances(messages) {
  // messages: [{role:'user'|'assistant', content, ts?}] —— 只看 user。
  return (messages || [])
    .filter(m => m && m.role === 'user' && String(m.content || '').trim())
    .map(m => ({ text: String(m.content).trim(), ts: m.ts || null }));
}

function coarseHits(text, dict) {
  const hits = [];
  for (const sig of dict) if (sig.re.test(text)) hits.push(sig.dimension);
  return [...new Set(hits)];
}

// 把 signals.json 摊平成 [{dimension, re, ...}]
function flattenSignals(signals) {
  const out = [];
  for (const [dim, v] of Object.entries((signals && signals.dimensions) || {})) {
    if (v.enabled === false) continue;
    for (const s of v.signals || []) {
      if (s.enabled === false) continue;
      for (const p of s.patterns) out.push({ dimension: dim, re: new RegExp(p, 'iu') });
    }
  }
  return out;
}

/**
 * @param {Object} p
 * @param {Array}  p.messages   会话消息
 * @param {Object} p.signals    signals.json
 * @param {Function} p.mapFn    细筛实现(deepseekDailyMap | stubDailyMap)
 * @param {Object} [p.config]
 */
async function extract({ messages, signals, mapFn, config }) {
  const utterances = splitUtterances(messages);
  const dict = flattenSignals(signals);
  const allowedDimensions = Object.keys(signals.dimensions || {});
  const dimMeta = Object.fromEntries(
    Object.entries(signals.dimensions || {}).map(([k, v]) => [k, v.label || '']));

  // ---- 2 危机硬旁路:先于一切。命中就立刻返回,不送细筛、不进聚合 ----
  for (const u of utterances) {
    if (CRISIS_REGEX.test(u.text)) {
      return { items: [], crisis: true, crisis_snippet: u.text.slice(0, 200),
        candidates: [], skipped_clean: false };
    }
  }

  // ---- 1 粗筛:挑出"可能有情绪"的句子送审 ----
  const candidates = [];
  for (const u of utterances) {
    const hits = coarseHits(u.text, dict);
    if (hits.length > 0 || EMOTION_HINT.test(u.text)) {
      candidates.push({ text: u.text, ts: u.ts, dict_dims: hits });
    }
  }
  if (candidates.length === 0) {
    // 整段都是无关闲聊 → 直接判定无信号,省一次 LLM 调用
    return { items: [], crisis: false, candidates: [], skipped_clean: true };
  }

  // ---- 3 LLM 细筛 ----
  const { items, crisis } = await mapFn({
    snippets: candidates.map(c => c.text),
    allowedDimensions, dimMeta, signals,
    timeWindow: (config && config.time_window_label) || '最近两周',
  });

  // 给每条片段补上时间戳(从原句回填,聚合算密度要用)
  const tsByText = new Map(candidates.map(c => [c.text, c.ts]));
  for (const it of items) if (!it.ts) it.ts = tsByText.get(it.snippet) || null;

  return { items: items || [], crisis: !!crisis, candidates, skipped_clean: false };
}

module.exports = { extract, CRISIS_REGEX, splitUtterances, flattenSignals };
