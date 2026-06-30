// src/daily/mapper.js
// LLM 细筛 prompt 构造 + 输出严格校验。把 extractor 的候选片段映射成结构化结果:
//   { snippet, dimension, valence, intensity_hint, confidence, evidence }
// 不调用 LLM(交给 llmDaily),不判分(交给 aggregator/softScore),
// 不做危机权威判定(crisis 由 extractor 的确定性旁路在 LLM 之前先扫一遍)。

const OUTPUT_SCHEMA_HINT = {
  snippet: '原话(尽量保留用户原措辞,可裁到最相关的一两句)',
  dimension: '必须从 allowed_dimensions 里逐字选一个;选不出就丢弃该片段',
  valence: 'negative | positive | ambiguous',
  intensity_hint: '0-3 整数:仅这一句话本身能支撑的强度,不是当天结论',
  confidence: '0-1 小数:这条映射有多可信',
  evidence: '一句话说明依据,用观察性措辞,禁止诊断词',
};

function buildMapperMessages({ allowedDimensions, snippets, dimMeta = {}, timeWindow = '最近两周' }) {
  if (!Array.isArray(allowedDimensions) || allowedDimensions.length === 0)
    throw new Error('mapper: allowedDimensions 不能为空,必须从 signals.json 注入真实维度 id');
  const sys = SYSTEM_PROMPT(allowedDimensions, dimMeta, timeWindow);
  if (!Array.isArray(snippets) || snippets.length === 0) return { system: sys, messages: [] };

  const numbered = snippets.map((s, i) => `${i + 1}. ${oneLine(s)}`).join('\n');
  const user =
`下面是从今天对话里粗筛出的候选片段,逐条判断并映射。

候选片段:
${numbered}

只输出一个 JSON 对象 {"items": [...]},items 每个元素对应一条你能可信映射的片段,字段:
${JSON.stringify(OUTPUT_SCHEMA_HINT, null, 2)}

若某片段映射不到 allowed_dimensions,就不要为它产出元素(宁缺毋滥,无关闲聊应返回空数组)。
若读到明确的轻生/自伤/想消失意图,在该元素额外加 "crisis_flag": true(兜底提醒,不替代系统危机判定)。
只输出 JSON,不要 Markdown 代码块,不要解释。`;
  return { system: sys, messages: [{ role: 'user', content: user }] };
}

function SYSTEM_PROMPT(allowedDimensions, dimMeta, timeWindow) {
  const dimList = allowedDimensions
    .map(d => `- ${d}${dimMeta[d] ? `(${dimMeta[d]})` : ''}`)
    .join('\n');
  return `你是一个情绪信号的"映射器",服务于一个心理自评项目的被动分析功能(已获用户知情同意)。
你的唯一任务:把日常聊天里和身心状态有关的片段,映射到给定的量表维度上。你不是医生,不下诊断,不算分数。

【时间口径】只关注 ${timeWindow} 内的状态;明显在讲很久以前的事,降低 confidence。

【允许的维度 allowed_dimensions(只能逐字挑选,绝不可改写或新造)】
${dimList}

【硬规则】
1. dimension 必须与上面某一项逐字一致;映射不到就丢弃,绝不凑数。一句话同时含两个清晰维度可拆成两条。
2. 严禁发明新维度、新分类、新标签。
3. intensity_hint(0-3)只反映"这一句话本身"能支撑的强度:0几乎没指向/1轻微一提/2明确具体/3强烈且具体。情绪激动不等于高分,看信息量。
4. valence:negative=朝症状方向;positive=好转/反向("终于睡好了");ambiguous=反讽、否定、客套("还好啦""没事"),给 ambiguous 并压低 confidence。
5. confidence(0-1):措辞越具体越贴近维度越高;靠猜的压到 0.4 以下。
6. evidence 用观察性、非评判措辞复述依据(如"提到凌晨醒、睡不回去"),禁止"抑郁""焦虑症""病""障碍"等诊断词,也不要给建议。

【危机兜底】若含明确轻生/自伤/想消失意图,加 "crisis_flag": true。这只是冗余提醒;真正处置由系统确定性通道在你之前已对原文跑过,你的标记只会促成额外干预,不会让系统少做任何事。

只输出 JSON,不要任何额外文字。`;
}

const VALID_VALENCE = new Set(['negative', 'positive', 'ambiguous']);

// 解析并严格校验 LLM 输出;脏数据丢弃而非猜补。允许 {items:[...]} 或裸数组。
function parseMapperOutput(raw, allowedDimensions) {
  const allow = new Set(allowedDimensions);
  let obj;
  try { obj = JSON.parse(stripFences(raw)); }
  catch (_) { return { items: [], crisis: false, dropped: 0, parseError: true }; }

  let arr = Array.isArray(obj) ? obj : (obj && Array.isArray(obj.items) ? obj.items : [obj]);
  let crisis = false, dropped = 0;
  const items = [];
  for (const o of arr) {
    if (o && o.crisis_flag === true) crisis = true;        // 任一条喊危机即置位
    if (!o || typeof o !== 'object') { dropped++; continue; }
    if (!allow.has(o.dimension)) { dropped++; continue; }  // 越界维度直接丢
    if (!VALID_VALENCE.has(o.valence)) { dropped++; continue; }
    items.push({
      snippet: String(o.snippet || '').slice(0, 200),
      dimension: o.dimension,
      valence: o.valence,
      intensity_hint: clampInt(o.intensity_hint, 0, 3),
      confidence: clampFloat(o.confidence, 0, 1),
      evidence: String(o.evidence || '').slice(0, 200),
    });
  }
  return { items, crisis, dropped };
}

function oneLine(s) { return String(s).replace(/\s+/g, ' ').trim(); }
function stripFences(t) { return String(t).replace(/```(?:json)?/gi, '').trim(); }
function clampInt(v, lo, hi) { const n = Math.round(Number(v)); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : lo; }
function clampFloat(v, lo, hi) { const n = Number(v); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : lo; }

module.exports = { buildMapperMessages, parseMapperOutput, OUTPUT_SCHEMA_HINT };
