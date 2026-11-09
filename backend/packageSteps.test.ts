import test from "node:test"
import assert from "node:assert/strict"
import { PGlite } from "@electric-sql/pglite"
import { gateStepName, packageRun, pipelineSteps, labProfile, PACKAGE_JOB } from "./packageSteps.ts"
import { readMonitoringData } from "./monitoringData.ts"

test("gate runs map to pipeline sub-jobs by stage", () => {
  assert.equal(gateStepName("brief", "extract_mapping"), "Trích xuất brief")
  assert.equal(gateStepName("article", "article_spec"), "Article Spec")
  assert.equal(gateStepName("article", "outline"), "Lập outline")
  assert.equal(gateStepName("article", "draft"), "Viết bài")
  assert.equal(gateStepName("article", "feedback"), "Sửa bài theo feedback")
  assert.equal(gateStepName("adapt", "channel_adaptation:linkedin"), "Chuyển thể LinkedIn")
  assert.equal(gateStepName("adapt", "feedback:threads"), "Sửa post theo feedback")
  assert.equal(gateStepName("review", "repetition_check"), "Kiểm tra trùng lặp")
  assert.deepEqual(labProfile.mainJob, { job: PACKAGE_JOB, steps: pipelineSteps })
  assert.ok(pipelineSteps.every((step) => labProfile.jobTargets[step] > 0))
  assert.equal(labProfile.errorRateTarget, 1, "success target ≥ 99%")
})

test("a package run counts processing time once and leaves out approvals and feedback", () => {
  const g = (job: string, from: string, to: string, status = "success") => ({ runId: job + from, job, status, startedAt: "2026-11-01T" + from + "Z", endedAt: "2026-11-01T" + to + "Z" })
  const gates = [
    g("Trích xuất brief", "09:00:00", "09:00:05"),
    g("Article Spec", "10:00:00", "10:00:07"), g("Lập outline", "10:00:07", "10:00:15"), g("Viết bài", "10:00:15", "10:00:21"),
    g("Chuyển thể Facebook", "11:00:00", "11:00:08"), g("Chuyển thể LinkedIn", "11:00:00", "11:00:10"), g("Chuyển thể Threads", "11:00:01", "11:00:06"),
    g("Kiểm tra trùng lặp", "11:00:10", "11:00:19"),
    g("Sửa bài theo feedback", "15:00:00", "15:00:30"),
  ]
  const run = packageRun({ id: "p1", workload: "1 package · Gen Z", state: "review" }, gates)!
  assert.equal(run.job, PACKAGE_JOB)
  assert.equal(run.status, "success")
  assert.equal(run.endedAt, "2026-11-01T11:00:19.000Z", "ends at the last pipeline step, not at a later feedback revision")
  assert.equal(Date.parse(run.endedAt!) - Date.parse(run.startedAt!), (5 + 21 + 10 + 9) * 1000, "parallel channels count once; approval waits are excluded")
  assert.equal(packageRun({ id: "p2", workload: "w", state: "brief" }, gates), null, "a package waiting for approval is not scored")
  const retried = packageRun({ id: "p3", workload: "w", state: "review" }, [...gates, g("Chuyển thể Threads", "11:00:20", "11:00:22", "failed")])!
  assert.equal(retried.status, "failed", "the latest run of a step failed")
})

test("the report sends package runs and stage-level gate runs to AI Agent Lab", async () => {
  const db = new PGlite()
  const previous = process.env.DATABASE_PROVIDER
  process.env.DATABASE_PROVIDER = "postgres"
  try {
    await db.exec(`CREATE TABLE kv_store(key text primary key,value jsonb);
 CREATE TABLE eb_v2_packages(id text, title text, state text);
 CREATE TABLE eb_v2_gate_runs(id text, package_id text, gate text, stage text, status text, output_snapshot jsonb, started_at timestamptz, completed_at timestamptz, error_message text, created_at timestamptz default now(), model_provider text, model_id text, input_tokens int, cached_input_tokens int, output_tokens int, cost_usd numeric);
 INSERT INTO eb_v2_packages VALUES ('done','Gen Z careers','review'),('wait','Waiting','brief');
 INSERT INTO eb_v2_gate_runs(id,package_id,gate,stage,status,output_snapshot,started_at,completed_at) VALUES
   ('g1','done','brief','extract_mapping','completed','{"content":"x"}',now() - interval '2 hours', now() - interval '2 hours' + interval '4 seconds'),
   ('g2','done','article','draft','completed','{"content":"x"}',now() - interval '1 hour', now() - interval '1 hour' + interval '6 seconds'),
   ('g3','done','adapt','channel_adaptation:facebook','completed','{"content":"x"}',now() - interval '30 minutes', now() - interval '30 minutes' + interval '7 seconds'),
   ('g4','wait','brief','extract_mapping','completed','{"content":"x"}',now() - interval '10 minutes', now() - interval '10 minutes' + interval '3 seconds');`)
    const client = { query: async (sql: string, values?: any[]) => db.query(sql, values), release: () => {} }
    const result: any = await readMonitoringData("2020-01-01T00:00:00.000Z", { connect: async () => client, totalCount: 1, idleCount: 0, waitingCount: 0 } as any)
    const runs = result.jobRuns?.runs ?? []
    const pkg = runs.find((r: any) => r.runId === "package:done")
    assert.deepEqual([pkg.job, pkg.workload, pkg.status, Date.parse(pkg.endedAt) - Date.parse(pkg.startedAt)], [PACKAGE_JOB, "1 package · Gen Z careers", "success", 17000])
    assert.deepEqual(runs.filter((r: any) => r.parentRunId === "package:done").map((r: any) => r.job).sort(), ["Chuyển thể Facebook", "Trích xuất brief", "Viết bài"])
    assert.equal(runs.some((r: any) => r.runId === "package:wait"), false, "no package run while waiting for approval")
    assert.equal(runs.find((r: any) => r.runId === "g4").parentRunId, "package:wait", "its gate runs are still listed for the group")
    assert.equal(result.jobHistoryAllTime?.executed, 4, "package runs are not counted as gate executions")
  } finally {
    if (previous === undefined) delete process.env.DATABASE_PROVIDER
    else process.env.DATABASE_PROVIDER = previous
    await db.close()
  }
})
