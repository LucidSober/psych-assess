function scoreScale(scale, answers) {
  // answers: [{ item_id, option_no }]，option_no 可能为 null(低置信跳过)
  // 完整性由状态机的 GATE-2 保证，这里只负责算

  let raw = 0;
  const byId = new Map(scale.items.map(it => [String(it.item_id), it]));

  for (const ans of answers) {
    if (ans.option_no == null) continue; // 跳过题不计分（理论上 invalid 不会走到这）
    const item = byId.get(String(ans.item_id));
    if (!item) throw new Error(`找不到题目 item_id=${ans.item_id}`);
    const opt = item.options.find(o => o.option_no === ans.option_no);
    if (!opt) throw new Error(`非法 option_no=${ans.option_no} @item ${ans.item_id}`);
    raw += opt.score; // 反向题分值已内置，直接累加
  }

  // 标准分 Y = floor(X * 1.25)
  const standard = Math.floor(raw * 1.25);

  // 命中 severity 区间
  const level = scale.severity_levels.find(
    l => standard >= l.range[0] && standard <= l.range[1]
  );

  // 结构化危机题命中判断（仅 SDS 第19题；SAS 的 crisis_rule=null 不触发）
  let crisisItemHit = false;
  if (scale.crisis_rule) {
    const cAns = answers.find(
      a => String(a.item_id) === String(scale.crisis_rule.item_id)
    );
    if (cAns && cAns.option_no != null && cAns.option_no >= 2) crisisItemHit = true;
  }

  return {
    raw_score: raw,
    standard_score: standard,
    severity_label: level.label,
    advice: level.advice,
    crisis_item_hit: crisisItemHit,
  };
}

module.exports = { scoreScale };