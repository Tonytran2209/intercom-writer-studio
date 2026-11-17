import test from "node:test";
import assert from "node:assert/strict";
import { mapGateRunsToTelemetryStages, sendPackageRunTelemetry } from "./telemetry.ts";

test("mapGateRunsToTelemetryStages maps cached tokens, skipped status, and skips unfinished gates", () => {
  const runs = [
    {
      gate: "brief",
      stage: "extract",
      status: "completed",
      started_at: "2026-11-16T01:00:00.000Z",
      completed_at: "2026-11-16T01:00:04.500Z",
      model_id: "gpt-6-sol",
      input_tokens: 1000,
      cached_input_tokens: 250,
      output_tokens: 300,
    },
    {
      gate: "adapt",
      stage: "adapt:threads",
      status: "skipped",
      started_at: "2026-11-16T01:00:05.000Z",
      completed_at: "2026-11-16T01:00:05.100Z",
    },
    {
      gate: "review",
      stage: "review",
      status: "running",
      started_at: "2026-11-16T01:00:06.000Z",
      completed_at: null,
    },
  ];

  const stages = mapGateRunsToTelemetryStages(runs, (gate, stage) =>
    gate === "brief" ? "Trích xuất brief" : stage === "adapt:threads" ? "Chuyển thể Threads" : "Kiểm tra trùng lặp",
  );

  assert.equal(stages.length, 2);
  assert.equal(stages[0].inputTokens, 1250);
  assert.equal(stages[0].outputTokens, 300);
  assert.equal(stages[0].stepType, "AI");
  assert.equal(stages[0].durationMs, 4500);
  assert.equal(stages[0].status, "SUCCESS");
  assert.ok(typeof stages[0].costUsd === "number" && stages[0].costUsd > 0);

  assert.equal(stages[1].status, "SKIPPED");
  assert.equal(stages[1].durationMs, 100);
});

test("dispatches schemaVersion 2.2 with stepType, description, and aggregated llmUsage", async () => {
  const originalEnv = process.env.NODE_ENV;
  const originalFetch = globalThis.fetch;
  let capturedPayload: any = null;
  process.env.NODE_ENV = "production";

  globalThis.fetch = (async (_url: string, init?: RequestInit) => {
    capturedPayload = JSON.parse(String(init?.body || "{}"));
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  }) as typeof fetch;

  try {
    const ok = await sendPackageRunTelemetry({
      runId: "pkg_unit_1",
      stages: [
        {
          code: "extract",
          name: "Trích xuất brief",
          stepType: "AI",
          model: "gpt-6-sol",
          inputTokens: 1200,
          outputTokens: 300,
          durationMs: 1500,
        },
        {
          code: "adapt_facebook",
          name: "Chuyển thể Facebook",
          stepType: "AI",
          model: "claude-sonnet-5-5",
          inputTokens: 2000,
          outputTokens: 600,
          durationMs: 2200,
        },
      ],
    });

    assert.equal(ok, true);
    assert.equal(capturedPayload.schemaVersion, "2.2");
    assert.equal(capturedPayload.model, undefined);
    assert.equal(capturedPayload.responseTimeMs, undefined);
    assert.equal(capturedPayload.clickLatencyMs, undefined);
    for (const s of capturedPayload.stages) {
      assert.equal(s.stepType, "AI");
      assert.ok(typeof s.description === "string" && s.description.length > 0);
    }
    assert.equal(capturedPayload.llmUsage.inputTokens, 3200);
    assert.equal(capturedPayload.llmUsage.outputTokens, 900);
    assert.equal(capturedPayload.llmUsage.llmCallsCount, 2);
    assert.equal(capturedPayload.llmUsage.model, "claude-sonnet-5-5");
    assert.equal(capturedPayload.llmUsage.estimatedCostUsd, undefined);
  } finally {
    process.env.NODE_ENV = originalEnv;
    globalThis.fetch = originalFetch;
  }
});

test("skips dispatch when NODE_ENV=test and remains fail-safe when fetch throws", async () => {
  const originalEnv = process.env.NODE_ENV;
  const originalFetch = globalThis.fetch;

  try {
    process.env.NODE_ENV = "test";
    const skipped = await sendPackageRunTelemetry({
      runId: "pkg_unit_skip",
      stages: [{ code: "draft", name: "Viết bài", durationMs: 1000 }],
    });
    assert.equal(skipped, false);

    process.env.NODE_ENV = "production";
    globalThis.fetch = (async () => {
      throw new Error("Simulated network error");
    }) as typeof fetch;

    const ok = await sendPackageRunTelemetry({
      runId: "pkg_unit_err",
      stages: [{ code: "draft", name: "Viết bài", durationMs: 1000 }],
    });
    assert.equal(ok, false);
  } finally {
    process.env.NODE_ENV = originalEnv;
    globalThis.fetch = originalFetch;
  }
});
