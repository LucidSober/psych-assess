// src/daily/index.js
// 编排器:把整条管线串起来。
//   当天对话 → extractor → (命中危机? → 立即旁路) → aggregator → softScore → reporter
//
// 用法:
//   const { runDailyReview } = require('./daily');
//   const report = await runDailyReview(messages, { mapFn });   // mapFn 缺省走 stub
//
// mapFn 注入点:有 DEEPSEEK_API_KEY 时传 deepseekDailyMap,否则传 stubDailyMap。

const fs = require('fs');
const path = require('path');
const { extract } = require('./extractor');
const { aggregate } = require('./aggregator');
const { buildReport, CRISIS_REPLY } = require('./reporter');
const { softScore } = require('../scoring');
const config = require('./config');
const { stubDailyMap } = require('./llmDaily');

function loadJSON(p) { return JSON.parse(fs.readFileSync(p, 'utf8')); }

// 量表数据目录:真实结构在根 scales/(psych-assess/scales),兼容 src/scales/ 两种放法。
function resolveScalesDir() {
  const candidates = [
    path.join(__dirname, '..', '..', 'scales'), // psych-assess/scales(真实)
    path.join(__dirname, '..', 'scales'),       // src/scales(备选)
    path.join(process.cwd(), 'scales'),
  ];
  for (const dir of candidates) {
    if (fs.existsSync(path.join(dir, 'signals.json')) || fs.existsSync(path.join(dir, 'PHQ9.json')))
      return dir;
  }
  return candidates[0];
}

function loadDeps() {
  const scalesDir = resolveScalesDir();
  return {
    signals: loadJSON(path.join(scalesDir, 'signals.json')),
    scalesById: {
      PHQ9: loadJSON(path.join(scalesDir, 'PHQ9.json')),
      GAD7: loadJSON(path.join(scalesDir, 'GAD7.json')),
    },
  };
}

/**
 * @param {Array} messages [{role, content, ts?}]
 * @param {Object} [opts]
 * @param {Function} [opts.mapFn]   细筛实现,默认 stubDailyMap
 * @param {Object}   [opts.deps]    {signals, scalesById},默认从磁盘加载
 * @param {boolean}  [opts.consent] 知情同意,必须为 true 才分析
 */
async function runDailyReview(messages, opts = {}) {
  const { mapFn = stubDailyMap, deps = loadDeps(), consent = true } = opts;

  if (!consent) {
    return { status: 'no_consent', crisis: false,
      report: { text: '被动情绪分析需要你先同意开启。你随时可以在设置里打开或关掉它。' } };
  }

  // 1+2+3:粗筛 → 危机旁路 → 细筛
  const ex = await extract({ messages, signals: deps.signals, mapFn, config });

  // 危机:最高优先级,直接旁路,不聚合、不评分、不出日报
  if (ex.crisis) {
    return {
      status: 'crisis', crisis: true,
      crisis_snippet: ex.crisis_snippet || null,
      report: { text: CRISIS_REPLY, weak_confidence: true, recommendations: [] },
    };
  }

  // 4:按天聚合
  const profile = aggregate({ items: ex.items, signals: deps.signals, config });
  // softScore:弱置信参考区间
  const soft = softScore(profile, deps.scalesById, config);
  // 5:三段式报告
  const report = buildReport(profile, soft, config);

  return { status: 'ok', crisis: false, profile, soft, report };
}

module.exports = { runDailyReview, loadDeps };
