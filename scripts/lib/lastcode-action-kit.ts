import { createActionReporter } from "@t3tools/shared/actionResumeProtocol";

type ReporterOptions = Parameters<typeof createActionReporter>[0];

/**
 * Structured reporting for LastCode's repository-owned resumable Project Actions.
 * Outside a resumable run, reports remain readable ordinary terminal output.
 */
export function createLastCodeActionReporter(options: ReporterOptions) {
  const reporter = createActionReporter(options);
  let terminalResultEmitted = false;

  return {
    progress: reporter.progress,
    result(report: Parameters<typeof reporter.result>[0]): void {
      if (terminalResultEmitted) {
        throw new Error("LastCode Actions may emit only one terminal result.");
      }
      terminalResultEmitted = true;
      reporter.result(report);
    },
  };
}

export const lastCodeAction = createLastCodeActionReporter({
  env: process.env,
  write: (data) => process.stdout.write(data),
  log: (message) => process.stdout.write(`${message}\n`),
});
