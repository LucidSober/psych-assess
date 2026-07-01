// src/daily/config.js
// 被动日报模块的可调参数。和老问卷的 src/config 解耦,不互相污染。
module.exports = {
  time_window_label: '最近两周', // 与 PHQ9/GAD7 timeframe 对齐,reporter 引用

  // 检测维度的 scale → 心理域。判断依据是 PHQ9/GAD7 的题目内容。
  domain_of_scale: { PHQ9: 'depression', GAD7: 'anxiety' },

  // 域 → 推荐用户去做的正式自评量表(接回前端 /api/session 的 scale_id)。
  // 注意:判断用 PHQ9/GAD7,推荐却是 SAS/SDS —— 这是产品口径,别混。
  recommend_scale_of_domain: {
    depression: { scale_id: 'SDS', name: '抑郁自评量表' },
    anxiety:    { scale_id: 'SAS', name: '焦虑自评量表' },
  },
  domain_label: { depression: '情绪低落（抑郁方向）', anxiety: '紧张担忧（焦虑方向）' },

  // 聚合:对话密度 → 频率档(0-3)。按"提及的不同次数"算,不是字数。
  frequency_from_mentions: [
    { min_mentions: 5, band: 3 }, // 几乎天天/反复提
    { min_mentions: 3, band: 2 },
    { min_mentions: 2, band: 1 },
    { min_mentions: 1, band: 1 }, // 偶尔一次也给 1,但靠 insufficient 兜弱证据
  ],

  // 强度合并:偏重但带衰减,且"一句重话不拉满"。
  intensity: {
    decay: 0.35,        // 第 2、3 条证据按 decay^n 递减叠加
    single_cap: 2,      // 只有一条证据时,封顶 2(别让一句话直接到 3)
    max: 3,
  },

  // 证据太少 → 标"信号不足",不进 softScore 计分。
  sufficiency: {
    min_evidence_per_dim: 1,     // 单维度至少几条证据才算"有信号"
    min_confidence_per_dim: 0.35, // 平均置信度低于此 → 维度记为弱/信号不足
  },

  // 推荐去做正式量表的门槛(任一域达标即邀请)。
  recommend_gate: {
    min_fired_dims: 2,   // 该域至少几个维度亮起
    min_peak_band: 2,    // 或单维度频率档达到 2(明显)
  },
};
