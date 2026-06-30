// src/daily/aggregator.js
// 4 同维度多条证据按天合并成画像。规则:
//  - 频率档从"提及次数"(对话密度)推,对应各量表自己的 option_frequency_anchor。
//  - 强度偏重但带衰减,单条证据封顶,别让一句重话拉满。
//  - 正/负证据矛盾时按净值判方向(改善 / 混合 / 负向)。
//  - 证据太少或置信太低 → insufficient=true,不进 softScore。

function freqBandFromMentions(n, cfg) {
  for (const r of cfg.frequency_from_mentions) if (n >= r.min_mentions) return r.band;
  return 0;
}

// 偏重 + 衰减:排序降序,首条全量,其后按 decay^i 递减叠加;单条封顶;整体封顶。
function mergeIntensity(intensities, cfg) {
  if (intensities.length === 0) return 0;
  const s = [...intensities].sort((a, b) => b - a);
  let acc = s[0];
  for (let i = 1; i < s.length; i++) acc += s[i] * Math.pow(cfg.decay, i);
  if (s.length === 1) acc = Math.min(acc, cfg.single_cap); // 一句重话不拉满
  return Math.min(cfg.max, Number(acc.toFixed(2)));
}

function aggregate({ items, signals, config }) {
  const dims = (signals && signals.dimensions) || {};
  const byDim = new Map();
  for (const it of items || []) {
    if (!byDim.has(it.dimension)) byDim.set(it.dimension, []);
    byDim.get(it.dimension).push(it);
  }

  const out = { window: config.time_window_label, dimensions: {}, fired_dimensions: [] };

  for (const [dim, evs] of byDim.entries()) {
    const meta = dims[dim] || {};
    const neg = evs.filter(e => e.valence === 'negative');
    const pos = evs.filter(e => e.valence === 'positive');
    const amb = evs.filter(e => e.valence === 'ambiguous');

    const negWeight = neg.reduce((s, e) => s + e.intensity_hint * e.confidence, 0);
    const posWeight = pos.reduce((s, e) => s + e.intensity_hint * e.confidence, 0);
    const netNeg = negWeight - posWeight * 0.7; // 改善证据抵扣一部分负向

    let net_valence = 'negative';
    if (neg.length && pos.length) net_valence = netNeg > 0 ? 'mixed' : 'improving';
    else if (!neg.length && pos.length) net_valence = 'improving';
    else if (!neg.length && amb.length) net_valence = 'unclear';

    let intensity = mergeIntensity(neg.map(e => e.intensity_hint), config.intensity);
    if (net_valence === 'mixed') intensity = Number((intensity * 0.7).toFixed(2)); // 矛盾打折
    if (net_valence === 'improving' || net_valence === 'unclear') intensity = 0;

    const frequency_band = freqBandFromMentions(neg.length, config);
    const confidence = evs.reduce((s, e) => s + e.confidence, 0) / evs.length;

    // 信号不足:负向证据不够 / 置信太低 / 方向不是问题方向
    const insufficient =
      neg.length < config.sufficiency.min_evidence_per_dim ||
      confidence < config.sufficiency.min_confidence_per_dim ||
      net_valence === 'improving' || net_valence === 'unclear' ||
      (frequency_band === 0 && intensity === 0);

    out.dimensions[dim] = {
      scale: meta.scale || dim.split('_')[0],
      item_id: meta.item_id != null ? meta.item_id : null,
      label: meta.label || dim,
      evidence_count: evs.length,
      neg_count: neg.length, pos_count: pos.length, ambiguous_count: amb.length,
      frequency_band, intensity, net_valence,
      confidence: Number(confidence.toFixed(2)),
      insufficient,
      snippets: neg.slice(0, 3).map(e => ({
        snippet: e.snippet, intensity_hint: e.intensity_hint, evidence: e.evidence })),
    };
    if (!insufficient) out.fired_dimensions.push(dim);
  }

  // 按强度*频率排序,reporter 取最显著的几条
  out.fired_dimensions.sort((a, b) => {
    const A = out.dimensions[a], B = out.dimensions[b];
    return (B.intensity * (B.frequency_band || 1)) - (A.intensity * (A.frequency_band || 1));
  });
  return out;
}

module.exports = { aggregate, mergeIntensity, freqBandFromMentions };
