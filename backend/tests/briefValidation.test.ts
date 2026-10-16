import assert from "node:assert/strict"
import test from "node:test"
import { BriefInputError, hasUnresolvedValue, validateBriefInput } from "../briefValidation.ts"
import type { GenerateRequest } from "../providers.ts"

const model = { provider: "test", modelId: "test" }
const input = "Buổi chia sẻ dự án tháng 10 của đội thiết kế F, có ghi chép trong tài liệu nội bộ."
const connection = "Đội thiết kế F tổ chức buổi chia sẻ dự án vào ngày 15/10."
const evidence = "Biên bản buổi chia sẻ 15/10, người xác nhận: trưởng nhóm thiết kế."
const fields = Array.from({ length: 11 }, (_, i) => ({ name: `Field ${i + 1}`, value: "Concrete supported fact" }))
const report = { valid: true, fields, missingFields: [], questions: [] }
const respond = (value: unknown) => async () => ({ content: JSON.stringify(value), model: "test" })

test("blocks blanks and placeholder values before any AI call", async () => {
  for (const missing of ["", "  ", "N/A", "n / a", "TBD", "Chưa có", "not available", "—"]) {
    let calls = 0
    const generate = async () => { calls++; return { content: "", model: "test" } }
    await assert.rejects(validateBriefInput(input, missing, evidence, model, "", [], generate), BriefInputError)
    await assert.rejects(validateBriefInput(input, connection, missing, model, "", [], generate), BriefInputError)
    assert.equal(calls, 0)
  }
  assert.equal(hasUnresolvedValue("Thiết kế NA Studio chia sẻ dữ liệu"), false)
  assert.equal(hasUnresolvedValue("Trước đây F chưa có quy trình này; ngày 15/10 đội đã triển khai."), false)
})
test("does not accept N/A anywhere in the submitted topic", async () => {
  await assert.rejects(validateBriefInput("Sự kiện F. Ngày: N/A", connection, evidence, model, "", [], respond(report)), BriefInputError)
})
test("returns every missing question to the writer", async () => {
  await assert.rejects(validateBriefInput(input, connection, evidence, model, "", [], respond({ ...report, valid: false, missingFields: ["Ngày sự kiện"], questions: ["Ai xác nhận?", "Mục tiêu cụ thể là gì?"] })), error => {
    assert.match(String(error), /Ngày sự kiện/)
    assert.match(String(error), /Ai xác nhận/)
    assert.match(String(error), /Mục tiêu/)
    return true
  })
})
test("rejects an AI pass with missing, duplicate, or unresolved checked fields", async () => {
  for (const checked of [[], fields.slice(0, 1), Array(11).fill(fields[0]), [...fields.slice(0, 10), { name: "Event date", value: "N/A" }]])
    await assert.rejects(validateBriefInput(input, connection, evidence, model, "", [], respond({ ...report, fields: checked })), BriefInputError)
})
test("fails closed on malformed AI validation", async () => {
  for (const value of [null, [], "approved", { valid: true, fields: {} }])
    await assert.rejects(validateBriefInput(input, connection, evidence, model, "", [], respond(value)), BriefInputError)
})
test("passes complete input and includes the current settings rules and library", async () => {
  let request: GenerateRequest | undefined
  const result = await validateBriefInput(input, connection, evidence, model, "CURRENT INPUT RULES", ["Reference checklist"], async value => {
    request = value
    return { content: JSON.stringify(report), model: "test" }
  })
  assert.equal(result.connection, connection)
  assert.equal(result.evidence, evidence)
  assert.match(request?.systemPrompt ?? "", /CURRENT INPUT RULES/)
  assert.deepEqual(request?.contextDocs, ["Reference checklist"])
})

test("extracts F connection and evidence from a single free-text input", async () => {
  const unified = `${input}\n${connection}\nNguồn: ${evidence}`
  const result = await validateBriefInput(unified, "", "", model, "", [], respond({ ...report, connection, evidence }))
  assert.equal(result.connection, connection)
  assert.equal(result.evidence, evidence)
})
test("unified input still cannot pass without a concrete F connection and evidence", async () => {
  for (const values of [{ connection: "", evidence }, { connection, evidence: "" }, { connection: "N/A", evidence }, {}])
    await assert.rejects(validateBriefInput(input, "", "", model, "", [], respond({ ...report, ...values })), BriefInputError)
})
