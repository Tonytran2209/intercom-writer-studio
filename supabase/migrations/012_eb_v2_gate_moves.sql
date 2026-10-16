-- Restore gate-specific saved artifacts without generating new AI output.
CREATE OR REPLACE FUNCTION eb_v2_move_package(p_package_id UUID, p_target TEXT)
RETURNS VOID LANGUAGE plpgsql SECURITY INVOKER SET search_path = public AS $$
DECLARE
  package eb_v2_packages%ROWTYPE;
  article_id UUID;
BEGIN
  IF p_target IS NULL OR p_target NOT IN ('brief', 'article') THEN
    RAISE EXCEPTION 'Choose Brief or Website article as the destination';
  END IF;
  SELECT * INTO package FROM eb_v2_packages WHERE id = p_package_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Package not found'; END IF;
  IF EXISTS (SELECT 1 FROM eb_v2_gate_runs WHERE package_id = p_package_id AND status IN ('running', 'queued'))
    OR EXISTS (SELECT 1 FROM eb_v2_feedback_threads WHERE package_id = p_package_id AND status IN ('running', 'queued'))
    OR EXISTS (SELECT 1 FROM eb_v2_channel_outputs WHERE package_id = p_package_id AND status IN ('queued', 'generating') AND COALESCE(content->>'archived', 'false') <> 'true') THEN
    RAISE EXCEPTION 'Wait for the current AI generation or refinement to finish before moving this package';
  END IF;
  -- Verify the destination before changing any status or archival marker.
  IF p_target = 'article' THEN
    SELECT id INTO article_id FROM eb_v2_articles
      WHERE package_id = p_package_id AND btrim(body_markdown) <> ''
        AND COALESCE(quality_report->>'feedbackPending', 'false') <> 'true'
      ORDER BY revision DESC LIMIT 1;
    IF article_id IS NULL THEN RAISE EXCEPTION 'No saved website article is available for Gate 2'; END IF;
  ELSIF NOT EXISTS (SELECT 1 FROM eb_v2_gate_runs WHERE package_id = p_package_id AND gate = 'brief'
    AND status = 'completed' AND btrim(COALESCE(output_snapshot->>'content', '')) <> '') THEN
    RAISE EXCEPTION 'No completed brief is available for Gate 1';
  END IF;
  UPDATE eb_v2_channel_outputs SET status = 'rejected',
    content = content || jsonb_build_object('archived', true, 'archivedAt', now()),
    completed_at = NULL
    WHERE package_id = p_package_id AND COALESCE(content->>'archived', 'false') <> 'true';
  UPDATE eb_v2_articles SET status = 'superseded', approved_at = NULL
    WHERE package_id = p_package_id;
  IF p_target = 'article' THEN
    UPDATE eb_v2_articles SET status = 'draft', approved_at = NULL WHERE id = article_id;
  END IF;
  UPDATE eb_v2_packages SET state = p_target,
    brief_approved_at = CASE WHEN p_target = 'brief' THEN NULL ELSE brief_approved_at END,
    article_approved_at = NULL, completed_at = NULL
    WHERE id = p_package_id;
END;
$$;
REVOKE ALL ON FUNCTION eb_v2_move_package(UUID, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION eb_v2_move_package(UUID, TEXT) TO service_role;
