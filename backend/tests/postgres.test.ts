import test from "node:test"
import assert from "node:assert/strict"
import { PostgresQuery, identifier } from "../postgres.ts"

test("SQL filters bind values and cannot inject identifiers", () => {
  const query = new PostgresQuery("eb_v2_packages").select("id,title").eq("title", "'; DROP TABLE x;--").in("state", ["brief", "article"]).order("created_at", { ascending: false }).limit(3).compile()
  assert(!query.text.includes("DROP"))
  assert.deepEqual(query.values, ["'; DROP TABLE x;--", "brief", "article", 3])
  assert.throws(() => identifier("packages; DROP TABLE x"))
  assert(new PostgresQuery("eb_v2_packages").in("id", []).compile().text.includes("FALSE"))
})
test("JSON arrays stay JSON while PostgreSQL text arrays stay native", () => {
  const query = new PostgresQuery("content_plan_items").insert({ keywords: ["one"], evidence: [{ id: 1 }], title: "title" }).compile()
  assert.deepEqual(query.values[0], ["one"])
  assert.equal(query.values[1], '[{"id":1}]')
})
test("upsert targets explicit conflict columns and returns rows", () => {
  const query = new PostgresQuery("kv_store").upsert({ key: "writer:config", value: { enabled: true } }, { onConflict: "key" }).compile()
  assert(query.text.includes('ON CONFLICT ("key") DO UPDATE SET "value" = EXCLUDED."value"'))
  assert(query.text.endsWith("RETURNING *"))
  assert.equal(new PostgresQuery("kv_store").insert({ key: "writer:test", value: "plain string" }).compile().values[1], '"plain string"')
})
