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

// ============================================================================
// softScore —— 被动日报专用"软评分"。与上面的 scoreScale() 严格区分,绝不混用:
//   - 输入:daily/aggregator 的维度画像 + 各量表对象。
//   - 只复用 severity_levels 的标签阶梯,不照搬 scoreScale 的 *1.25 标准分
//     (那是 SAS/SDS 满量表换算,不适用于只覆盖部分题的被动信号)。
//   - 不伪造满量表总分:只给"覆盖到的强度"作保守下沿,永远带 weak_confidence。
// ============================================================================
function severityLabelForRaw(scale, raw) {
  const lv = (scale.severity_levels || []).find(l => raw >= l.range[0] && raw <= l.range[1]);
  return lv ? lv.label : null;
}
function labelByLevelIndex(scale, idx) {
  const levels = scale.severity_levels || [];
  if (levels.length === 0) return null;
  return levels[Math.max(0, Math.min(levels.length - 1, idx))].label;
}

function softScore(profile, scalesById, config) {
  const byScale = {};
  for (const dim of profile.fired_dimensions) {
    const d = profile.dimensions[dim];
    (byScale[d.scale] = byScale[d.scale] || []).push(d);
  }

  const domains = {};
  for (const [scaleId, dimsArr] of Object.entries(byScale)) {
    const scale = scalesById[scaleId];
    if (!scale) continue;
    const domain = config.domain_of_scale[scaleId] || scaleId;

    const softRawCovered = dimsArr.reduce((s, d) => s + d.frequency_band, 0);
    const totalItems = (scale.meta && scale.meta.total_items) || scale.items.length;
    const coveredItems = dimsArr.length;

    const lowLabel = severityLabelForRaw(scale, softRawCovered);
    const lowIdx = (scale.severity_levels || []).findIndex(
      l => softRawCovered >= l.range[0] && softRawCovered <= l.range[1]);
    const highLabel = labelByLevelIndex(scale, (lowIdx < 0 ? 0 : lowIdx) + 1);

    const peakBand = Math.max(...dimsArr.map(d => d.frequency_band));
    const recommend =
      coveredItems >= config.recommend_gate.min_fired_dims ||
      peakBand >= config.recommend_gate.min_peak_band;

    domains[domain] = {
      scale_id: scaleId, domain,
      domain_label: config.domain_label[domain] || domain,
      covered_items: coveredItems, total_items: totalItems,
      soft_raw_covered: softRawCovered,
      reference_band: lowLabel === highLabel ? [lowLabel] : [lowLabel, highLabel],
      peak_frequency_band: peakBand,
      weak_confidence: true, recommend,
      dims: dimsArr.map(d => ({
        dimension: `${d.scale}_item${d.item_id}`, label: d.label,
        frequency_band: d.frequency_band, intensity: d.intensity, net_valence: d.net_valence })),
    };
  }

  for (const [scaleId, domain] of Object.entries(config.domain_of_scale)) {
    if (!domains[domain]) {
      domains[domain] = {
        scale_id: scaleId, domain, domain_label: config.domain_label[domain] || domain,
        insufficient: true, weak_confidence: true, recommend: false, dims: [] };
    }
  }
  return { domains, weak_confidence: true };
}

module.exports = { scoreScale, softScore, severityLabelForRaw };
