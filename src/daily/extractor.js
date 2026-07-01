// src/daily/extractor.js
// 管线:1 危机硬旁路(最高优先级,确定性,在 LLM 之前)→ 2 送审(几乎全部 user 发言)→ 3 LLM 细筛。
// 设计取向:日常检测宁可多虑,不漏苗头 —— 不再用关键词门卡在 LLM 前面。
//   词典只当"先验提示",不再决定一句话能不能被 LLM 看到。真正的判断交给 LLM,依据是真实量表题目。
// 产出: { items:[结构化片段], crisis:bool, candidates:[送审片段], skipped_clean:bool }

// 唯一保留的确定性关卡:危机。命中即旁路,绝不进聚合。它是安全底线(floor),LLM 只能在其上加判、不能减判。
const CRISIS_REGEX = /想死|不想活|不想活了|自杀|结束生命|活着没意思|活着没意义|轻生|了结自己|不想醒来?|消失算了|不如死/;

// 纯填充/无内容的口水词,送 LLM 也只会空手而归,过滤掉只为省 token —— 绝不过滤任何可能带情绪的话。
const FILLER_ONLY = /^(?:嗯+|哦+|噢+|额+|呃+|好+的?|行+|在+|ok|okay|哈+|嘿+|嗯呐|收到|了解|明白|谢谢?|。+|，+|,+|\.+|~+|\?+|？+|!+|！+)$/i;

function splitUtterances(messages) {
  return (messages || [])
    .filter(m => m && m.role === 'user' && String(m.content || '').trim())
    .map(m => ({ text: String(m.content).trim(), ts: m.ts || null }));
}

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
function coarseHits(text, dict) {
  const hits = [];
  for (const sig of dict) if (sig.re.test(text)) hits.push(sig.dimension);
  return [...new Set(hits)];
}

// 给每个维度装上"真实量表语义"(题目原文 + 大白话),让 LLM 拿着量表判断,而不是对着一个标签猜。
function buildDimMeta(signals, scalesById) {
  const meta = {};
  for (const [dim, v] of Object.entries((signals && signals.dimensions) || {})) {
    const scale = scalesById && scalesById[v.scale];
    const item = scale && (scale.items || []).find(it => String(it.item_id) === String(v.item_id));
    meta[dim] = {
      label: v.label || dim,
      text: (item && item.text) || v.scale_item_text || '',
      plain_desc: (item && item.plain_desc) || '',
    };
  }
  return meta;
}

/**
 * @param {Object} p
 * @param {Array}    p.messages     会话消息
 * @param {Object}   p.signals      signals.json
 * @param {Object}   [p.scalesById] { PHQ9, GAD7 } 真实量表,用来给 LLM 提供题目语义
 * @param {Function} p.mapFn        细筛实现(deepseekDailyMap | stubDailyMap)
 * @param {Object}   [p.config]
 */
async function extract({ messages, signals, scalesById, mapFn, config }) {
  const utterances = splitUtterances(messages);
  const dict = flattenSignals(signals);
  const allowedDimensions = Object.keys(signals.dimensions || {});
  const dimMeta = buildDimMeta(signals, scalesById);

  // ---- 1 危机硬旁路:先于一切。命中立即返回,不送细筛、不进聚合 ----
  for (const u of utterances) {
    if (CRISIS_REGEX.test(u.text)) {
      return { items: [], crisis: true, crisis_snippet: u.text.slice(0, 200),
        candidates: [], skipped_clean: false };
    }
  }

  // ---- 2 送审:除纯口水词外,全部 user 发言都交给 LLM 判断(不再用关键词门筛) ----
  const candidates = utterances
    .filter(u => u.text.length >= 2 && !FILLER_ONLY.test(u.text))
    .map(u => ({ text: u.text, ts: u.ts, dict_dims: coarseHits(u.text, dict) })); // dict_dims 仅作先验提示

  if (candidates.length === 0) {
    // 整段都是"嗯/哦/好的"这类无内容 → 无从判断,省一次调用
    return { items: [], crisis: false, candidates: [], skipped_clean: true };
  }

  // ---- 3 LLM 细筛(依据真实量表语义,倾向捕捉而非漏掉) ----
  const { items, crisis } = await mapFn({
    snippets: candidates.map(c => c.text),
    allowedDimensions, dimMeta, signals,
    timeWindow: (config && config.time_window_label) || '最近两周',
  });

  const tsByText = new Map(candidates.map(c => [c.text, c.ts]));
  for (const it of (items || [])) if (!it.ts) it.ts = tsByText.get(it.snippet) || null;

  return { items: items || [], crisis: !!crisis, candidates, skipped_clean: false };
}

module.exports = { extract, CRISIS_REGEX, splitUtterances, flattenSignals, buildDimMeta };
