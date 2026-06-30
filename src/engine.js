const { scoreScale } = require('./scoring');

// ---------- [GUARD] 输入安全 ----------
const INJECTION_PATTERNS = [
  /ignore\s+(all\s+)?previous/i, /forget\s+(everything|all)/i,
  /system\s+prompt/i, /you\s+are\s+now/i,
  /忽略(以上|前面|之前|上面)/, /你现在(是|扮演)/,
];
const detectInjection = t => INJECTION_PATTERNS.some(re => re.test(t));

// 用户"没看懂题意"（要解释，而不是要追问频率）
const CONFUSED_PATTERNS = [
  /什么意思/, /没听懂/, /听不懂/, /看不懂/, /无法理解/,
  /不(明白|理解|懂)/, /这是什么(感受|意思)/,
];
const detectConfused = t => CONFUSED_PATTERNS.some(re => re.test(t));

// 条件题情境"不适用"（要按中性计分，而不是死追问）
const NA_PATTERNS = [
  /没(有)?接触/, /不适用/, /没这种(情况|经历)/, /用不上/, /没机会/, /没(有)?(对象|异性)/,
];
const detectNotApplicable = t => NA_PATTERNS.some(re => re.test(t));

function guard(ctx, raw) {
  const cfg = ctx.config;
  if (raw.length > cfg.context.max_user_input_chars)
    return { action: 'clarify', reason: 'too_long' };
  if (cfg.security.injection_detection && detectInjection(raw)) {
    if (cfg.security.injection_action === 'reject_and_clarify')
      return { action: 'clarify', reason: 'injection' };
    return { action: 'continue', sanitized: raw.replace(/[<>]/g, '') };
  }
  return { action: 'continue', sanitized: raw };
}

// ---------- [SCHEMA] 校验 ----------
function validateMapped(m, scale, state) {
  if (String(m.item_id) !== String(state.pending_item)) return false;
  if (typeof m.confidence !== 'number' || m.confidence < 0 || m.confidence > 1)
    return false;
  if (m.option_no === null) return true; // null 合法，交 GATE-1 追问
  const item = scale.items.find(it => String(it.item_id) === String(state.pending_item));
  const maxNo = item.options.length;
  return Number.isInteger(m.option_no) && m.option_no >= 1 && m.option_no <= maxNo;
}

// ---------- [CRISIS CHECK] ----------
function checkCrisis(ctx, mapped) {
  const { scale, config } = ctx;
  if (config.crisis.free_text_detection && mapped.crisis_signal) return true;
  if (scale.crisis_rule && config.crisis.structured_trigger_source === 'scale_json') {
    const cid = String(scale.crisis_rule.item_id);
    if (String(mapped.item_id) === cid && mapped.option_no != null && mapped.option_no >= 2)
      return true;
  }
  return false; // SAS 的 crisis_rule=null，结构化永不触发
}

// ---------- 落库 / 推进 ----------
function commitAnswer(ctx, mapped, flagged) {
  const { state } = ctx;
  state.answers.push({
    item_id: String(mapped.item_id),
    option_no: mapped.option_no,
    confidence: mapped.confidence,
    evidence: mapped.evidence || '',
    flagged_low_confidence: flagged,
    followup_used: state._current_followups || 0,
    recorded_at: new Date().toISOString(),
  });
  // 计数一律重算，避免增减错位
  state.answered_count = state.answers.length;
  state.low_confidence_count = state.answers.filter(a => a.flagged_low_confidence).length;
}

function advancePending(ctx) {
  const { state, scale } = ctx;
  const done = new Set(state.answers.map(a => a.item_id));
  const next = scale.items.find(it => !done.has(String(it.item_id)));
  state.pending_item = next ? String(next.item_id) : null;
  state._current_followups = 0;
}

// 取所有被判低置信/存疑的题号（按落库顺序），供终态反馈点名
function flaggedItemIds(state) {
  return state.answers.filter(a => a.flagged_low_confidence).map(a => a.item_id);
}

// ---------- 工具 ----------
function pushHistory(ctx, userMsg, assistantMsg) {
  const h = ctx.state.history;
  h.push({ role: 'user', content: userMsg });
  h.push({ role: 'assistant', content: assistantMsg });
  const max = ctx.config.context.history_window_turns * 2;
  if (h.length > max) ctx.state.history = h.slice(-max);
}

