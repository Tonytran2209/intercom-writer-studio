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
    if (await exists("writer_ai_usage")) {
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
    await client.query("COMMIT")
    return {
      buckets: buckets.slice(0, 10000),
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
