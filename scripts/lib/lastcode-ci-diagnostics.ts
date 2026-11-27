// @effect-diagnostics nodeBuiltinImport:off -- Host-side CI retains reports in the common Git directory.
import * as NodeFS from "node:fs";
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