// 通用提问文案：锚点优先级 量表 option_frequency_anchor > 题目 options.label > 序号兜底
function optionHints(item, scale) {
  const anchor = scale && scale.option_frequency_anchor;
  return item.options
    .map(o => {
      const text = (anchor && anchor[String(o.option_no)]) || o.label || '';
      return text ? `${o.option_no}=${text}` : String(o.option_no);
    })
    .join(' ');
}
const askText = (item, scale) => {
  const timeframe = (scale && scale.meta && scale.meta.timeframe) || '最近一周';
  return `${timeframe}里,"${item.text}"这种感受在你身上出现得多吗?可以具体说说。`;
};

const reply = (ctx, msg) => ({ state: ctx.state, reply: msg, status: ctx.state.status });

function terminate(ctx, status, reason, msgOverride) {
  const { state } = ctx;
  state.status = status;
  state.pending_item = null;
  state.terminated_at = new Date().toISOString();
  const def = {
    crisis: '已进入危机干预流程，本次测评中断。',
    invalid: '由于多题无法确认，本次结果不计分，建议稍后重测。',
    abandoned: '会话已超时或超过最大轮次，已结束。',
    handoff: '系统遇到问题，已为你转接人工。',
  };
  return { state, reply: msgOverride || `[${status}] ${reason}。${def[status] || ''}`,
           status, reason };
}

function escalate(ctx) {
  console.warn(`[ESCALATION] session=${ctx.state.session_id} 触发真人告警/上报`);
}

