export type TelemetryStatus = "SUCCESS" | "ERROR" | "SKIPPED";

export interface PackageStage {
  code: string;
  name: string;
  nameEn?: string;
  description?: string;
  descriptionEn?: string;
  stepType?: "AI" | "NON_AI";
  model?: string;
  inputTokens?: number;
  outputTokens?: number;
  costUsd?: number;
  durationMs: number;
  status: TelemetryStatus;
}

export interface SendPackageRunOptions {
  runId?: string;
  workload?: string;
  stages: Array<Omit<PackageStage, "status"> & { status?: TelemetryStatus }>;
  status?: TelemetryStatus;
  errorMessage?: string;
  durationMs?: number;
}

export interface PackageTelemetryTracker {
  stage<T>(code: string, name: string, fn: () => T | Promise<T>): Promise<T>;
  finish(status?: TelemetryStatus, errorMsg?: string): Promise<boolean>;
}

export const PACKAGE_STAGES = [
  { code: "brief_extract", name: "Trích xuất brief", nameEn: "Brief Extraction", stepType: "AI" as const, description: "AI trích xuất thông tin cốt lõi, bối cảnh và dẫn chứng từ input." },
  { code: "article_spec", name: "Article Spec", nameEn: "Article Specification", stepType: "AI" as const, description: "AI chuẩn hóa thông số kỹ thuật bài viết, góc tiếp cận và đối tượng đọc." },
  { code: "outline", name: "Lập outline", nameEn: "Outline Generation", stepType: "AI" as const, description: "AI lập dàn ý chi tiết cấu trúc bài viết chuẩn EB." },
  { code: "draft", name: "Viết bài", nameEn: "Article Drafting", stepType: "AI" as const, description: "AI viết hoàn chỉnh bài website dựa trên outline và dẫn chứng đã duyệt." },
  { code: "adapt_facebook", name: "Chuyển thể Facebook", nameEn: "Facebook Adaptation", stepType: "AI" as const, description: "AI chuyển thể nội dung bài viết sang định dạng phù hợp kênh Facebook." },
  { code: "adapt_linkedin", name: "Chuyển thể LinkedIn", nameEn: "LinkedIn Adaptation", stepType: "AI" as const, description: "AI chuyển thể nội dung bài viết sang văn phong chuyên nghiệp cho LinkedIn." },
  { code: "adapt_threads", name: "Chuyển thể Threads", nameEn: "Threads Adaptation", stepType: "AI" as const, description: "AI chuyển thể thành 2 phiên bản A/B song ngữ Việt-Anh cho Threads." },
  { code: "review", name: "Kiểm tra trùng lặp", nameEn: "Repetition Check", stepType: "AI" as const, description: "Kiểm tra trùng lặp nội dung, rà soát quy tắc kênh trước khi hoàn thiện." },
] as const;

const TOOL_SLUG = "intercom-writer-studio";
const JOB_NAME = "Sản xuất gói bài truyền thông đa kênh (EB Package)";
const DEFAULT_DASHBOARD_URL =
  "https://dashboard-tool-performance.up.railway.app";
const REQUEST_TIMEOUT_MS = 3000;

function elapsedMs(start: number): number {
  return Math.max(0, Math.round(performance.now() - start));
}

const AI_GATES = new Set(["brief", "article", "adapt", "review"]);

// USD per 1M tokens (input / cachedInput / output). Returns null for unknown models.
const MODEL_PRICING_PER_M: Array<{ match: RegExp; input: number; cachedInput: number; output: number }> = [
  { match: /gpt-6-sol/i, input: 1.75, cachedInput: 0.175, output: 14.0 },
  { match: /gpt-5(?:\.\d+)?-mini/i, input: 0.25, cachedInput: 0.025, output: 2.0 },
  { match: /gpt-5/i, input: 1.25, cachedInput: 0.125, output: 10.0 },
  { match: /claude-opus/i, input: 15.0, cachedInput: 1.5, output: 75.0 },
  { match: /claude-sonnet/i, input: 3.0, cachedInput: 0.3, output: 15.0 },
  { match: /claude-haiku/i, input: 1.0, cachedInput: 0.1, output: 5.0 },
  { match: /gemini-2\.5-pro/i, input: 1.25, cachedInput: 0.31, output: 10.0 },
  { match: /gemini-2\.5-flash/i, input: 0.3, cachedInput: 0.075, output: 2.5 },
];

