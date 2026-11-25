// @effect-diagnostics nodeBuiltinImport:off globalConsole:off -- Host-side CI retains reports in the common Git directory.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !(error instanceof Error && "code" in error && error.code === "ESRCH");
  }
}

export function pruneCiDiagnostics(root: string, currentDirectory: string): void {
  const inactive = [];
  for (const entry of NodeFS.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || !/^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/i.test(entry.name))
      continue;
    const directory = NodePath.join(root, entry.name);
    if (directory === currentDirectory) continue;
    try {
      const path = NodePath.join(directory, "report.json");
      const report = JSON.parse(NodeFS.readFileSync(path, "utf8")) as {
        status?: string;
        ownerPid?: number;
      };
      if (
        report.status === "running" &&
        (report.ownerPid === undefined || isProcessRunning(report.ownerPid))
      )
        continue;
      if (!["running", "passed", "failed", "incomplete"].includes(report.status ?? "")) continue;
      inactive.push({ directory, modifiedAt: NodeFS.statSync(path).mtimeMs });
    } catch {
      // A concurrent writer or cleanup may temporarily leave a report unreadable.
    }
  }
  inactive.sort((left, right) => right.modifiedAt - left.modifiedAt);
  for (const { directory } of inactive.slice(10))
    NodeFS.rmSync(directory, { recursive: true, force: true });
}

export function writeCiFailingSteps(
  results: ReadonlyArray<{ readonly label: string; readonly status: string }>,
  path = process.env.LASTCODE_CHECKPOINT_FAILURE_STEPS_PATH,
): void {
  if (!path) return;
  try {
    const pending = `${path}.pending`;
    NodeFS.writeFileSync(
      pending,
      `${JSON.stringify(results.filter((result) => result.status === "failed").map((result) => result.label))}\n`,
      { mode: 0o600 },
    );
    NodeFS.renameSync(pending, path);
  } catch {
    console.warn("[lastcode:ci] Could not retain checkpoint failed-step names.");
  }
}

export function withCiFailingSteps(
  operation: (path: string | undefined) => void,
  overrides: {
    readonly createDirectory?: () => string;
    readonly removeDirectory?: (path: string) => void;
  } = {},
): void {
  let directory: string | undefined;
  try {
    directory = (
      overrides.createDirectory ??
      (() => NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "lastcode-checkpoint-ci-")))
    )();
  } catch {
    console.warn("[lastcode:ci] Could not retain checkpoint failed-step names.");
  }
  const path = directory ? NodePath.join(directory, "failing-steps.json") : undefined;
  try {
    operation(path);
  } catch (error) {
    try {
      const names: unknown = path ? JSON.parse(NodeFS.readFileSync(path, "utf8")) : undefined;
      if (
        error instanceof Error &&
        Array.isArray(names) &&
        names.every((name) => typeof name === "string")
      )
        Object.assign(error, { failingSteps: names });
    } catch {
      /* Keep the validation error when optional diagnostics are unavailable. */
    }
    throw error;
  } finally {
    if (directory) {
      try {
        (
          overrides.removeDirectory ??
          ((path) => NodeFS.rmSync(path, { recursive: true, force: true }))
        )(directory);
      } catch {
        console.warn("[lastcode:ci] Could not remove checkpoint CI diagnostics directory.");
      }
    }
  }
}
