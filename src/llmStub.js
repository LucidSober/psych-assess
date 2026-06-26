// src/llmStub.js
// 离线假模型：不联网、不花钱，用来验证状态机本身。
// 约定：用户直接输入数字 → 当作选项号；可识别危机词、"改第N题"、"不知道"。

const CRISIS_REGEX = /想死|不想活|不想活了|自杀|结束生命|活着没意思|轻生|了结自己/;

function stubMap(ctx, raw) {
  const text = String(raw).trim();
  const pending = String(ctx.state.pending_item);

  // 测试钩子：制造一个必定通不过 SCHEMA 校验的返回，验证 handoff 分支
  if (text === '__bad__') {
    return {
      item_id: '__nonexistent__', option_no: 99, confidence: 2,
      crisis_signal: false, amend_target_item_id: null, evidence: text,
    };
  }

  // 跨题修正："改第2题" / "改 3 题"
  const amend = text.match(/改第?\s*(\d+)\s*题/);

  // 直接输入数字 → 选项号；否则视为无法判断(交 GATE-1 追问)
  const num = /^\d+$/.test(text) ? Number(text) : null;

  return {
    item_id: pending,
    option_no: num,
    confidence: num != null ? 1 : 0,
    crisis_signal: CRISIS_REGEX.test(text),
    amend_target_item_id: amend ? amend[1] : null,
    evidence: text.slice(0, 200),
  };
}

module.exports = { stubMap };