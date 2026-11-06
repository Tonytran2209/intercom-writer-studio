import { jobHistoryWindows } from "./jobHistory.ts"
import { performance } from "node:perf_hooks"
import { databasePool } from "./postgres.ts"
// Fixed aggregate SQL only. No article content, user identity or credentials leave this module.
export async function readMonitoringData(
  since: string,
  override?: ReturnType<typeof databasePool>,
) {
  if (process.env.DATABASE_PROVIDER !== "postgres")
    return {
      buckets: [],
      inventory: undefined,
      contentWorkload: null,
      jobHistory: null,
      jobHistoryAllTime: null,
      database: { status: "unsupported" },
      articles: null,
      plans: null,
      ledger: null,
      complete: false,
    }
  const db = override ?? databasePool(),
    start = performance.now()
  const client = await db.connect()
  try {
    await client.query("BEGIN READ ONLY")
    await client.query("SET LOCAL statement_timeout='4000'")
    const exists = async (table: string) =>
      (
        await client.query("SELECT to_regclass($1) IS NOT NULL AS ok", [
          "public." + table,
        ])
      ).rows[0].ok
    const buckets = (
      await client.query(
        "SELECT key,value FROM public.kv_store WHERE key LIKE 'lab-monitor:v1:%' AND value->>'hour'>=$1 ORDER BY key LIMIT 10001",
        [since],
      )
    ).rows
    const taskRows=(await client.query("SELECT key,value FROM public.kv_store WHERE key LIKE 'lab-task:v1:%' AND value->>'startedAt'>=$1 ORDER BY value->>'startedAt' DESC LIMIT 1001",[since])).rows;
    let historicalTasks:any[]=[];
    if(await exists('article_stage_runs')) historicalTasks=(await client.query(`SELECT id::text AS id,article_id AS "entityId",stage AS label,status,created_at AS "startedAt",input_tokens AS "inputTokens",output_tokens AS "outputTokens",cost_usd::float8 AS "knownCostUsd",model FROM public.article_stage_runs WHERE created_at >= $1 ORDER BY created_at DESC LIMIT 1001`,[since])).rows.map(r=>({...r,kind:'historical-stage',coverage:'Saved final-result usage; may omit retries and cache attribution'}));
    let articles: any = null,
      plans: any = null,
      ledger: any = null
    const inventory: Record<string, any> = {}
    if (await exists("writer_articles")) {
      const rows = await client.query(`WITH candidates AS (
 SELECT value->>'id' AS id,COALESCE(value->>'status','unknown') AS status,1 AS priority FROM public.kv_store WHERE key LIKE 'writer:article:%' AND value->>'id' IS NOT NULL
 UNION ALL SELECT item->>'id',COALESCE(item->>'status','unknown'),2 FROM public.kv_store CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(value)='array' THEN value ELSE '[]'::jsonb END) item WHERE key='writer:articles'
 UNION ALL SELECT id::text,COALESCE(payload->>'status',status,'unknown'),3 FROM public.writer_articles), dedup AS (SELECT DISTINCT ON(id) id,status FROM candidates WHERE id IS NOT NULL ORDER BY id,priority) SELECT status,count(*)::int AS count FROM dedup GROUP BY status`)
      articles = {
        total: rows.rows.reduce((n: number, r: any) => n + r.count, 0),
        byStatus: rows.rows,
        scope: "current inventory; deduplicated KV and relational records",
      }
    }
    if (await exists("content_plans"))
      plans = {
        total: Number(
          (
            await client.query(
              "SELECT count(*) AS count FROM public.content_plans",
            )
          ).rows[0].count,
        ),
        scope: "relational records",
      }
    const usageQueries: string[] = []
    if (await exists("writer_ai_usage")) {
      usageQueries.push(`SELECT called_at AS recorded_at, input_tokens, output_tokens, cost_usd
        FROM public.writer_ai_usage WHERE called_at >= $1 AND NOT cache_hit`)
      const rows = (
        await client.query(
          `SELECT provider,model,step,count(*)::int AS records,count(*) FILTER(WHERE cache_hit)::int AS cache_hits,count(*) FILTER(WHERE NOT cache_hit)::int AS calls,COALESCE(sum(input_tokens) FILTER(WHERE NOT cache_hit),0)::float8 AS input_tokens,COALESCE(sum(cached_input_tokens) FILTER(WHERE NOT cache_hit),0)::float8 AS cached_input_tokens,COALESCE(sum(output_tokens) FILTER(WHERE NOT cache_hit),0)::float8 AS output_tokens,sum(cost_usd) FILTER(WHERE NOT cache_hit)::float8 AS known_cost_usd,count(*) FILTER(WHERE NOT cache_hit AND cost_usd IS NOT NULL)::int AS priced_calls FROM public.writer_ai_usage WHERE called_at >= $1 GROUP BY provider,model,step`,
          [since],
        )
      ).rows
      ledger = {
        source: "writer_ai_usage",
        scope:
          "historically recorded workflow usage; separate from dispatcher telemetry; not additive",
        models: rows,
      }
    }
    for (const table of [
      "content_plan_items",
      "article_stage_runs",
      "batch_jobs",
      "batch_job_items",
      "quality_gate_runs",
      "editorial_approvals",
      "website_content_inventory",
    ] as const) {
      if (await exists(table))
        inventory[table] = (
          await client.query(
            `SELECT status,count(*)::int AS count FROM public.${table} GROUP BY status`,
          )
        ).rows
      else inventory[table] = null
    }
    // EB V2 is the active Intercom workspace; legacy Writer tables are separate.
    if(await exists('eb_v2_articles')) {
      const rows=(await client.query(`SELECT status,count(*)::int AS count FROM (SELECT DISTINCT ON(package_id) package_id,status FROM public.eb_v2_articles ORDER BY package_id,revision DESC) latest GROUP BY status`)).rows;
      const legacy=articles;
      articles={total:(legacy?.total||0)+rows.reduce((n:number,r:any)=>n+r.count,0),byStatus:[...(legacy?.byStatus||[]).map((r:any)=>({...r,status:'Legacy · '+r.status})),...rows.map((r:any)=>({...r,status:'EB V2 · '+r.status}))],scope:'latest EB V2 article per package plus deduplicated legacy inventory; channel outputs counted separately'};
    }
    if(await exists('eb_v2_packages')) inventory.eb_v2_packages=(await client.query('SELECT state AS status,count(*)::int AS count FROM public.eb_v2_packages GROUP BY state')).rows;
    for(const table of ['eb_v2_gate_runs','eb_v2_feedback_threads','eb_v2_library_documents','eb_v2_discovery_items'] as const) {
      inventory[table]=await exists(table)?(await client.query(`SELECT status,count(*)::int AS count FROM public.${table} GROUP BY status`)).rows:null;
    }
    if(await exists('eb_v2_channel_outputs')) inventory.eb_v2_channel_outputs=(await client.query(`SELECT channel||' · '||status AS status,count(*)::int AS count FROM (SELECT DISTINCT ON(package_id,channel) package_id,channel,status FROM public.eb_v2_channel_outputs ORDER BY package_id,channel,revision DESC) latest GROUP BY channel,status`)).rows;
    if(await exists('eb_v2_gate_runs')) {
      const rows=(await client.query(`SELECT model_provider AS provider,model_id AS model,gate||':'||stage AS step,count(*)::int AS records,0::int AS cache_hits,count(*) FILTER(WHERE status='completed')::int AS calls,COALESCE(sum(input_tokens),0)::float8 AS input_tokens,COALESCE(sum(cached_input_tokens),0)::float8 AS cached_input_tokens,COALESCE(sum(output_tokens),0)::float8 AS output_tokens,sum(cost_usd)::float8 AS known_cost_usd,count(*) FILTER(WHERE cost_usd IS NOT NULL)::int AS priced_calls FROM public.eb_v2_gate_runs WHERE created_at >= $1 AND model_provider IS NOT NULL GROUP BY model_provider,model_id,gate,stage`,[since])).rows;
      usageQueries.push(`SELECT created_at AS recorded_at, input_tokens, output_tokens, cost_usd
        FROM public.eb_v2_gate_runs WHERE created_at >= $1
        AND (status = 'completed' OR input_tokens > 0 OR output_tokens > 0 OR cost_usd IS NOT NULL)`)
      ledger={source:'writer_ai_usage + eb_v2_gate_runs',scope:'saved workflow records; EB V2 stores final attempt usage, not every provider retry; never add to dispatcher',models:[...(ledger?.models||[]).map((r:any)=>({...r,source:'legacy'})),...rows.map((r:any)=>({...r,source:'eb-v2'}))]};
    }
    if(await exists('eb_v2_gate_runs')) historicalTasks.push(...(await client.query(`SELECT id::text AS id,package_id::text AS "entityId",gate||':'||stage AS label,status,created_at AS "startedAt",input_tokens AS "inputTokens",cached_input_tokens AS "cachedInputTokens",output_tokens AS "outputTokens",cost_usd::float8 AS "knownCostUsd",model_id AS model FROM public.eb_v2_gate_runs WHERE created_at >= $1 ORDER BY created_at DESC LIMIT 1001`,[since])).rows.map(r=>({...r,kind:'historical-gate',coverage:'Saved final attempt; does not include every retry'})));
    historicalTasks.sort((a,b)=>String(b.startedAt).localeCompare(String(a.startedAt)));
    const jobLimit = 10000
    const history = await exists("eb_v2_gate_runs") ? jobHistoryWindows((await client.query(
      `SELECT 'EB V2 ' || gate AS job, '1 package' AS workload, status,
         (status = 'completed' AND NULLIF(btrim(output_snapshot->>'content'), '') IS NOT NULL) AS valid,
         started_at AS "startedAt", completed_at AS "endedAt", completed_at AS "recordedAt", error_message AS error
       FROM public.eb_v2_gate_runs
       WHERE status IN ('completed', 'failed') AND completed_at IS NOT NULL
       ORDER BY completed_at DESC, id LIMIT $1`, [jobLimit + 1],
    )).rows, since, jobLimit) : { jobHistory: null, jobHistoryAllTime: null }
    const contentWorkload = await exists("eb_v2_articles")
      ? {
          kind: "eb-v2",
          ...(await client.query(`
            WITH latest AS (
              SELECT DISTINCT ON (package_id) body_markdown, status
              FROM public.eb_v2_articles ORDER BY package_id, revision DESC
            ), measured AS (
              SELECT cardinality(regexp_split_to_array(regexp_replace(body_markdown, '^[[:space:]]+|[[:space:]]+$', '', 'g'), '[[:space:]]+')) AS words
              FROM latest WHERE status IN ('draft', 'approved') AND body_markdown ~ '[^[:space:]]'
            )
            SELECT count(*)::int AS articles, count(words)::int AS "lengthSamples",
              avg(words)::float8 AS "averageWords", min(words) AS "minWords", max(words) AS "maxWords"
            FROM measured
          `)).rows[0],
          formats: await exists("eb_v2_channel_outputs") ? (await client.query(`
            WITH latest AS (
              SELECT DISTINCT ON (package_id, channel) channel, content, status
              FROM public.eb_v2_channel_outputs
              WHERE content->'archived' IS DISTINCT FROM 'true'::jsonb
              ORDER BY package_id, channel, revision DESC
            ), measured AS (
              SELECT channel, cardinality(regexp_split_to_array(regexp_replace(content->>'text', '^[[:space:]]+|[[:space:]]+$', '', 'g'), '[[:space:]]+')) AS words
              FROM latest WHERE status IN ('ready_for_review', 'done', 'recheck') AND content->>'text' ~ '[^[:space:]]'
            )
            SELECT channel AS format, count(*)::int AS outputs, avg(words)::float8 AS "averageWords",
              min(words) AS "minWords", max(words) AS "maxWords"
            FROM measured GROUP BY channel ORDER BY channel
          `)).rows : [],
        }
      : null
    await client.query("COMMIT")
    if (ledger && usageQueries.length) {
      ledger.timeline = (await client.query(`
        SELECT date_trunc('hour', recorded_at, 'UTC') AS hour,
          count(*)::int AS calls,
          count(*) FILTER (WHERE input_tokens IS NOT NULL AND output_tokens IS NOT NULL)::int AS "usageSamples",
          count(cost_usd)::int AS "pricedCalls",
          sum(COALESCE(input_tokens, 0) + COALESCE(output_tokens, 0))::float8 AS "totalTokens",
          sum(cost_usd)::float8 AS "knownCostUsd"
        FROM (${usageQueries.join(" UNION ALL ")}) usage
        GROUP BY 1 ORDER BY 1`, [since])).rows
    }
    return {
      buckets: buckets.slice(0, 10000),
      ...history,
      contentWorkload,
      taskRows:taskRows.slice(0,1000),
      historicalTasks:historicalTasks.slice(0,1000),
      taskReadComplete:taskRows.length<=1000&&historicalTasks.length<=1000,
      database: {
        status: "ready",
        responseMs: performance.now() - start,
        poolTotal: db.totalCount,
        poolIdle: db.idleCount,
        poolWaiting: db.waitingCount,
      },
      articles,
      plans,
      ledger,
      inventory,
      complete: buckets.length <= 10000,
    }
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {})
    throw error
  } finally {
    client.release()
  }
}
