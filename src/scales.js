const fs = require('fs');
const path = require('path');

function loadScale(scaleId) {
  const file = path.join(__dirname, '..', 'scales', `${scaleId}.json`);
  const scale = JSON.parse(fs.readFileSync(file, 'utf-8'));
  validateScale(scale);
  return scale;
}

function validateScale(s) {
  const id = s.meta.scale_id;
  // 题数一致
  if (s.items.length !== s.meta.total_items)
    throw new Error(`${id}: 题数与 total_items 不符`);

  for (const item of s.items) {
    // 每题选项的 option_no 必须是 1..N 连续
    const nos = item.options.map(o => o.option_no).sort((a, b) => a - b);
    nos.forEach((n, i) => {
      if (n !== i + 1) throw new Error(`${id} 第${item.item_id}题 option_no 不连续`);
    });
    // 分值必须落在 item_score_range
    const [lo, hi] = s.meta.item_score_range;
    for (const o of item.options)
      if (o.score < lo || o.score > hi)
        throw new Error(`${id} 第${item.item_id}题分值越界`);
    // 反向题校验：reverse_scored 与 reverse_items 必须一致
    const inList = s.reverse_items.includes(item.item_id);
    if (item.reverse_scored !== inList)
      throw new Error(`${id} 第${item.item_id}题 reverse 标记与 reverse_items 不一致`);
  }

  // severity 区间必须连续、覆盖 standard_range，无重叠
  const [smin, smax] = s.scoring.standard_range;
  const levels = [...s.severity_levels].sort((a, b) => a.range[0] - b.range[0]);
  if (levels[0].range[0] !== smin || levels[levels.length - 1].range[1] !== smax)
    throw new Error(`${id}: severity 未覆盖 standard_range`);
  for (let i = 1; i < levels.length; i++)
    if (levels[i].range[0] !== levels[i - 1].range[1] + 1)
      throw new Error(`${id}: severity 区间断裂或重叠 @${levels[i].range[0]}`);

  return true;
}

module.exports = { loadScale, validateScale };