export function priceFor(
  model: string | undefined | null,
  inputTokens: number,
  outputTokens: number,
  cachedInputTokens = 0,
): number | null {
  if (!model || (inputTokens <= 0 && outputTokens <= 0 && cachedInputTokens <= 0)) return null;
  const entry = MODEL_PRICING_PER_M.find((p) => p.match.test(model));
  if (!entry) return null;
  const uncachedInput = Math.max(0, inputTokens);
  const usd =
    (uncachedInput * entry.input + cachedInputTokens * entry.cachedInput + outputTokens * entry.output) /
    1_000_000;
  return Number(usd.toFixed(6));
}

const STEP_EN_MAP: Record<string, string> = {
  "Trích xuất brief": "Brief Extraction",
  "Article Spec": "Article Specification",
  "Lập outline": "Outline Generation",
  "Viết bài": "Article Drafting",
  "Chuyển thể Facebook": "Facebook Adaptation",
  "Chuyển thể LinkedIn": "LinkedIn Adaptation",
  "Chuyển thể Threads": "Threads Adaptation",
  "Kiểm tra trùng lặp": "Repetition Check",
};

export function mapGateRunsToTelemetryStages(
  runs: any[],
  stepNameFn: (gate: string, stage: string) => string,
): PackageStage[] {
  const stageDefaults = new Map<string, (typeof PACKAGE_STAGES)[number]>(
    PACKAGE_STAGES.flatMap((ps) => [
      [ps.code, ps],
      [ps.name, ps],
    ]),
  );

  const mapped: PackageStage[] = [];
  for (const r of runs) {
    if (!r) continue;
    const snapDuration = Number(r.output_snapshot?.durationMs);
    const hasSnapshotDuration = Number.isFinite(snapDuration) && snapDuration > 0;
    const startMs = r.started_at ? Date.parse(String(r.started_at)) : NaN;
    const endMs = r.completed_at ? Date.parse(String(r.completed_at)) : NaN;
    const hasCompletedTimestamps = Number.isFinite(startMs) && Number.isFinite(endMs) && endMs >= startMs;
    const isSkipped = r.status === "skipped";

    if (!isSkipped && !hasSnapshotDuration && !hasCompletedTimestamps) {
      continue;
    }

    const durationMs = hasSnapshotDuration
      ? Math.max(1, Math.round(snapDuration))
      : hasCompletedTimestamps
        ? Math.max(1, Math.round(endMs - startMs))
        : 1;

    const name = stepNameFn(String(r.gate || ""), String(r.stage || ""));
    const code = String(r.stage || r.gate || "").replace(":", "_");
    const def = stageDefaults.get(code) ?? stageDefaults.get(name);
    const uncachedInput = Number(r.input_tokens) || 0;
    const cachedInput = Number(r.cached_input_tokens) || 0;
    const inputTokens = uncachedInput + cachedInput;
    const outputTokens = Number(r.output_tokens) || 0;
    const model = r.model_id ? String(r.model_id) : undefined;
    const computedCost = priceFor(model, uncachedInput, outputTokens, cachedInput);
    const status: TelemetryStatus =
      r.status === "completed" ? "SUCCESS" : isSkipped ? "SKIPPED" : "ERROR";

    mapped.push({
      code,
      name,
      nameEn: STEP_EN_MAP[name] || def?.nameEn || name,
      description: def?.description || name,
      stepType: AI_GATES.has(String(r.gate || "")) ? "AI" : (def?.stepType || "NON_AI"),
      ...(model ? { model } : {}),
      ...(inputTokens > 0 ? { inputTokens } : {}),
      ...(outputTokens > 0 ? { outputTokens } : {}),
      ...(computedCost !== null && computedCost > 0 ? { costUsd: computedCost } : {}),
      durationMs,
      status,
    });
  }
  return mapped;
}

