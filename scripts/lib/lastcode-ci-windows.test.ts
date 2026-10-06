// @effect-diagnostics nodeBuiltinImport:off -- Windows command fixtures use their own temporary workspace.
import * as NodeFS from "node:fs";
import * as NodeChildProcess from "node:child_process";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeProcess from "node:process";
import { it as effectIt } from "@effect/vitest";
import { HostProcessEnvironment, HostProcessPlatform } from "@t3tools/shared/hostProcess";
import { resolveSpawnCommand, SpawnExecutableResolution } from "@t3tools/shared/shell";
import * as Effect from "effect/Effect";
import { describe, expect, it } from "vite-plus/test";

import { runCiProcess } from "./lastcode-ci-process.ts";
import { buildWindowsCiLaunch, serializeWindowsNativeArguments } from "./lastcode-ci-windows.ts";

describe("Windows CI command serialization", () => {
  it("preserves empty arguments, literal quotes, and trailing backslashes for native programs", () => {
    expect(
      serializeWindowsNativeArguments([
        "",
        "two words",
        'say "hello"',
        "C:\\trailing\\",
        "α & %PATH% !",
      ]),
    ).toBe('"" "two words" "say \\"hello\\"" "C:\\trailing\\\\" "α & %PATH% !"');
    expect(() => serializeWindowsNativeArguments(["bad\0argument"])).toThrow("NUL");
  });

  effectIt.effect("reuses the shared resolver's Windows command-shim escaping", () =>
    Effect.gen(function* () {
      const env = {
        ComSpec: "C:\\Windows\\System32\\cmd.exe",
        PATH: "",
        PATHEXT: ".COM;.EXE;.BAT;.CMD",
      };
      const resolved = yield* resolveSpawnCommand(
        "vp",
        ["run", "value & calc", "%PATH%", 'quote"value'],
        { env },
      ).pipe(
        Effect.provideService(HostProcessPlatform, "win32"),
        Effect.provideService(HostProcessEnvironment, env),
        Effect.provideService(
          SpawnExecutableResolution,
          () => "C:\\Program Files\\npm & tools\\vp.cmd",
        ),
      );
      expect(buildWindowsCiLaunch(resolved, env)).toEqual({
        filePath: env.ComSpec,
        argumentLine: `/d /s /v:off /c "${[resolved.command, ...resolved.args].join(" ")}"`,
      });
      expect(resolved.command).toContain("^&");
      expect(resolved.args).toEqual([
        '^"run^"',
        '^"value^ ^&^ calc^"',
        '^"^%PATH^%^"',
        '^"quote\\^"value^"',
      ]);
    }),
  );

  it("passes native executable arguments without cmd interpretation", () => {
    expect(
      buildWindowsCiLaunch({
        command: "C:\\Program Files\\node.exe",
        args: ["value & calc", "%PATH%"],
        shell: false,
      }),
    ).toEqual({
      filePath: "C:\\Program Files\\node.exe",
      argumentLine: '"value & calc" "%PATH%"',
    });
  });
});

