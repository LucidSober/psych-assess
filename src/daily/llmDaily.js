// src/daily/llmDaily.js
// 给 extractor 用的"细筛"实现。两套同签名:
//   deepseekDailyMap —— 真·LLM,复用 llmDeepSeek 的 callDeepSeek + mapper 的 prompt。
//   stubDailyMap     —— 离线启发式,无 key 也能跑测试/demo。它只是 LLM 的廉价替身。
// 签名: async ({ snippets, allowedDimensions, dimMeta, signals, timeWindow }) => { items, crisis }

const { buildMapperMessages, parseMapperOutput } = require('./mapper');

// 与 llmDeepSeek 同款危机正则:细筛只能"加判",这里只作冗余兜底,真正旁路在 extractor。
const CRISIS_REGEX = /想死|不想活|不想活了|自杀|结束生命|活着没意思|活着没意义|轻生|了结自己|不想醒|消失算了/;

// ---------- 真·LLM ----------
async function deepseekDailyMap({ snippets, allowedDimensions, dimMeta, signals, timeWindow }) {
  const { callDeepSeek } = require('../llmDeepSeek');
  const { system, messages } = buildMapperMessages({ allowedDimensions, snippets, dimMeta, timeWindow });
  if (messages.length === 0) return { items: [], crisis: false };
  let content = '';
  try {
    content = await callDeepSeek([{ role: 'system', content: system }, ...messages],
      { timeoutMs: 15000, json: true });
  } catch (e) {
    // 失败不清零:退回词典/语气的启发式召回,至少别把苗头全丢了(取向:宁可多虑)。危机正则仍兜底。
    console.warn(`[deepseekDailyMap] 降级到启发式召回(${e.message})`);
    const fb = await stubDailyMap({ snippets, allowedDimensions, signals });
    fb.crisis = fb.crisis || snippets.some(s => CRISIS_REGEX.test(s));
    return fb;
  }
  const out = parseMapperOutput(content, allowedDimensions);
  out.crisis = out.crisis || snippets.some(s => CRISIS_REGEX.test(s));
  return out;
}

// ---------- 离线启发式替身 ----------
// 仅供无 DeepSeek 时跑测试/demo。能力弱于真 LLM,但覆盖两件事:
//  1) 词典命中 → 结构化;2) 无关键词但语气低落/焦虑的句子 → 也能捞到(模拟 LLM 的语气判断)。
const TONE_LEXICON = [
  // [正则, 维度, valence, intensity, evidence]
  [/(空壳|行尸走肉|没有灵魂|像个机器)/, 'PHQ9_item2', 'negative', 2, '描述空洞/抽离感'],
  [/(撑不住|扛不住|快崩溃|绷不住|顶不住)/, 'PHQ9_item2', 'negative', 3, '描述濒临崩溃'],
  [/(活着.*(没意义|没意思|累)|没什么意思)/, 'PHQ9_item2', 'negative', 3, '描述意义感丧失'],
  [/(内耗|精神内耗|被生活推着走)/, 'PHQ9_item2', 'negative', 2, '描述持续消耗/心累'],
  [/(没动力|丧失.{0,2}动力|提不起动力|不想动|动不了)/, 'PHQ9_item1', 'negative', 2, '描述动力缺失'],
  [/(不想上班|不想上学|不想去公司)/, 'PHQ9_item1', 'negative', 1, '描述回避/提不起劲'],
  [/(喘不过气|心口压|胸口闷|提着一口气)/, 'GAD7_item1', 'negative', 2, '描述躯体化焦虑'],
  [/(一整天.*(就这么|晃|耗)|什么都没做成)/, 'PHQ9_item4', 'negative', 1, '描述空耗/无力'],
  [/(谁都不想理|不想见人|把自己关)/, 'PHQ9_item1', 'negative', 2, '描述社交退缩'],
];

async function stubDailyMap({ snippets, allowedDimensions, signals }) {
  const allow = new Set(allowedDimensions);
  const items = [];
  let crisis = false;
  const dict = flattenSignals(signals);

  for (const snip of snippets) {
    const text = String(snip);
    if (CRISIS_REGEX.test(text)) crisis = true;

    let matched = false;
    // 1) 词典命中
    for (const sig of dict) {
      if (!allow.has(sig.dimension)) continue;
      if (sig.re.test(text)) {
        items.push({
          snippet: text.slice(0, 200), dimension: sig.dimension, valence: sig.valence,
          intensity_hint: sig.intensity_prior, confidence: 0.75, evidence: sig.evidence_hint,
        });
        matched = true;
        break; // 一句话取最先命中的一个维度,避免一句被重复计
      }
    }
    if (matched) continue;
    // 2) 语气兜底(模拟 LLM:无关键词也能读出低落/焦虑)
    for (const [re, dim, val, inten, ev] of TONE_LEXICON) {
      if (!allow.has(dim)) continue;
      if (re.test(text)) {
        items.push({ snippet: text.slice(0, 200), dimension: dim, valence: val,
          intensity_hint: inten, confidence: 0.6, evidence: ev });
        break;
      }
    }
    // 3) 无关闲聊 → 什么都不产出
  }
  return { items, crisis };
}

