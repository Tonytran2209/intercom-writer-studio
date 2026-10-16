-- Run after 007, 009 and 012 against an isolated database. No test data persists.
BEGIN;
DO $$
DECLARE
  pkg UUID;
  missing_pkg UUID;
  saved_article UUID;
  pending_article UUID;
  channel_id UUID;
  current_state TEXT;
BEGIN
  INSERT INTO eb_v2_packages(title, state, source_type, brief_approved_at, article_approved_at, completed_at)
    VALUES ('Move regression', 'review', 'input', now(), now(), now()) RETURNING id INTO pkg;
  INSERT INTO eb_v2_gate_runs(package_id, gate, stage, status, output_snapshot)
    VALUES (pkg, 'brief', 'extract_mapping', 'completed', '{"content":"## Brief summary: Saved brief"}');
  INSERT INTO eb_v2_articles(package_id, revision, status, body_markdown, approved_at)
    VALUES (pkg, 1, 'approved', '# Full website article', now()) RETURNING id INTO saved_article;
  INSERT INTO eb_v2_articles(package_id, revision, status, body_markdown, quality_report)
    VALUES (pkg, 2, 'draft', 'Unaccepted feedback rewrite', '{"feedbackPending":true}') RETURNING id INTO pending_article;
  INSERT INTO eb_v2_channel_outputs(package_id, article_id, channel, status, content, completed_at)
    VALUES (pkg, saved_article, 'threads', 'done', '{"text":"Variant A and Variant B", "approvedVariants":"a"}', now()) RETURNING id INTO channel_id;
  PERFORM eb_v2_move_package(pkg, 'article');
  IF NOT EXISTS (SELECT 1 FROM eb_v2_packages WHERE id = pkg AND state = 'article' AND article_approved_at IS NULL AND completed_at IS NULL AND brief_approved_at IS NOT NULL) THEN
    RAISE EXCEPTION 'Gate 2 package state or approvals are incorrect';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM eb_v2_articles WHERE id = saved_article AND status = 'draft' AND approved_at IS NULL AND body_markdown = '# Full website article') THEN
    RAISE EXCEPTION 'Saved article was not restored as draft';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM eb_v2_articles WHERE id = pending_article AND status = 'superseded') THEN
    RAISE EXCEPTION 'Unaccepted feedback was restored';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM eb_v2_channel_outputs WHERE id = channel_id AND content->>'archived' = 'true' AND completed_at IS NULL) THEN
    RAISE EXCEPTION 'Social output not archived';
  END IF;
  PERFORM eb_v2_move_package(pkg, 'brief');
  IF NOT EXISTS (SELECT 1 FROM eb_v2_packages WHERE id = pkg AND state = 'brief' AND brief_approved_at IS NULL AND article_approved_at IS NULL) THEN
    RAISE EXCEPTION 'Gate 1 state or approvals are incorrect';
  END IF;
  IF EXISTS (SELECT 1 FROM eb_v2_articles WHERE package_id = pkg AND status <> 'superseded') THEN
    RAISE EXCEPTION 'Article remains active in Gate 1';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM eb_v2_gate_runs WHERE package_id = pkg AND gate = 'brief' AND output_snapshot->>'content' = '## Brief summary: Saved brief') THEN
    RAISE EXCEPTION 'Saved brief was altered';
  END IF;
  -- A direct Gate 3 -> Gate 1 move restores the same brief and clears approvals.
  UPDATE eb_v2_packages SET state = 'review' WHERE id = pkg;
  PERFORM eb_v2_move_package(pkg, 'brief');
  SELECT state INTO current_state FROM eb_v2_packages WHERE id = pkg;
  IF current_state <> 'brief' THEN RAISE EXCEPTION 'Direct move failed'; END IF;
  INSERT INTO eb_v2_packages(title, state, source_type) VALUES ('No saved article', 'review', 'input') RETURNING id INTO missing_pkg;
  BEGIN
    PERFORM eb_v2_move_package(missing_pkg, 'article');
    RAISE EXCEPTION 'Missing article was accepted';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM <> 'No saved website article is available for Gate 2' THEN RAISE; END IF;
  END;
  SELECT state INTO current_state FROM eb_v2_packages WHERE id = missing_pkg;
  IF current_state <> 'review' THEN RAISE EXCEPTION 'Failed move changed state'; END IF;
  INSERT INTO eb_v2_gate_runs(package_id, gate, stage, status) VALUES (pkg, 'article', 'draft', 'running');
  BEGIN
    PERFORM eb_v2_move_package(pkg, 'article');
    RAISE EXCEPTION 'In-flight generation was moved';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM <> 'Wait for the current AI generation or refinement to finish before moving this package' THEN RAISE; END IF;
  END;
END;
$$;
ROLLBACK;