describe("Windows CI job execution", () => {
  it.skipIf(NodeProcess.platform !== "win32")(
    "preserves native arguments through the job owner",
    async () => {
      const args = ["", "two words", 'quote"value', "C:\\trailing\\", "α & %PATH% !"];
      let output = "";
      await runCiProcess({
        cwd: NodeProcess.cwd(),
        command: NodeProcess.execPath,
        args: ["-e", "process.stdout.write(JSON.stringify(process.argv.slice(1)))", "--", ...args],
        signal: new AbortController().signal,
        onOutput: (value) => {
          output += value;
        },
      });
      expect(JSON.parse(output)).toEqual(args);
    },
    20_000,
  );

  it.skipIf(NodeProcess.platform !== "win32")(
    "runs a Windows command shim through the job owner",
    async () => {
      const cwd = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "lastcode-ci-cmd-"));
      try {
        NodeFS.writeFileSync(
          NodePath.join(cwd, "echo.mjs"),
          "process.stdout.write(JSON.stringify(process.argv.slice(2)));\n",
        );
        NodeFS.writeFileSync(
          NodePath.join(cwd, "echo.cmd"),
          '@echo off\r\n"%LASTCODE_CI_NODE%" "%~dp0echo.mjs" %*\r\n',
        );
        let output = "";
        const args = ["two words", "hello & goodbye", "%PATH%", 'quote"value'];
        await runCiProcess({
          cwd,
          command: NodePath.join(cwd, "echo.cmd"),
          args,
          env: { ...NodeProcess.env, LASTCODE_CI_NODE: NodeProcess.execPath },
          signal: new AbortController().signal,
          onOutput: (value) => {
            output += value;
          },
        });
        expect(JSON.parse(output)).toEqual(args);
      } finally {
        NodeFS.rmSync(cwd, { recursive: true, force: true });
      }
    },
    20_000,
  );

  it.skipIf(NodeProcess.platform !== "win32")(
    "holds the job after its launcher exits until a hidden descendant finishes",
    async () => {
      const cwd = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "lastcode-ci-windows-tree-"));
      const controller = new AbortController();
      let ownedCommand: Promise<void> | undefined;
      try {
        NodeFS.writeFileSync(
          NodePath.join(cwd, "descendant.mjs"),
          [
            "import * as fs from 'node:fs';",
            "const watcher = fs.watch('.', () => {",
            "  if (!fs.existsSync('release')) return;",
            "  watcher.close(); fs.writeFileSync('finished', 'done'); process.exit(0);",
            "});",
            "process.send('ready');",
          ].join("\n"),
        );
        NodeFS.writeFileSync(
          NodePath.join(cwd, "launcher.mjs"),
          [
            "import { spawn } from 'node:child_process';",
            "process.stdout.write(`launcher-pid:${process.pid}\\n`);",
            "const child = spawn(process.execPath, ['descendant.mjs'], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });",
            "child.once('message', () => { process.stdout.write('descendant-ready\\n'); process.exit(0); });",
          ].join("\n"),
        );
        let output = "";
        let completed = false;
        let descendantReady: (() => void) | undefined;
        const ready = new Promise<void>((resolve) => {
          descendantReady = resolve;
        });
        const command = runCiProcess({
          cwd,
          command: NodeProcess.execPath,
          args: ["launcher.mjs"],
          signal: controller.signal,
          onOutput: (value) => {
            output += value;
            if (output.includes("descendant-ready")) descendantReady?.();
          },
        });
        ownedCommand = command;
        void command.then(
          () => {
            completed = true;
          },
          () => undefined,
        );
        await Promise.race([
          ready,
          command.then(() => {
            throw new Error("Windows CI completed before its descendant was ready.");
          }),
        ]);
        const launcherPid = /launcher-pid:(\d+)/u.exec(output)?.[1];
        expect(launcherPid).toBeDefined();
        // Wait for this fixture's exact captured launcher to exit. This milestone
        // makes an early-success assertion independent of arbitrary test sleeps.
        const observer = NodeChildProcess.spawn(
          "powershell.exe",
          [
            "-NoLogo",
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            `$p = Get-Process -Id ${launcherPid} -ErrorAction SilentlyContinue; if ($null -ne $p) { $p.WaitForExit() }`,
          ],
          { stdio: "ignore", windowsHide: true },
        );
        await new Promise<void>((resolve, reject) => {
          observer.once("error", reject);
          observer.once("close", (code) =>
            code === 0
              ? resolve()
              : reject(new Error("Could not await the Windows fixture launcher.")),
          );
        });
        expect(completed).toBe(false);
        NodeFS.writeFileSync(NodePath.join(cwd, "release"), "go");
        await command;
        expect(NodeFS.readFileSync(NodePath.join(cwd, "finished"), "utf8")).toBe("done");
      } finally {
        controller.abort();
        await ownedCommand?.catch(() => undefined);
        NodeFS.rmSync(cwd, { recursive: true, force: true });
      }
    },
    20_000,
  );
});