// 报告生成：advice 默认用 JSON 原文；若注入 ctx.adviceFn（如 DeepSeek），
// 则由模型对 advice 做共情措辞包装。分数/标签/免责声明/存疑题号永远不交给模型。
async function buildReport(ctx, r) {
  let advice = r.advice;
  if (ctx.adviceFn) {
    try {
      const wrapped = await ctx.adviceFn(ctx, r);
      if (wrapped && typeof wrapped === 'string' && wrapped.trim())
        advice = wrapped.trim();
    } catch (e) {
      console.warn(`[buildReport] advice 包装降级，用原文: ${e.message}`);
    }
  }
// 终态文案统一出口：分数行 + 存疑题点名 + 免责声明，三段都写死，绝不交给模型
function flaggedNote(state) {
  const ids = flaggedItemIds(state);
  return ids.length
    ? `（注意：第 ${ids.join('、')} 题因回答始终无法确认，已按存疑处理，本次结果未将其计入有效作答，可能影响准确性。）`
    : '';
}

function scoreLine(r) {
  // 防空值：任一分数缺失就不硬拼，避免出现"总分，"这类断句
  const parts = [];
  if (r.raw_score != null) parts.push(`粗分 ${r.raw_score}`);
  if (r.standard_score != null) parts.push(`标准分 ${r.standard_score}`);
  const nums = parts.length ? parts.join('，') + '，' : '';
  return `测评完成。${nums}结果：${r.severity_label}。`;
}

const DISCLAIMER = '（本结果为情绪筛查参考，不构成医学诊断，不能替代专业医生的临床评估。）';

async function buildReport(ctx, r) {
  let advice = r.advice;
  if (ctx.adviceFn) {
    try {
      const wrapped = await ctx.adviceFn(ctx, r);
      if (wrapped && typeof wrapped === 'string' && wrapped.trim())
        advice = wrapped.trim();
    } catch (e) {
      console.warn(`[buildReport] advice 包装降级，用原文: ${e.message}`);
    }
  }
  return `${scoreLine(r)}${advice}${flaggedNote(ctx.state)}${DISCLAIMER}`;
}

// 优先用注入的共情生成器(DeepSeek)；失败/未注入则回退到写死文案，保证永不崩、永不卡。
async function genReply(ctx, situation, fallbackMsg) {
  if (!ctx.replyFn) return fallbackMsg;
  try {
    const s = await ctx.replyFn(ctx, situation);
    return (s && typeof s === 'string' && s.trim()) ? s.trim() : fallbackMsg;
  } catch (e) {
    console.warn(`[genReply] 共情生成降级，用原文: ${e.message}`);
    return fallbackMsg;
  }
}

// ---------- 主流程：处理用户一次输入（异步） ----------
async function processTurn(ctx, rawInput) {
  const { state, scale, config } = ctx;

  if (state.status !== 'in_progress')
    return reply(ctx, `[会话已处于终态:${state.status}]`);

  // 轮次 / 超时 → [ABANDON]
  state.turn_count += 1;
  if (state.turn_count > config.session.max_total_turns)
    return terminate(ctx, 'abandoned', '超过最大轮次');
  if ((Date.now() - new Date(state.started_at)) / 1000 > config.session.session_timeout_sec)
    return terminate(ctx, 'abandoned', '会话超时');

  // [GUARD]
  const g = guard(ctx, rawInput);
  if (g.action === 'clarify') {
    const item = ctx.scale.items.find(it => String(it.item_id) === String(ctx.state.pending_item));
    const fallback = g.reason === 'too_long'
      ? '您的回答有点长，能简短说说最近一周这种情况多不多吗？'
      : '我们专心把这个测评做完哈，就说说您最近一周的真实感受就好。';
    const msg = await genReply(ctx, {
      type: g.reason === 'too_long' ? 'followup' : 'clarify_offtopic',
      userText: rawInput,
      coreNeed: `了解“${item ? item.text : ''}”这种感受最近一周的真实情况`,
    }, fallback);
    pushHistory(ctx, rawInput, msg);
    return reply(ctx, msg);
  }

  const clean = g.sanitized;

  // [MAP] + [SCHEMA] 重试（mapFn 可能是异步的 DeepSeek 调用）
  let mapped;
  state.schema_retries = 0;
  while (true) {
    mapped = await ctx.mapFn(ctx, clean);
    if (validateMapped(mapped, scale, state)) break;
    if (state.schema_retries < config.security.max_schema_retries) {
      state.schema_retries += 1; continue;
    }
    return terminate(ctx, 'handoff', 'Schema 校验重试耗尽');
  }

  // [INTENT] 跨题修正（由 record_answer.amend_target_item_id 驱动）
  if (mapped.amend_target_item_id) {
    const tid = String(mapped.amend_target_item_id);
    if (scale.items.some(it => String(it.item_id) === tid)) {
      state.answers = state.answers.filter(a => a.item_id !== tid); // 移除旧答案，重作
      state.answered_count = state.answers.length;
      state.low_confidence_count = state.answers.filter(a => a.flagged_low_confidence).length;
      state.pending_item = tid;
      state._current_followups = 0; // 修正不计入追问
      const msg = `好的，我们回到第${tid}题重新确认一下。${askText(scale.items.find(it => String(it.item_id) === tid), scale)}`;
      pushHistory(ctx, clean, msg);
      return reply(ctx, msg);
    }
  }

  // [CRISIS CHECK] 优先级最高
  if (checkCrisis(ctx, mapped)) {
    state.crisis_triggered = true;
    const hotline = (scale.crisis_rule && scale.crisis_rule.hotline)
      || config.crisis.hotline_text_fallback;
    const msg = `听到你这样说，我真的很担心你，你的感受很重要。请一定立刻联系：${hotline}。你并不孤单。`;
    pushHistory(ctx, clean, msg);
    if (config.crisis.halt_on_trigger) {
      if (config.crisis.crisis_escalation) escalate(ctx);
      return terminate(ctx, 'crisis', '命中危机', msg);
    }
  }

  // 用户没看懂题意 → 解释题目，不推进、不追问频率
  if (detectConfused(clean)) {
    const item = scale.items.find(it => String(it.item_id) === String(state.pending_item));
    const plain = (item && item.plain_desc) || (item ? item.text : '');
    const msg = await genReply(ctx, {
      type: 'explain_item',
      userText: clean,
      coreNeed: `用户没看懂题目"${item ? item.text : ''}"的意思。`
        + `请用一句最通俗的大白话解释这道题在问什么（参考：${plain}），`
        + `解释完再自然地把这个问题重新问一遍。绝对不要追问"几天/几次/多频繁"。`,
    }, `这道题其实是想了解：${plain}。你最近一周大概是什么情况呢？`);
    pushHistory(ctx, clean, msg);
    return reply(ctx, msg);
  }
  // ↑↑↑ 注意：放在 crisis 之后，保证危机判断永远优先级最高

  // [GATE-1] 置信度（条件题+情境不适用 → 按中性选项计分，不追问）
  const curItem = scale.items.find(it => String(it.item_id) === String(state.pending_item));
  const isNA = curItem && curItem.conditional && detectNotApplicable(clean);

  if (isNA) {
    commitAnswer(ctx, {
      item_id: state.pending_item,
      option_no: curItem.neutral_option || 1,
      confidence: 1,
      evidence: clean.slice(0, 200),
    }, false);
  } else {
    const lowConf = mapped.option_no == null || mapped.confidence < config.gates.confidence_threshold;
    if (lowConf) {
      if (state._current_followups < config.gates.max_followups_per_item) {
        state._current_followups += 1;
        const item = scale.items.find(it => String(it.item_id) === String(state.pending_item));
        const plain = item.plain_desc || item.text;

        let coreNeed, fallback;
        if (state._current_followups === 1) {
          coreNeed = `用户对"${item.text}"给不出明确答案。请严格三步走：`
            + `①先共情，承认这种感觉本来就难说清；`
            + `②用大白话把这种状态描述一遍（参考：${plain}）帮他对号入座；`
            + `③给三档生活化的选择让他挑——「最近基本天天这样」「只在特别累或某些时候才有」「几乎没有」。`
            + `绝对不要追问"几天/几次/多频繁"，不要让他报数字。`;
          fallback = `这种感觉有时确实不好说清，没关系。${plain}——你觉得最近更接近`
            + `「基本天天这样」「只在特别累时才有」还是「几乎没有」？挑个最贴近的就行。`;
        } else {
          const anchor = scale.option_frequency_anchor;
          const opts = item.options
            .map(o => (anchor && anchor[String(o.option_no)]) || o.label)
            .filter(Boolean).join('、');
          coreNeed = `用户连续表示说不清，绝对不要再追问具体天数。`
            + `请把这几种程度温和地列给他挑：「${opts}」，`
            + `并明确告诉他"实在不确定的话，选个最接近的感觉就好，没有对错"`;
          fallback = `没关系，那你觉得更接近哪种呢——${opts}？挑个最贴近的就行。`;
        }

        const msg = await genReply(ctx, { type: 'followup', userText: clean, coreNeed }, fallback);
        pushHistory(ctx, clean, msg);
        return reply(ctx, msg);
      }
      if (config.gates.followup_exhausted_action === 'transfer_human')
        return terminate(ctx, 'handoff', '追问耗尽转人工');
      commitAnswer(ctx, mapped, true); // skip_and_flag → 该题标记为存疑/无效，报告点名
    } else {
      commitAnswer(ctx, mapped, false);
    }
  }

  // [GATE-2] 完整性：低置信超限 → invalid，并列出是哪几题压垮阈值
  if (state.low_confidence_count > config.gates.max_low_confidence_items) {
    const ids = flaggedItemIds(state);
    return terminate(ctx, 'invalid',
      `低置信题超限，第 ${ids.join('、')} 题无法确认`);
  }

  if (state.answered_count < scale.meta.total_items) {
    advancePending(ctx);
    const next = scale.items.find(it => String(it.item_id) === state.pending_item);
    let msg;
    if (isNA) {
      const ack = await genReply(ctx, {
        type: 'ack_skip',
        userText: clean,
        coreNeed: '用户表示当前这道题的情境对他不适用。'
          + '请只用一句话温和地表示"这条先跳过、不影响测评"，'
          + '绝对不要提出任何新问题、不要复述任何题目内容。',
      }, '好的，这条用不上，我们就先跳过哈。');
      msg = `${ack}${askText(next, scale)}`;   // ← 问题永远来自带引号的 askText
    } else {
      msg = askText(next, scale);
    }
    pushHistory(ctx, clean, msg);
    return reply(ctx, msg);
  }

  // 全部完成 → [SCORE] → [REPORT]
  state.status = 'ready_to_score';
  state.score_result = scoreScale(scale,
    state.answers.map(a => ({ item_id: a.item_id, option_no: a.option_no })));
  state.status = 'completed';
  state.terminated_at = new Date().toISOString();
  const report = await buildReport(ctx, state.score_result);
  pushHistory(ctx, clean, report);
  return reply(ctx, report);
}

function startSession(ctx) {
  const first = ctx.scale.items[0];
  return reply(ctx, askText(first, ctx.scale));
}

module.exports = { processTurn, startSession, guard, checkCrisis, validateMapped, buildReport };
