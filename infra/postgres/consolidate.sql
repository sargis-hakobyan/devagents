-- Copy by column name, including the original identifiers, ordering and volume bindings.
-- All changes, including retirement of the recognized source tables, share the install transaction.
SET LOCAL row_security = off;
DO $$
DECLARE
  src text; tenant uuid; t text; cols text; scoped boolean; seq_col text;
  old_tables text[]; copied bigint; expected bigint;
  domain_tables text[] := ARRAY['projects','tasks','events','requests','evidence','teams','team_revisions',
    'dispatch_queue','task_concurrency','model_catalogs','trackers','pull_requests','work_item_concurrency',
    'workspace_owner','shared_task_handoffs','checkpoint_binding','execution_settings','schema_versions',
    'users','password_accounts','mastra_workflow_snapshot','mastra_workflow_run_owners'];
BEGIN
  FOR src IN SELECT nspname FROM pg_namespace
    WHERE nspname IN ('devagents','devagents_workspace') OR nspname ~ '^wf_[0-9a-f]{32}$'
  LOOP
    IF NOT pg_try_advisory_xact_lock(hashtextextended(src, 1)) THEN
      RAISE EXCEPTION 'Stop the service using % before upgrading',src;
    END IF;
    IF src = 'devagents' THEN
      old_tables := ARRAY['task_runs','task_history','workflow_stores'];
    ELSE
      old_tables := domain_tables;
      tenant := CASE WHEN src='devagents_workspace' THEN '00000000-0000-4000-8000-000000000000'::uuid
                     ELSE substring(src FROM 4)::uuid END;
      IF to_regclass(format('%I.workspace_owner',src)) IS NOT NULL AND src <> 'devagents_workspace' THEN
        EXECUTE format('SELECT EXISTS(SELECT FROM %I.workspace_owner WHERE user_id <> $1)', src) INTO scoped USING tenant::text;
        IF scoped THEN RAISE EXCEPTION 'Legacy owner mismatch in %',src; END IF;
      END IF;
    END IF;
    FOREACH t IN ARRAY old_tables LOOP
      IF to_regclass(format('%I.%I',src,t)) IS NULL THEN CONTINUE; END IF;
      EXECUTE format('LOCK TABLE %I.%I IN ACCESS EXCLUSIVE MODE',src,t);
      SELECT string_agg(quote_ident(attname), ', ' ORDER BY attnum) INTO cols FROM pg_attribute
        WHERE attrelid=format('%I.%I',src,t)::regclass AND attnum>0 AND NOT attisdropped;
      scoped := src <> 'devagents' AND t NOT IN ('users','password_accounts');
      IF scoped THEN
        EXECUTE format('INSERT INTO public.%I (%s,workspace_id) SELECT %s,$1 FROM %I.%I', t,cols,cols,src,t) USING tenant;
      ELSE
        EXECUTE format('INSERT INTO public.%I (%s) SELECT %s FROM %I.%I',t,cols,cols,src,t);
      END IF;
      GET DIAGNOSTICS copied = ROW_COUNT;
      EXECUTE format('SELECT count(*) FROM %I.%I',src,t) INTO expected;
      IF expected <> copied THEN RAISE EXCEPTION 'Incomplete copy of %.%',src,t; END IF;
      seq_col := CASE WHEN t IN ('events','evidence') THEN 'sequence'
                      WHEN t IN ('tasks','dispatch_queue','pull_requests','shared_task_handoffs') THEN 'insertion_order' END;
      IF seq_col IS NOT NULL THEN
        EXECUTE format('INSERT INTO public.workspace_counters(workspace_id,stream,value) SELECT $1,$2,coalesce(max(%I),0) FROM %I.%I',seq_col,src,t)
          USING tenant,t;
      END IF;
    END LOOP;
    IF src='devagents_workspace' THEN
      UPDATE public.checkpoint_binding SET store_id='workspace:' || tenant::text
        WHERE workspace_id=tenant AND store_id='workspace:devagents_workspace';
    END IF;
    -- RESTRICT makes unexpected tables, functions or external dependencies abort the whole upgrade.
    FOR i IN REVERSE cardinality(old_tables)..1 LOOP
      EXECUTE format('DROP TABLE IF EXISTS %I.%I RESTRICT', src,old_tables[i]);
    END LOOP;
    EXECUTE format('DROP FUNCTION IF EXISTS %I.reject_history_change() RESTRICT',src);
    EXECUTE format('DROP SCHEMA %I RESTRICT',src);
  END LOOP;
END $$;