export async function sendPackageRunTelemetry(
  options: SendPackageRunOptions,
): Promise<boolean> {
  if (process.env.NODE_ENV === "test" || process.env.FLEARNING_TELEMETRY_DISABLED === "true") {
    return false;
  }

  try {
    const baseUrl = (
      process.env.FLEARNING_DASHBOARD_URL || DEFAULT_DASHBOARD_URL
    ).replace(/\/+$/, "");
    const secret = process.env.FLEARNING_TELEMETRY_SECRET;
    const stageDefaults = new Map<string, (typeof PACKAGE_STAGES)[number]>(
      PACKAGE_STAGES.flatMap((ps) => [
        [ps.code, ps],
        [ps.name, ps],
      ]),
    );
    const stages: PackageStage[] = options.stages.map((stage) => {
      const def = stageDefaults.get(stage.code) ?? stageDefaults.get(stage.name);
      return {
        code: stage.code,
        name: stage.name,
        nameEn: stage.nameEn || def?.nameEn,
        description: stage.description || def?.description || stage.name,
        descriptionEn: stage.descriptionEn,
        stepType: stage.stepType || def?.stepType || "NON_AI",
        model: stage.model,
        inputTokens: stage.inputTokens,
        outputTokens: stage.outputTokens,
        costUsd: stage.costUsd,
        durationMs: stage.durationMs,
        status: stage.status ?? "SUCCESS",
      };
    });

    const totalInputTokens = stages.reduce((sum, s) => sum + (s.inputTokens ?? 0), 0);
    const totalOutputTokens = stages.reduce((sum, s) => sum + (s.outputTokens ?? 0), 0);
    const totalCostUsd = stages.reduce((sum, s) => sum + (s.costUsd ?? 0), 0);
    const aiCallsWithUsage = stages.filter(
      (s) => s.stepType === "AI" && ((s.inputTokens ?? 0) > 0 || (s.outputTokens ?? 0) > 0 || Boolean(s.model)),
    ).length;
    const models = stages.map((s) => s.model).filter((m): m is string => Boolean(m));
    const lastModel = models.at(-1);

    const llmUsage =
      totalInputTokens > 0 || totalOutputTokens > 0 || aiCallsWithUsage > 0
        ? {
            ...(lastModel ? { model: lastModel } : {}),
            ...(totalInputTokens > 0 ? { inputTokens: totalInputTokens } : {}),
            ...(totalOutputTokens > 0 ? { outputTokens: totalOutputTokens } : {}),
            ...(totalCostUsd > 0 ? { estimatedCostUsd: Number(totalCostUsd.toFixed(6)) } : {}),
            ...(aiCallsWithUsage > 0 ? { llmCallsCount: aiCallsWithUsage } : {}),
          }
        : undefined;

    const body = JSON.stringify({
      schemaVersion: "2.2",
      toolSlug: TOOL_SLUG,
      jobName: JOB_NAME,
      runId: options.runId || `run_${Date.now()}`,
      workload: options.workload || "1 topic / 4 channels",
      stages,
      status: options.status ?? "SUCCESS",
      errorMessage: options.errorMessage,
      durationMs:
        options.durationMs ??
        stages.reduce((total, stage) => total + stage.durationMs, 0),
      ...(llmUsage ? { llmUsage } : {}),
    });

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (secret) headers.Authorization = `Bearer ${secret}`;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    try {
      let response = await fetch(
        `${baseUrl}/api/webhooks/telemetry/${TOOL_SLUG}`,
        {
          method: "POST",
          headers,
          body,
          signal: controller.signal,
        },
      );

      if (response.status === 404) {
        response = await fetch(`${baseUrl}/api/telemetry/${TOOL_SLUG}`, {
          method: "POST",
          headers,
          body,
          signal: controller.signal,
        });
      }

      return response.ok;
    } finally {
      clearTimeout(timeout);
    }
  } catch {
    return false;
  }
}

export function startPackageTelemetry(
  workload?: string,
): PackageTelemetryTracker {
  const startedAt = performance.now();
  const stages: PackageStage[] = [];
  let finished = false;

  return {
    async stage<T>(
      code: string,
      name: string,
      fn: () => T | Promise<T>,
    ): Promise<T> {
      const stageStartedAt = performance.now();

      try {
        const result = await fn();
        stages.push({
          code,
          name,
          durationMs: elapsedMs(stageStartedAt),
          status: "SUCCESS",
        });
        return result;
      } catch (error) {
        stages.push({
          code,
          name,
          durationMs: elapsedMs(stageStartedAt),
          status: "ERROR",
        });
        throw error;
      }
    },

    async finish(
      status: TelemetryStatus = "SUCCESS",
      errorMsg?: string,
    ): Promise<boolean> {
      if (finished) return false;
      finished = true;

      return sendPackageRunTelemetry({
        workload,
        stages,
        status,
        errorMessage: errorMsg,
        durationMs: elapsedMs(startedAt),
      });
    },
  };
}