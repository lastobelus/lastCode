// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeChildProcess from "node:child_process";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeProcess from "node:process";
import { describe, expect, it } from "vite-plus/test";
import { runCiProcess } from "./lastcode-ci-process.ts";

function writeControllerDeathFixture(cwd: string) {
  NodeFS.writeFileSync(
    NodePath.join(cwd, "descendant.mjs"),
    "process.on('SIGTERM', () => {}); console.log('descendant-ready:' + process.pid); setInterval(() => {}, 1000);",
  );
  NodeFS.writeFileSync(
    NodePath.join(cwd, "launcher.mjs"),
    "import { spawn } from 'node:child_process'; spawn(process.execPath, ['descendant.mjs'], { stdio: 'inherit' }); setInterval(() => {}, 1000);",
  );
  NodeFS.writeFileSync(
    NodePath.join(cwd, "controller.mjs"),
    [
      `import { runCiProcess } from ${JSON.stringify(new URL("./lastcode-ci-process.ts", import.meta.url).href)};`,
      "await runCiProcess({ cwd: process.cwd(), command: process.execPath, args: ['launcher.mjs'], signal: new AbortController().signal, onSpawn: pid => console.log('worker-pid:' + pid) });",
    ].join("\n"),
  );
}

function liveGroupMembers(members: readonly { state: string | undefined }[]) {
  // Zombies have stopped executing; their adopter, rather than CI, owns reaping.
  // Missing state stays live so failed inspection cannot pass cleanup acceptance.
  return members.filter(({ state }) => state?.startsWith("Z") !== true);
}

