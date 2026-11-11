import { PACKAGE_STAGES, sendPackageRunTelemetry } from "./telemetry.ts";

const durationsMs = [6500, 4800, 5200, 14500, 12800, 11200, 9600, 11700];

async function main(): Promise<void> {
  const stages = PACKAGE_STAGES.map((stage, index) => ({
    ...stage,
    durationMs: durationsMs[index],
    status: "SUCCESS" as const,
  }));

  console.log("Dispatching simulated intercom-writer-studio package run telemetry...");

  const success = await sendPackageRunTelemetry({
    stages,
    durationMs: 76300,
    responseTimeMs: 180,
    clickLatencyMs: 95,
    workload: "1 topic / 4 channels",
    status: "SUCCESS",
  });

  console.log(`Telemetry response: ${success ? "success" : "failure"}`);
  process.exitCode = success ? 0 : 1;
}

main().catch((error: unknown) => {
  console.error("Telemetry response: failure", error);
  process.exitCode = 1;
});
