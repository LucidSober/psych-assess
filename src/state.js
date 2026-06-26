const crypto = require('crypto');

function initState(scale, config) {
  return {
    session_id: crypto.randomUUID(),
    scale_id: scale.meta.scale_id,
    scale_version: config.versioning.scale_version,
    scoring_version: config.versioning.scoring_version,
    status: 'in_progress',
    pending_item: String(scale.items[0].item_id),
    answered_count: 0,
    low_confidence_count: 0,
    answers: [],
    history: [],
    turn_count: 0,
    schema_retries: 0,
    score_result: null,
    crisis_triggered: false,
    resume_token: null,
    started_at: new Date().toISOString(),
    terminated_at: null,
    // 内核临时字段(不属于 contract，仅跟踪当前题追问次数)
    _current_followups: 0,
  };
}

module.exports = { initState };