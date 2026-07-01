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

只输出一个 JSON 对象 {"items": [...]},items 每个元素对应一条你判断有情绪指向的片段,字段:
${JSON.stringify(OUTPUT_SCHEMA_HINT, null, 2)}

【判断取向:宁可多虑,不要漏掉苗头】只要一句话流露出朝某个维度的负面苗头——哪怕轻微、含蓄、只是语气不对劲——就为它产出一条,并用 confidence 如实表达你的把握(没把握就给低分,比如 0.3-0.5),而不是因为"不够明显"就丢掉。真正中性、事务性、无关的闲聊(天气、吃饭、物流)才返回空。宁可标一条低置信的信号让后续去权衡,也不要让一个真实的情绪苗头在这里消失。
若读到明确的轻生/自伤/想消失意图,在该元素额外加 "crisis_flag": true(兜底提醒,不替代系统危机判定)。
只输出 JSON,不要 Markdown 代码块,不要解释。`;
  return { system: sys, messages: [{ role: 'user', content: user }] };
}

function SYSTEM_PROMPT(allowedDimensions, dimMeta, timeWindow) {
  const dimList = allowedDimensions.map(d => {
    const m = dimMeta[d] || {};
    const label = typeof m === 'string' ? m : (m.label || '');
    const text = (m && m.text) ? ` —— 量表原意:${m.text}` : '';
    const plain = (m && m.plain_desc) ? `(通俗说:${m.plain_desc})` : '';
    return `- ${d}(${label})${text}${plain}`;
  }).join('\n');
  return `你是一个情绪信号的"映射器",服务于一个心理自评项目的被动分析功能(已获用户知情同意)。
你的任务:把日常聊天里和身心状态有关的片段,对照下面这些真实量表维度,判断它更像哪一个维度的苗头。你不是医生,不下诊断,不算分数。

【时间口径】只关注 ${timeWindow} 内的状态;明显在讲很久以前的事,降低 confidence。

【维度依据来自真实量表(逐字使用其 id,绝不可改写或新造)】
${dimList}

【判断方式:根据量表语义,充分自由地判断,但只在这些维度内】
- 请对照每个维度的"量表原意/通俗说"去理解用户的话,用你的语义判断能力,而不是死抠字面关键词。用户没用任何症状词、只是语气低落或话里有话,也要能读出来。
- 这是被动情绪预警,取向是"宁可多虑不可漏":轻微、含蓄、模糊的负面苗头也值得标一条,把握不足就给低 confidence,由后续环节去权衡,不要在这里就把它丢掉。

【硬规则(自由度的边界,不可越)】
1. dimension 必须与上面某一项逐字一致。你可以自由判断"像不像",但绝不能发明新维度、新分类、新标签——映射不进这些维度的,才留空。
2. intensity_hint(0-3):这句话本身能支撑的强度。0几乎没指向/1轻微一提/2明确具体/3强烈且具体。情绪激动不等于高分,看信息量;宁可给低强度也别漏标。
3. valence:negative=朝症状方向;positive=好转/反向("终于睡好了");ambiguous=反讽、否定、客套("还好啦""没事"),给 ambiguous 并压低 confidence(但仍然标出来,别丢)。
4. confidence(0-1):有多大把握这条映射成立。把握小就给小值(0.3-0.5),这正是"多虑但诚实"的表达方式。
5. evidence 用观察性、非评判措辞复述依据(如"提到又要上班又要考试、觉得动不了"),禁止"抑郁""焦虑症""病""障碍"等诊断词,也不要给建议。

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
