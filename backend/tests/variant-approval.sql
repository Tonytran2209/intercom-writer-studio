-- Regression test: run after migrations 007, 009 and 011 in an isolated database.
-- All test data is rolled back.
BEGIN;
DO $$
DECLARE
  package_id UUID;
  threads_id UUID;
  facebook_id UUID;
  choice TEXT;
  result JSONB;
  signal_count INTEGER;
  before_count INTEGER;
BEGIN
  INSERT INTO eb_v2_packages(title, source_type) VALUES ('Variant approval test', 'input') RETURNING id INTO package_id;
  INSERT INTO eb_v2_channel_outputs(package_id, channel, status, content)
    VALUES (package_id, 'threads', 'ready_for_review', '{"text":"Variant A: Company example. Variant B: Employee example."}') RETURNING id INTO threads_id;
  INSERT INTO eb_v2_channel_outputs(package_id, channel, status, content)
    VALUES (package_id, 'facebook', 'ready_for_review', '{"text":"Facebook example"}') RETURNING id INTO facebook_id;
  BEGIN
    PERFORM eb_v2_save_review(threads_id, 'done', NULL, NULL, NULL);
    RAISE EXCEPTION 'Missing variant selection was accepted';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM <> 'Choose Variant A, Variant B, or both' THEN RAISE; END IF;
  END;
  BEGIN
    PERFORM eb_v2_save_review(threads_id, 'done', 'c', NULL, NULL);
    RAISE EXCEPTION 'Invalid variant was accepted';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM <> 'Choose Variant A, Variant B, or both' THEN RAISE; END IF;
  END;
  FOREACH choice IN ARRAY ARRAY['a', 'b', 'both'] LOOP
    PERFORM eb_v2_save_review(threads_id, 'done', choice, 'Reviewer choice', NULL);
    SELECT content INTO result FROM eb_v2_channel_outputs WHERE id = threads_id AND status = 'done';
    IF result->>'approvedVariants' IS DISTINCT FROM choice THEN RAISE EXCEPTION 'Selection not persisted'; END IF;
    SELECT count(*) INTO signal_count FROM eb_v2_learning_signals s JOIN eb_v2_review_actions r ON r.id = s.review_action_id
      WHERE r.channel_output_id = threads_id AND s.active AND r.approved_variants = choice
        AND s.evidence->>'approvedVariants' = choice AND s.evidence->>'content' = result->>'text';
    IF signal_count <> 1 THEN RAISE EXCEPTION 'Missing active observation/snapshot'; END IF;
  END LOOP;
  SELECT count(*) INTO signal_count FROM eb_v2_learning_signals s JOIN eb_v2_review_actions r ON r.id = s.review_action_id
    WHERE r.channel_output_id = threads_id AND s.active;
  IF signal_count <> 1 THEN RAISE EXCEPTION 'Superseded observations still active'; END IF;
  PERFORM eb_v2_save_review(threads_id, 'recheck', NULL, NULL, NULL);
  SELECT content INTO result FROM eb_v2_channel_outputs WHERE id = threads_id;
  IF result ? 'approvedVariants' THEN RAISE EXCEPTION 'Recheck retained approval'; END IF;
  IF EXISTS (SELECT 1 FROM eb_v2_learning_signals s JOIN eb_v2_review_actions r ON r.id = s.review_action_id WHERE r.channel_output_id = threads_id AND s.active) THEN
    RAISE EXCEPTION 'Recheck retained active observation';
  END IF;
  PERFORM eb_v2_save_review(facebook_id, 'done', NULL, NULL, NULL);
  BEGIN
    PERFORM eb_v2_save_review(facebook_id, 'done', 'a', NULL, NULL);
    RAISE EXCEPTION 'Facebook accepted variants';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM <> 'Variant selection applies only to Threads approvals' THEN RAISE; END IF;
  END;
  UPDATE eb_v2_channel_outputs SET content = content || '{"archived":true}'::jsonb WHERE id = threads_id;
  SELECT count(*) INTO before_count FROM eb_v2_review_actions WHERE channel_output_id = threads_id;
  BEGIN
    PERFORM eb_v2_save_review(threads_id, 'done', 'a', NULL, NULL);
    RAISE EXCEPTION 'Archived revision was approved';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM <> 'Only a current, generated output can be reviewed' THEN RAISE; END IF;
  END;
  SELECT count(*) INTO signal_count FROM eb_v2_review_actions WHERE channel_output_id = threads_id;
  IF signal_count <> before_count THEN RAISE EXCEPTION 'Failed approval changed audit log'; END IF;
END;
$$;
ROLLBACK;
