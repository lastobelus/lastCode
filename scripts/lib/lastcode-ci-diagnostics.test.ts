// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { expect, it } from "vite-plus/test";
import { pruneCiDiagnostics } from "./lastcode-ci-diagnostics.ts";

it("keeps ten recent inactive reports, the current run and another live run", () => {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "ci-diagnostics-"));
  const report = (index: number, status: string) => {
    const directory = NodePath.join(
      root,
      `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
    );
    NodeFS.mkdirSync(directory);
    const path = NodePath.join(directory, "report.json");
    NodeFS.writeFileSync(path, JSON.stringify({ status, ownerPid: process.pid }));
    NodeFS.writeFileSync(NodePath.join(directory, "1.log"), "retained check output");
    NodeFS.utimesSync(path, index, index);
    return directory;
  };
  try {
    const finished = Array.from({ length: 12 }, (_, index) =>
      report(index + 1, ["passed", "failed", "incomplete"][index % 3]!),
    );
    const current = report(0, "incomplete");
    const live = report(13, "running");
    const exited = NodeChildProcess.spawnSync(process.execPath, ["-e", "process.exit(0)"]);
    expect(exited.status).toBe(0);
    const abandoned = report(15, "running");
    const abandonedReport = NodePath.join(abandoned, "report.json");
    NodeFS.writeFileSync(
      abandonedReport,
      JSON.stringify({ status: "running", ownerPid: exited.pid }),
    );
    NodeFS.utimesSync(abandonedReport, 0, 0);
    const unrelated = NodePath.join(root, "notes");
    NodeFS.mkdirSync(unrelated);
    const unreadable = NodePath.join(root, "00000000-0000-4000-8000-000000000014");
    NodeFS.mkdirSync(unreadable);
    NodeFS.writeFileSync(NodePath.join(unreadable, "report.json"), "{");

    pruneCiDiagnostics(root, current);

    expect(finished.map((directory) => NodeFS.existsSync(directory))).toEqual([
      false,
      false,
      true,
      true,
      true,
      true,
      true,
      true,
      true,
      true,
      true,
      true,
    ]);
    expect(NodeFS.readFileSync(NodePath.join(finished.at(-1)!, "1.log"), "utf8")).toBe(
      "retained check output",
    );
    for (const directory of [current, live, unrelated, unreadable])
      expect(NodeFS.existsSync(directory)).toBe(true);
    expect(NodeFS.existsSync(abandoned)).toBe(false);
  } finally {
    NodeFS.rmSync(root, { recursive: true, force: true });
  }
});
