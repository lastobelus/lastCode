import { createActionReporter } from "@t3tools/shared/actionResumeProtocol";

/**
 * Structured reporting for LastCode's repository-owned resumable Project Actions.
 * Outside a resumable run, reports remain readable ordinary terminal output.
 */
export const lastCodeAction = createActionReporter({
  env: process.env,
  write: (data) => process.stdout.write(data),
  log: (message) => process.stdout.write(`${message}\n`),
});