describe("CI process ownership", () => {
  it.skipIf(NodeProcess.platform !== "linux")(
    "recognizes terminated orphans before their process group is reaped",
    async () => {
      const cwd = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "lastcode-ci-subreaper-"));
      try {
        writeControllerDeathFixture(cwd);
        const output = await new Promise<string>((resolve, reject) => {
          NodeChildProcess.execFile(
            "python3",
            [
              NodePath.join(import.meta.dirname, "fixtures/ci-controller-subreaper.py"),
              process.execPath,
            ],
            { cwd, timeout: 20_000 },
            (error, stdout, stderr) => {
              if (error) reject(new Error(`Subreaper fixture failed: ${stderr}`, { cause: error }));
              else resolve(stdout);
            },
          );
        });
        NodeProcess.stderr.write(`CI controlled orphan-reaping evidence ${output}`);
        const evidence = JSON.parse(output) as {
          controllerExit: number;
          workerPid: number;
          descendantPid: number;
          subreaperPid: number;
          groupProbeError: number | null;
          reapedGroupProbeError: number | null;
          before: Array<{ state: string }>;
          members: Array<{ pid: number; parentPid: number; state: string }>;
        };
        expect(evidence.controllerExit).toBe(-9);
        expect(evidence.groupProbeError).toBeNull();
        expect(evidence.members.find(({ pid }) => pid === evidence.workerPid)?.state).toBe("Z");
        expect(evidence.members.find(({ pid }) => pid === evidence.descendantPid)?.state).toBe("Z");
        expect(
          evidence.members.every(
            ({ state, parentPid }) => state === "Z" && parentPid === evidence.subreaperPid,
          ),
        ).toBe(true);
        expect(liveGroupMembers(evidence.before)).not.toEqual([]);
        expect(liveGroupMembers(evidence.members)).toEqual([]);
        expect(evidence.reapedGroupProbeError).toBe(NodeOS.constants.errno.ESRCH);
      } finally {
        NodeFS.rmSync(cwd, { recursive: true, force: true });
      }
    },
  );

  it.skipIf(NodeProcess.platform === "win32")(
    "finishes descendant cleanup after its controller dies",
    async () => {
      const cwd = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "lastcode-ci-controller-"));
      let workerPid: number | undefined;
      let descendantPid: number | undefined;
      let controller: NodeChildProcess.ChildProcess | undefined;
      const groupState = () => {
        const snapshot = NodeChildProcess.spawnSync("ps", ["-A", "-o", "pid=,ppid=,pgid=,stat="], {
          encoding: "utf8",
          timeout: 5_000,
        });
        return {
          status: snapshot.status,
          error: snapshot.error?.message,
          members: snapshot.stdout
            ?.split("\n")
            .map((line) => line.trim().split(/\s+/u))
            .filter((fields) => Number(fields[2]) === workerPid)
            .map(([pid, parentPid, group, state]) => ({ pid, parentPid, group, state })),
        };
      };
      const recordEvidence = (
        phase: string,
        snapshot: ReturnType<typeof groupState>,
        probeError?: unknown,
      ) => {
        NodeProcess.stderr.write(
          `CI controller-death process evidence ${JSON.stringify({
            phase,
            controllerPid: controller?.pid,
            workerPid,
            descendantPid,
            groupProbeError:
              probeError instanceof Error && "code" in probeError ? probeError.code : null,
            ...snapshot,
          })}\n`,
        );
      };
      try {
        writeControllerDeathFixture(cwd);
        controller = NodeChildProcess.spawn(process.execPath, ["controller.mjs"], {
          cwd,
          stdio: ["ignore", "pipe", "pipe"],
        });
        let output = "";
        const ownedController = controller;
        ownedController.stdout!.on("data", (data: Buffer) => {
          output += data.toString();
          const pid = /worker-pid:(\d+)\r?\n/u.exec(output)?.[1];
          if (pid) workerPid = Number(pid);
          const descendant = /descendant-ready:(\d+)\r?\n/u.exec(output)?.[1];
          if (descendant && workerPid !== undefined && descendantPid === undefined) {
            descendantPid = Number(descendant);
            recordEvidence("before-controller-death", groupState());
            ownedController.kill("SIGKILL");
          }
        });
        await new Promise<void>((resolve, reject) => {
          ownedController.once("error", reject);
          ownedController.once("close", () => resolve());
        });
        // Inherited pipe closure marks termination. Orphan zombies can keep
        // kill(-group, 0) successful until their adopter reaps them.
        expect(output).toContain("descendant-ready");
        expect(workerPid).toBeDefined();
        let probeError: unknown;
        try {
          process.kill(-workerPid!, 0);
        } catch (error) {
          probeError = error;
        }
        const stopped = groupState();
        recordEvidence("after-output-pipe-close", stopped, probeError);
        expect(stopped.error).toBeUndefined();
        expect(stopped.status).toBe(0);
        expect(stopped.members).toBeDefined();
        expect(liveGroupMembers(stopped.members!)).toEqual([]);
      } finally {
        controller?.kill("SIGKILL");
        if (workerPid !== undefined) {
          try {
            process.kill(-workerPid, "SIGKILL");
          } catch {
            // The captured worker's group has already been reaped.
          }
        }
        NodeFS.rmSync(cwd, { recursive: true, force: true });
      }
    },
  );

  it("reports an unsuccessful command", async () => {
    await expect(
      runCiProcess({
        cwd: process.cwd(),
        command: process.execPath,
        args: ["-e", "process.exit(7)"],
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow("exit code 7");
  });

  it("does not spawn work after cancellation", async () => {
    const controller = new AbortController();
    controller.abort(new Error("cancelled before launch"));
    expect(() =>
      runCiProcess({
        cwd: process.cwd(),
        command: process.execPath,
        args: [],
        signal: controller.signal,
      }),
    ).toThrow("cancelled before launch");
  });

  it("does not start the check before ownership has been recorded", async () => {
    const cwd = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "lastcode-ci-start-"));
    try {
      const marker = NodePath.join(cwd, "started");
      await expect(
        runCiProcess({
          cwd,
          command: process.execPath,
          args: ["-e", `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'started')`],
          signal: new AbortController().signal,
          terminationGraceMs: 50,
          onSpawn: () => {
            throw new Error("ownership recording failed");
          },
        }),
      ).rejects.toThrow("ownership recording failed");
      expect(NodeFS.existsSync(marker)).toBe(false);
    } finally {
      NodeFS.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it.skipIf(NodeProcess.platform === "win32")(
    "rejects a successful launcher that leaves a descendant running",
    async () => {
      const cwd = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "lastcode-ci-orphan-"));
      try {
        NodeFS.writeFileSync(
          NodePath.join(cwd, "launcher.mjs"),
          [
            "import { spawn } from 'node:child_process';",
            "const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'inherit' });",
            "child.once('spawn', () => process.exit(0));",
          ].join("\n"),
        );
        await expect(
          runCiProcess({
            cwd,
            command: process.execPath,
            args: ["launcher.mjs"],
            signal: new AbortController().signal,
            terminationGraceMs: 50,
          }),
        ).rejects.toThrow("CI launcher exited before its owned descendants stopped");
      } finally {
        NodeFS.rmSync(cwd, { recursive: true, force: true });
      }
    },
  );

  it.skipIf(NodeProcess.platform === "win32")(
    "cancels resistant descendants before completing",
    async () => {
      const cwd = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "lastcode-ci-process-"));
      const controller = new AbortController();
      try {
        NodeFS.writeFileSync(
          NodePath.join(cwd, "descendant.mjs"),
          [
            "process.on('SIGTERM', () => {});",
            "process.stdout.write('descendant-ready\\n');",
            "setInterval(() => {}, 1000);",
          ].join("\n"),
        );
        NodeFS.writeFileSync(
          NodePath.join(cwd, "launcher.mjs"),
          [
            "import { spawn } from 'node:child_process';",
            "spawn(process.execPath, ['descendant.mjs'], { stdio: ['ignore', process.stdout, process.stderr] });",
            "setInterval(() => {}, 1000);",
          ].join("\n"),
        );
        let output = "";
        const command = runCiProcess({
          cwd,
          command: process.execPath,
          args: ["launcher.mjs"],
          signal: controller.signal,
          terminationGraceMs: 50,
          onOutput: (data) => {
            output += data;
            if (output.includes("descendant-ready"))
              controller.abort(new Error("requested cancellation"));
          },
        });
        // The descendant inherits the captured stdout pipe. Its close is the
        // persisted milestone proving it is gone; no sleep or status polling.
        await expect(command).rejects.toThrow("requested cancellation");
        expect(output).toContain("descendant-ready");
      } finally {
        controller.abort();
        NodeFS.rmSync(cwd, { recursive: true, force: true });
      }
    },
  );
});
