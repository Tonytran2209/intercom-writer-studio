-- Run after 009. Decisions and learning observations are committed atomically.
ALTER TABLE eb_v2_review_actions ADD COLUMN IF NOT EXISTS approved_variants TEXT
  CHECK (approved_variants IN ('a', 'b', 'both'));
ALTER TABLE eb_v2_learning_signals ALTER COLUMN feedback_id DROP NOT NULL;
ALTER TABLE eb_v2_learning_signals ADD COLUMN IF NOT EXISTS review_action_id UUID UNIQUE
  REFERENCES eb_v2_review_actions(id) ON DELETE CASCADE;
ALTER TABLE eb_v2_learning_signals ADD COLUMN IF NOT EXISTS evidence JSONB NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE eb_v2_learning_signals ADD CONSTRAINT eb_v2_learning_source_check
  CHECK (num_nonnulls(feedback_id, review_action_id) = 1);

CREATE OR REPLACE FUNCTION eb_v2_save_review(
  p_output_id UUID, p_action TEXT, p_variants TEXT, p_note TEXT, p_created_by UUID
) RETURNS VOID LANGUAGE plpgsql SECURITY INVOKER SET search_path = public AS $$
DECLARE
  output eb_v2_channel_outputs%ROWTYPE;
  review_id UUID;
BEGIN
  SELECT * INTO output FROM eb_v2_channel_outputs WHERE id = p_output_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Channel output not found'; END IF;
  IF p_action IS NULL OR p_action NOT IN ('done', 'reject', 'recheck') THEN
    RAISE EXCEPTION 'Invalid review action';
  END IF;
  IF output.content->>'archived' = 'true' OR output.status NOT IN ('ready_for_review', 'done', 'rejected', 'recheck') THEN
    RAISE EXCEPTION 'Only a current, generated output can be reviewed';
  END IF;
  IF output.channel = 'threads' AND p_action = 'done' THEN
    IF p_variants IS NULL OR p_variants NOT IN ('a', 'b', 'both') THEN
      RAISE EXCEPTION 'Choose Variant A, Variant B, or both';
    END IF;
  ELSIF p_variants IS NOT NULL THEN
    RAISE EXCEPTION 'Variant selection applies only to Threads approvals';
  END IF;
  INSERT INTO eb_v2_review_actions(channel_output_id, action, approved_variants, note, created_by)
    VALUES (output.id, p_action, p_variants, p_note, p_created_by) RETURNING id INTO review_id;
  UPDATE eb_v2_channel_outputs SET
    status = CASE p_action WHEN 'done' THEN 'done' WHEN 'reject' THEN 'rejected' ELSE 'recheck' END,
    completed_at = CASE WHEN p_action = 'done' THEN now() ELSE NULL END,
    content = (COALESCE(content, '{}'::jsonb) - 'approvedVariants') ||
      CASE WHEN p_variants IS NOT NULL THEN jsonb_build_object('approvedVariants', p_variants) ELSE '{}'::jsonb END
    WHERE id = output.id;
  -- A later decision supersedes the observation without deleting its audit history.
  UPDATE eb_v2_learning_signals SET active = false
    WHERE review_action_id IN (SELECT id FROM eb_v2_review_actions WHERE channel_output_id = output.id);
  IF p_variants IS NOT NULL THEN
    INSERT INTO eb_v2_learning_signals(review_action_id, package_id, gate, channel, instruction, evidence)
      VALUES (review_id, output.package_id, 'review', 'threads',
        format('Editorial observation for %s, revision %s: reviewer approved Threads variant(s) %s. This is a content-specific editorial preference, not evidence of performance or a global preference for an account type. Preserve Channel Rules and continue providing the required variants.', output.package_id, output.revision, upper(p_variants)),
        jsonb_build_object('channelOutputId', output.id, 'revision', output.revision,
          'approvedVariants', p_variants, 'content', output.content->>'text',
          'performance', NULL));
  END IF;
END;
$$;
REVOKE ALL ON FUNCTION eb_v2_save_review(UUID, TEXT, TEXT, TEXT, UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION eb_v2_save_review(UUID, TEXT, TEXT, TEXT, UUID) TO service_role;