// ---------- 自由聊天的共情回应(真·DeepSeek) ----------
// 与问卷里的 deepseekReply 不同:那个绑定"当前题",这里是开放倾听,不往某道题引。
// 复用同一个 callDeepSeek 传输层 + 同一套红线。失败由调用方 catch 降级。
async function deepseekDailyReply(history, { timeoutMs = 12000 } = {}) {
  const { callDeepSeek } = require('../llmDeepSeek');
  const sys = [
    '你是一个温柔、稳定、真诚的倾听者,正陪着用户做一次"今天过得怎么样"的随心聊天(用户已知情同意)。',
    '你的任务是陪伴,不是问卷,也不是客服。像朋友一样自然地接住对方的话。',
    '',
    '怎么说话:',
    '- 先接住用户此刻的情绪或内容,简短回应、让他感到被听见。',
    '- 可以温和地、开放地邀请他多说一点今天的状态——睡得好不好、累不累、心里压着什么,但别审问。',
    '- 通常 2 到 4 句、120 字内;最多问一个开放性的小问题,别连环追问。',
    '- 语气、用词、要不要举例,你自己拿捏。',
    '',
    '绝对红线:',
    '- 不做任何诊断、不下结论、不评判、不贴标签。',
    '- 绝不出现"分数""评分""量表""测评""第几题""选项"这类字眼,这是聊天不是考试。',
    '- 不强迫用户给频率、天数、数字。用户说"说不清/还好吧"时,告诉他这很正常,别逼。',
    '',
    '输出纯文本,不要 JSON,不要用引号把整段话包起来。',
  ].join('\n');

  const trimmed = (history || []).slice(-12).map(m => ({
    role: m.role === 'assistant' ? 'assistant' : 'user',
    content: String(m.content || ''),
  }));
  const content = await callDeepSeek(
    [{ role: 'system', content: sys }, ...trimmed],
    { timeoutMs, json: false, temperature: 0.7 });
  return content.trim();
}

function flattenSignals(signals) {
  const out = [];
  if (!signals || !signals.dimensions) return out;
  for (const [dim, v] of Object.entries(signals.dimensions)) {
    if (v.enabled === false) continue;
    for (const s of v.signals || []) {
      if (s.enabled === false) continue;
      for (const p of s.patterns) {
        out.push({ dimension: dim, re: new RegExp(p, 'iu'), valence: s.valence || v.default_valence,
          intensity_prior: typeof s.intensity_prior === 'number' ? s.intensity_prior : 1,
          evidence_hint: s.evidence_hint || v.label || '' });
      }
    }
  }
  return out;
}

// ---------- 自由聊的共情回应(真 DeepSeek) ----------
// 与问卷版 deepseekReply 不同:这里是"开放陪伴",不把话头往某道题上引,也没有 scale 上下文。
// 三条红线照搬房规:不诊断、不提分数/题号/选项/量表、不盘问题目之外的症状。
async function deepseekDailyReply(messages) {
  const { callDeepSeek } = require('../llmDeepSeek');
  const sys = [
    '你是在"陪着"用户聊今天过得怎么样的伙伴,不是医生,也不是在做问卷。',
    '像一个真诚、有温度的倾听者那样自然说话:先接住用户此刻的情绪,再轻轻邀请他多说一点。',
    '语气、长短自己拿捏,通常 1 到 3 句、80 字内,别啰嗦,别每次都同一个句式。',
    '三条红线绝不可碰:',
    '- 不做任何诊断、不下结论、不评判;',
    '- 绝不出现"分数""题""选项""量表""评分"这类字眼;',
    '- 不追问题目式的症状清单,不逼用户给频率或天数。',
    '另外:接住情绪即可,不要反复放大或咀嚼负面感受,也不要强行打鸡血。',
    '输出纯文本,不要 JSON,不要用引号把整段包起来。',
  ].join('\n');
  const recent = (messages || []).slice(-8)
    .map(m => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: String(m.content) }));
  const content = await callDeepSeek(
    [{ role: 'system', content: sys }, ...recent],
    { timeoutMs: 12000, json: false, temperature: 0.7 });
  return content.trim();
}

// 无 key / 调用失败时的兜底,保证页面永不卡死(房规:绝不崩)。
const CANNED = ['嗯,我在听。', '谢谢你愿意说这些。', '我记下了,你继续说。', '听起来不容易,辛苦了。'];
function cannedDailyReply() { return CANNED[Math.floor(Math.random() * CANNED.length)]; }

module.exports = { deepseekDailyMap, stubDailyMap, deepseekDailyReply, cannedDailyReply, CRISIS_REGEX };
