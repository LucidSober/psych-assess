// DeepSeek 适配器：OpenAI 兼容协议。Node 18+ 自带全局 fetch，无需 SDK。
// key 走环境变量 DEEPSEEK_API_KEY，绝不写进代码。
const DEEPSEEK_URL = 'https://api.deepseek.com/chat/completions';
const MODEL = 'deepseek-chat';

// 自由文本危机正则：模型只能在此基础上「加判」，不能「减判」，漏判锁死在安全侧
const CRISIS_REGEX = /想死|不想活|不想活了|自杀|结束生命|活着没意思|轻生|了结自己/;

function currentItem(ctx) {
  const pid = String(ctx.state.pending_item);
  return ctx.scale.items.find(it => String(it.item_id) === pid);
}

function optionLines(item, scale) {
  const anchor = scale && scale.option_frequency_anchor;
  return item.options
    .map(o => `${o.option_no}=${(anchor && anchor[String(o.option_no)]) || o.label || ''}`)
    .join('；');
}

// 把当前题目的“三档生活化描述”准备好，供共情引导时让用户对号入座。
// 文案优先取量表自带的 handling_uncertainty.mapping_hint 的键，没有就用通用兜底。
function threeTierHint(scale) {
  const keys = scale && scale.interaction_style
    && scale.interaction_style.handling_uncertainty
    && scale.interaction_style.handling_uncertainty.mapping_hint
    ? Object.keys(scale.interaction_style.handling_uncertainty.mapping_hint)
    : null;
  if (keys && keys.length >= 2) return keys.join(' / ');
  return '最近基本天天都这样 / 只在特别累或某些特定时候才这样 / 几乎没有';
}

async function callDeepSeek(messages, { timeoutMs = 15000, json = true, temperature } = {}) {
  const key = process.env.DEEPSEEK_API_KEY;
  if (!key) throw new Error('DEEPSEEK_API_KEY 未设置');
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(DEEPSEEK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model: MODEL,
        messages,
        temperature: temperature ?? (json ? 0 : 0.6),
        ...(json ? { response_format: { type: 'json_object' } } : {}),
      }),
      signal: ac.signal,
    });
    if (!res.ok) throw new Error(`DeepSeek HTTP ${res.status}`);
    const data = await res.json();
    return (data.choices && data.choices[0] && data.choices[0].message.content) || '';
  } finally {
    clearTimeout(timer);
  }
}

// ---------- 输入侧：语义映射（替换 stubMap） ----------
// 这一层必须严格、机械、只输出 JSON —— 它是状态机的“传感器”，不是聊天者，自主权一律不给。
async function deepseekMap(ctx, raw) {
  const text = String(raw).trim();
  const pending = String(ctx.state.pending_item);
  const item = currentItem(ctx);
  const maxNo = item ? item.options.length : 4;

  // 任何失败都降级到这个安全默认：option_no=null + confidence=0 → 触发引导，绝不崩
  const fallback = {
    item_id: pending,
    option_no: null,
    confidence: 0,
    crisis_signal: CRISIS_REGEX.test(text),
    amend_target_item_id: null,
    evidence: text.slice(0, 200),
  };

  let parsed;
  try {
    const sys = [
      '你是心理量表测评的语义映射器，唯一任务是把用户的自由回答映射到当前题目的选项编号并评估置信度。',
      '严格只输出 JSON，字段如下：',
      `{"option_no": 1到${maxNo}的整数或null, "confidence": 0到1的小数, "crisis_signal": 布尔, "amend_target_item_id": 题号字符串或null, "evidence": "用户原话摘要"}`,
      '规则：',
      '- option_no：能明确对应某频率选项时给编号；模糊、答非所问、说“不知道/说不清/还好吧”等无法判断时给 null。',
      '- confidence：映射把握程度，不确定时给低值（<0.5）。',
      '- crisis_signal：用户表达自杀/自伤/不想活等危机信号时 true，否则 false。',
      '- amend_target_item_id：用户明确想修改之前第N题时填该题号字符串（如"3"），否则 null。',
    ].join('\n');
    const user = [
      `当前题目(第${pending}题)：${item ? item.text : ''}`,
      `选项：${item ? optionLines(item, ctx.scale) : ''}`,
      `用户回答："${text}"`,
    ].join('\n');

    const content = await callDeepSeek(
      [{ role: 'system', content: sys }, { role: 'user', content: user }],
      { timeoutMs: 15000, json: true }
    );
    parsed = JSON.parse(content);
  } catch (e) {
    console.warn(`[deepseekMap] 降级(${e.message})`);
    return fallback;
  }

  // 清洗 + 夹紧，把不可信输入挡在状态机之外
  let option_no = parsed.option_no == null ? null : Number(parsed.option_no);
  if (option_no !== null && !(Number.isInteger(option_no) && option_no >= 1 && option_no <= maxNo))
    option_no = null; // 越界视作无法判断，走引导而非直接 handoff

  let confidence = Number(parsed.confidence);
  if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) confidence = 0;
  if (option_no === null) confidence = Math.min(confidence, 0.3); // null 不允许高置信

  let amend = parsed.amend_target_item_id;
  amend = amend == null ? null : String(amend);
  if (amend && !ctx.scale.items.some(it => String(it.item_id) === amend)) amend = null;

  return {
    item_id: pending,
    option_no,
    confidence,
    crisis_signal: fallback.crisis_signal || parsed.crisis_signal === true, // 正则兜底
    amend_target_item_id: amend,
    evidence: (typeof parsed.evidence === 'string' && parsed.evidence) || text.slice(0, 200),
  };
}

