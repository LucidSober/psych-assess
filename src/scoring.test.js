const { loadScale } = require('./scales');
const { scoreScale } = require('./scoring');

const SDS = loadScale('SDS');

// 全选最低频率(option_no=1)：正向题得1，反向题得4
const allOpt1 = SDS.items.map(it => ({ item_id: it.item_id, option_no: 1 }));
const r1 = scoreScale(SDS, allOpt1);
// 正向题10题×1 + 反向题10题×4 = 10 + 40 = 50 → Y=floor(62.5)=62
console.log('全选项1:', r1.raw_score, r1.standard_score, r1.severity_label);
console.assert(r1.raw_score === 50 && r1.standard_score === 62, '边界1失败');

// 全选最高频率(option_no=4)：正向题得4，反向题得1
const allOpt4 = SDS.items.map(it => ({ item_id: it.item_id, option_no: 4 }));
const r4 = scoreScale(SDS, allOpt4);
// 10×4 + 10×1 = 50 → 同样 62。验证反向题确实在起作用
console.log('全选项4:', r4.raw_score, r4.standard_score);
console.assert(r4.raw_score === 50, '边界2失败');

// 危机题命中：第19题选 option_no=2
const crisisCase = SDS.items.map(it => ({
  item_id: it.item_id, option_no: it.item_id === 19 ? 2 : 1
}));
const rc = scoreScale(SDS, crisisCase);
console.log('危机题命中:', rc.crisis_item_hit);
console.assert(rc.crisis_item_hit === true, '危机判断失败');

console.log('全部边界测试通过');