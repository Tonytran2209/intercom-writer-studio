export type TelemetryStatus = "SUCCESS" | "ERROR";

export interface PackageStage {
  code: string;
  name: string;
  nameEn?: string;
  descriptionEn?: string;
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
  responseTimeMs?: number;
  clickLatencyMs?: number;
}

export interface PackageTelemetryTracker {
  stage<T>(code: string, name: string, fn: () => T | Promise<T>): Promise<T>;
  finish(status?: TelemetryStatus, errorMsg?: string): Promise<boolean>;
}

export const PACKAGE_STAGES = [
  { code: "brief_extract", name: "Trích xuất brief", nameEn: "Brief Extraction" },
  { code: "article_spec", name: "Article Spec", nameEn: "Article Specification" },
  { code: "outline", name: "Lập outline", nameEn: "Outline Generation" },
  { code: "draft", name: "Viết bài", nameEn: "Article Drafting" },
  { code: "adapt_facebook", name: "Chuyển thể Facebook", nameEn: "Facebook Adaptation" },
  { code: "adapt_linkedin", name: "Chuyển thể LinkedIn", nameEn: "LinkedIn Adaptation" },
  { code: "adapt_threads", name: "Chuyển thể Threads", nameEn: "Threads Adaptation" },
  { code: "review", name: "Kiểm tra trùng lặp", nameEn: "Repetition Check" },
] as const;

const TOOL_SLUG = "intercom-writer-studio";
const JOB_NAME = "Sản xuất gói bài truyền thông đa kênh (EB Package)";
const DEFAULT_DASHBOARD_URL =
  "https://dashboard-tool-performance.up.railway.app";
const REQUEST_TIMEOUT_MS = 3000;

function elapsedMs(start: number): number {
  return Math.max(0, Math.round(performance.now() - start));
}

export async function sendPackageRunTelemetry(
  options: SendPackageRunOptions,
): Promise<boolean> {
  try {
    const baseUrl = (
      process.env.FLEARNING_DASHBOARD_URL || DEFAULT_DASHBOARD_URL
    ).replace(/\/+$/, "");
    const secret = process.env.FLEARNING_TELEMETRY_SECRET;
    const stages: PackageStage[] = options.stages.map((stage) => ({
      code: stage.code,
      name: stage.name,
      nameEn: stage.nameEn,
      descriptionEn: stage.descriptionEn,
      durationMs: stage.durationMs,
      status: stage.status ?? "SUCCESS",
    }));

    const body = JSON.stringify({
      schemaVersion: "2.0",
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
      responseTimeMs: options.responseTimeMs ?? 180,
      clickLatencyMs: options.clickLatencyMs ?? 95,
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
  let firstResponseMs: number | undefined;
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
        firstResponseMs ??= elapsedMs(startedAt);
        return result;
      } catch (error) {
        stages.push({
          code,
          name,
          durationMs: elapsedMs(stageStartedAt),
          status: "ERROR",
        });
        firstResponseMs ??= elapsedMs(startedAt);
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
        responseTimeMs: firstResponseMs,
      });
    },
  };
}