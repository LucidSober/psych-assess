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
async function deepseekMap(ctx, raw) {
  const text = String(raw).trim();
  const pending = String(ctx.state.pending_item);
  const item = currentItem(ctx);
  const maxNo = item ? item.options.length : 4;

  // 任何失败都降级到这个安全默认：option_no=null + confidence=0 → 触发追问，绝不崩
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
      '- option_no：能明确对应某频率选项时给编号；模糊、答非所问、无法判断时给 null。',
      '- confidence：映射把握程度，不确定时给低值（<0.5）。',
      '- crisis_signal：用户表达自杀/自伤/不想活等危机信号时 true，否则 false。',
      '- amend_target_item_id：用户明确想修改之前第N题时填该题号字符串（如"3"），否则 null。',
      '- 你只做映射，不做诊断、不安慰、不输出选项以外的任何解读。',
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
    option_no = null; // 越界视作无法判断，走追问而非直接 handoff

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
    '- 不得新增原文没有的建议，只软化语气。',
    '- 输出纯文本，2到3句话，不超过120字。',
  ].join('\n');
  const user = `严重程度：${r.severity_label}\n建议原文：${r.advice}`;
  const content = await callDeepSeek(
    [{ role: 'system', content: sys }, { role: 'user', content: user }],
    { timeoutMs: 15000, json: false }
  );
  return content.trim(); // 失败时 buildReport 已 catch，回退原文
}

// ---------- 输出侧：共情对话生成 ----------
// 只负责"怎么说得有人情味"，不负责"问什么"——核心诉求由 engine 传入，模型不得篡改。
async function deepseekReply(ctx, situation) {
  // situation: { type, userText, coreNeed, prevAssistant }
  const sys = [
    '你是一位温暖、耐心的心理测评陪伴者，正在引导用户完成一份情绪自评。',
    '你的任务：先对用户刚才的话做一句简短、真诚的回应（共情或解释），再自然地把对话引导回“需要了解的内容”。',
    '严格规则：',
    '- “需要了解的内容”的含义不可改变、不可扩展，不要询问其他症状。',
    '- 绝对不要提“第几题”“选项”“计分”“分数”这类字眼，让它像聊天而非考试。',
    '- 不做任何诊断、不下结论、如果之前已经安抚过用户情绪，这次不要再重复道歉或"我理解你"，直接给出新的、具体的帮助。',
    '- 语气口语、温柔，1到2句话，总长不超过60字。',
    '- 输出纯文本，不要 JSON、不要引号包裹。',
  ].join('\n');

  const map = {
    followup:       '用户的回答还不够明确，需要温和地了解：这种情况最近一周大概有多频繁（比如大概几天）。',
    clarify_offtopic:'用户答非所问或在质疑测评，需要先理解他的情绪，再温和地把他请回当前话题。',
    clarify_emotion:'用户表现出烦躁或抗拒，需要先安抚情绪，表达不催促，再轻轻引导回当前话题。',
    // ↓↓↓ 新增
    explain_item:   '用户没看懂当前题目的意思。需要用一句大白话解释这道题到底在问什么，然后自然地把问题重新问一遍。绝对不要追问几天/几次/多频繁。',
    ack_skip:       '用户表示当前题目的情境对他不适用。需要温和地表示"这条先跳过、不影响"此类，可酌情变通，然后自然过渡到下一个话题。不要追问、但避免生硬，要注意人称代词，避免混淆。',
  };

  const user = [
    `用户刚才说："${situation.userText}"`,
    `需要了解的内容：${situation.coreNeed}`,
    situation.type !== 'followup' ? `情境说明：${map[situation.type] || ''}` : `情境说明：${map.followup}`,
  ].join('\n');

  // temperature 给一点，让措辞有变化但别太发散；失败由 engine 侧 catch 降级
  const content = await callDeepSeek(
    [{ role: 'system', content: sys }, { role: 'user', content: user }],
    { timeoutMs: 12000, json: false, temperature: 0.6 }
  );
  return content.trim();
}

module.exports = { deepseekMap, deepseekAdvice, deepseekReply, callDeepSeek };