// ---------- 输出侧：advice 共情包装（注入 ctx.adviceFn） ----------
async function deepseekAdvice(ctx, r) {
  const sys = [
    '你是温暖的心理测评结果陪伴者。请把给定的「建议原文」改写得更温暖、口语化、有共情。',
    '严格要求：',
    '- 不得改变、不得提及任何分数或数字。',
    '- 不得做医学诊断，不得断言病情。',
    '- 适当解释问题，通俗易懂。',
    '- 输出纯文本，不超过120字。',
  ].join('\n');
  const user = `严重程度：${r.severity_label}\n建议原文：${r.advice}`;
  const content = await callDeepSeek(
    [{ role: 'system', content: sys }, { role: 'user', content: user }],
    { timeoutMs: 15000, json: false }
  );
  return content.trim(); // 失败时 buildReport 已 catch，回退原文
}

// ---------- 输出侧：共情对话生成 ----------
// 设计原则：engine 只告诉模型「此刻要达成的沟通目标」(coreNeed) 和「处于什么情境」(type)，
// 至于“用什么语气、怎么共情、怎么把人请回来”，全部交给模型自己判断 —— 这是它的主场。
// 只有三条红线写死：不诊断、不提分数/题号/选项、不扩展到题目之外的症状。
async function deepseekReply(ctx, situation) {
  // situation: { type, userText, coreNeed, prevAssistant? }
  const item = currentItem(ctx);
  const tiers = threeTierHint(ctx.scale);

  const sys = [
    '你是一位真正在“陪着”用户做情绪自评的伙伴，不是照本宣科的客服。',
    '请像一个有经验、有温度的倾听者那样自然地说话：先接住用户此刻的情绪或困惑，再不着痕迹地把对话带回我们想了解的方向。',
    '',
    '你拥有充分的表达自主权：',
    '- 语气、用词、长短、要不要举例子、要不要先聊两句再问，都由你根据当下氛围自己拿捏。',
    '- 用户的说法可以用你自己的话复述、打比方、举贴近生活的例子，怎么让他听懂、放松，你说了算。',
    '- 不必每次都套同样的句式；该简短时简短，该多陪一句时就多陪一句（但整体别啰嗦，通常2到4句、120字内）。',
    '',
    '只有三条红线绝对不可碰：',
    '- 不做任何诊断、不下任何结论、不评判用户。',
    '- 绝不出现“第几题”“选项”“计分”“分数”“量表”这类字眼，让它像聊天而不是考试。',
    '- 不要询问“需要了解的内容”之外的其他症状，也不要扩大话题范围。',
    '',
    '一个重要原则：当用户说“不知道/说不清/还好吧/差不多”这类答不上来的话时，',
    '千万不要逼他给天数、给频率、给数字 —— 这只会让他更慌。',
    '正确做法是：先告诉他“这种感觉本来就不好说清，很正常”，',
    '再用大白话把那种状态描述出来帮他对号入座，',
    '最后给他几档好懂的程度去挑，让他选个最接近的就行，并强调没有对错。',
    '',
    '输出纯文本，不要 JSON、不要用引号把整段话包起来。',
  ].join('\n');

  // 情境说明：只给“方向性”的描述，不再写死“问几天/多频繁”这类会带偏模型的话。
  const map = {
    followup:
      '用户的回答还落不到一个明确的程度上。请别追问“几天/几次/多频繁”这类数字，'
      + '而是先轻轻接住他（“这种感觉确实不太好说清”），'
      + '再用大白话把这道题想了解的那种状态描述一遍帮他对号入座，'
      + `最后给他几档生活化的程度去挑，比如：「${tiers}」，挑个最接近的就好，告诉他没有对错。`,
    clarify_offtopic:
      '用户答非所问，或在质疑这个测评有没有用。先真诚理解他的情绪和顾虑，'
      + '再用轻松的方式把他请回我们正在聊的话题，别让他觉得被纠正。',
    clarify_emotion:
      '用户有点烦躁或抗拒。先安抚情绪、明确表示不催他、慢慢来都行，'
      + '等他松一点了，再轻轻把话题带回来。',
    explain_item:
      '用户没看懂这道题在问什么。用一句最接地气的大白话解释清楚它到底想了解什么，'
      + '可以举个贴近生活的小例子，然后自然地把这个问题重新问一遍。不要追问几天/几次/多频繁。',
    ack_skip:
      '用户表示这道题的情境对他不适用。温和地表示“这条用不上、先跳过，完全不影响”，'
      + '可以灵活措辞，然后自然过渡到下一个话题。注意人称别搞混，别生硬。',
  };

  const parts = [
    `用户刚才说："${situation.userText}"`,
    `需要了解的内容：${situation.coreNeed}`,
    `情境说明：${map[situation.type] || map.followup}`,
  ];
  // 把当前题目的大白话描述也喂给模型，方便它“对号入座”时说得准。
  if (item && item.plain_desc) parts.push(`（这道题其实想了解的是：${item.plain_desc}）`);
  if (situation.prevAssistant) parts.push(`你上一句已经说过："${situation.prevAssistant}"，这次别重复。`);
  const user = parts.join('\n');

  // 温度调高一点，让它说话更像人、更有弹性；失败由 engine 侧 catch 降级到写死文案。
  const content = await callDeepSeek(
    [{ role: 'system', content: sys }, { role: 'user', content: user }],
    { timeoutMs: 12000, json: false, temperature: 0.7 }
  );
  return content.trim();
}

module.exports = { deepseekMap, deepseekAdvice, deepseekReply, callDeepSeek };
