module.exports = {
  context: {
    max_user_input_chars: 500,
    history_window_turns: 3,
    inject_full_scale: false,
  },
  output: { max_tokens: 256, temperature: 0.2 },
  gates: {
    confidence_threshold: 0.40,
    max_followups_per_item: 1,
    followup_exhausted_action: 'skip_and_flag', // skip_and_flag | transfer_human
    max_low_confidence_items: 2,
  },
  crisis: {
    enabled: true,
    structured_trigger_source: 'scale_json',
    free_text_detection: true,
    halt_on_trigger: true,
    crisis_escalation: true,
    hotline_text_fallback: '全国24小时心理援助热线 400-161-9995；如有紧急危险请拨打 120',
  },
  security: {
    injection_detection: true,
    injection_action: 'reject_and_clarify', // sanitize | reject_and_clarify
    input_delimiter: '<<<USER_INPUT>>>',
    output_schema_validation: true,
    max_schema_retries: 2,
  },
  session: {
    active_scale_id: 'SDS',
    session_timeout_sec: 1200,
    max_total_turns: 80,
    resume_enabled: true,
  },
  versioning: { scale_version: 'SDS-v1', scoring_version: 'score-v1' },
};