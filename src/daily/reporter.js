// src/daily/reporter.js
// 5 生成三段式「今天活得怎么样」:今日概览 / 具体观察 / 温和建议。
//  口径:全程"我感觉到…",绝不出现分数、档位数字、量表得分。
//  危机:由 index 的旁路处理,不进这里。

const CRISIS_REPLY =
  '我有点担心你。你刚才说的那种感受很沉,也很重要,你不该一个人扛。' +
  '可以的话,现在就联系一个你信任的人,或者拨打心理援助热线（如北京 010-82951332、全国 400-161-9995）。' +
  '我会一直在这儿,但此刻,请先让一个真实的人陪着你。';

// 域 → 一句"我感觉到"的概览措辞
function overviewLine(domainObj, cfg) {
  const name = domainObj.domain_label;
  if (domainObj.insufficient) return null;
  const peak = domainObj.peak_frequency_band || 0;
  const lean = peak >= 3 ? '挺频繁地冒出来' : peak >= 2 ? '比较明显地出现' : '偶尔露了头';
  return `在${name}这一块,我感觉到一些信号${lean}`;
}

function buildReport(profile, soft, config, opts = {}) {
  const domains = Object.values(soft.domains);
  const active = domains.filter(d => !d.insufficient);

  // ---------- 第1段:今日概览 ----------
  let overview;
  if (active.length === 0) {
    overview = '今天我没从我们的聊天里读到太多需要担心的情绪信号——也可能只是话题没往那儿走。' +
      '如果你心里其实压着点什么,随时可以多说两句。';
  } else {
    const lines = active.map(d => overviewLine(d, config)).filter(Boolean);
    overview = `读了今天的对话,${lines.join(';')}。这只是我的感觉,不是结论。`;
  }

  // ---------- 第2段:具体观察(贴原话,让用户被看见) ----------
  const quoteDims = profile.fired_dimensions
    .map(dim => profile.dimensions[dim])
    .filter(d => d.snippets && d.snippets.length)
    .slice(0, 3);
  let observations = '';
  if (quoteDims.length) {
    const bullets = quoteDims.map(d => {
      const q = d.snippets[0].snippet;
      return `· 你提到「${q}」——我把它放在了"${d.label}"上。`;
    });
    observations = '有几句话我记在了心里:\n' + bullets.join('\n');
  }

  // ---------- 第3段:温和建议 + 路由 ----------
  const recommendDomains = active.filter(d => d.recommend);
  const recommendations = [];
  let suggestion;
  if (recommendDomains.length) {
    const routes = recommendDomains.map(d => {
      const rec = config.recommend_scale_of_domain[d.domain];
      if (rec) recommendations.push({ scale_id: rec.scale_id, name: rec.name, domain: d.domain });
      return rec ? `${rec.name}（${rec.scale_id}）` : null;
    }).filter(Boolean);
    suggestion = `这些信号已经比较清楚了。如果你愿意,花几分钟做一下${routes.join('、')}` +
      `,能帮我们把它看得更准一点——你随时可以开始,也随时可以不做。在那之前,先对自己温柔些。`;
  } else if (active.length) {
    suggestion = '目前还只是些轻轻的苗头。也许今晚早点放下手机,或者出门走十分钟、跟人说说话,' +
      '都可能让它松一松。我先陪你留意着。';
  } else {
    suggestion = '保持现在的节奏就好。如果哪天觉得不对劲,我都在。';
  }

  const text = [overview, observations, suggestion].filter(Boolean).join('\n\n');

  return {
    text,
    sections: { overview, observations, suggestion },
    recommendations, // [{scale_id, name, domain}] —— 前端据此调 /api/session
    weak_confidence: true,
  };
}

module.exports = { buildReport, CRISIS_REPLY };
