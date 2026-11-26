// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Console from "effect/Console";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as Sink from "effect/Sink";
import * as Stdio from "effect/Stdio";
import * as Stream from "effect/Stream";
import { Command } from "effect/cli";
import { ChildProcessSpawner } from "effect/process";
import * as TestClock from "effect/testing/TestClock";

import { checkChangedCommand } from "./check-changed.ts";

const runTimedOutCheck = (options: {
  readonly changedFile: string;
  readonly hangCommand: string;
  readonly chunks: ReadonlyArray<string>;
  readonly failLogWrite?: boolean;
}) =>
  Effect.gen(function* () {
    const baseFs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const repoRoot = yield* path.fromFileUrl(new URL("..", import.meta.url));
    const cacheFile = path.join(repoRoot, "node_modules/.cache/check-changed.json");
    const logRoot = path.join(repoRoot, "node_modules/.cache/check-changed-logs");
    const tempLogs = NodeFS.realpathSync(
      NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-check-changed-timeout-")),
    );
    const previousExitCode = process.exitCode;
    const logs: Array<string> = [];
    const emitted = yield* Deferred.make<void>();
    let vpScopeClosed = false;

    const redirectLogPath = (target: string) =>
      target === logRoot || target.startsWith(`${logRoot}${NodePath.sep}`)
        ? NodePath.join(tempLogs, NodePath.relative(logRoot, target))
        : target;

    const testFs: FileSystem.FileSystem = {
      ...baseFs,
      copy: () => Effect.void,
      exists: (target) =>
        target === path.join(repoRoot, options.changedFile)
          ? Effect.succeed(options.changedFile === "README.md")
          : baseFs.exists(redirectLogPath(target)),
      makeDirectory: (target, opts) =>
        options.failLogWrite && redirectLogPath(target) !== target
          ? Effect.fail(
              PlatformError.systemError({
                _tag: "PermissionDenied",
                module: "FileSystem",
                method: "makeDirectory",
                pathOrDescriptor: target,
                description: "read-only log directory",
              }),
            )
          : baseFs.makeDirectory(redirectLogPath(target), opts),
      makeTempDirectory: (opts) =>
        baseFs.makeTempDirectory(
          opts?.directory ? { ...opts, directory: redirectLogPath(opts.directory) } : opts,
        ),
      readFileString: (target, encoding) =>
        target === cacheFile
          ? Effect.fail(
              PlatformError.systemError({
                _tag: "NotFound",
                module: "FileSystem",
                method: "readFileString",
                pathOrDescriptor: target,
              }),
            )
          : baseFs.readFileString(redirectLogPath(target), encoding),
      writeFileString: (target, data, opts) =>
        baseFs.writeFileString(redirectLogPath(target), data, opts),
    };

    const spawner = ChildProcessSpawner.make((command) => {
      const { command: bin, args } = command as unknown as {
        readonly command: string;
        readonly args: ReadonlyArray<string>;
      };
      if (bin === "git" || !args.includes(options.hangCommand)) {
        let stdout = "";
        if (bin === "git") {
          if (args.includes("merge-base")) stdout = "0000000000000000000000000000000000000001\n";
          else if (args.includes("rev-list")) stdout = "1\n";
          else if (args.includes("--name-only")) stdout = `${options.changedFile}\n`;
        }
        return Effect.succeed(
          ChildProcessSpawner.makeHandle({
            pid: ChildProcessSpawner.ProcessId(1),
            exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(0)),
            isRunning: Effect.succeed(false),
            kill: () => Effect.void,
            unref: Effect.succeed(Effect.void),
            stdin: Sink.drain,
            stdout: Stream.encodeText(Stream.make(stdout)),
            stderr: Stream.empty,
            all: Stream.empty,
            getInputFd: () => Sink.drain,
            getOutputFd: () => Stream.empty,
          }),
        );
      }

      return Effect.acquireRelease(
        Effect.succeed(
          ChildProcessSpawner.makeHandle({
            pid: ChildProcessSpawner.ProcessId(2),
            exitCode: Effect.never,
            isRunning: Effect.succeed(true),
            kill: () => Effect.void,
            unref: Effect.succeed(Effect.void),
            stdin: Sink.drain,
            stdout: Stream.empty,
            stderr: Stream.empty,
            all: Stream.concat(
              Stream.encodeText(Stream.fromIterable(options.chunks)),
              Stream.fromEffect(Deferred.succeed(emitted, undefined)).pipe(
                Stream.flatMap(() => Stream.never),
              ),
            ),
            getInputFd: () => Sink.drain,
            getOutputFd: () => Stream.empty,
          }),
        ),
        () =>
          Effect.sync(() => {
            vpScopeClosed = true;
          }),
      );
    });

    const capture = (...args: ReadonlyArray<unknown>) => {
      logs.push(args.map(String).join(" "));
    };
    const baseConsole = yield* Console.Console;
    const testConsole: Console.Console = {
      ...baseConsole,
      log: capture,
      error: capture,
      warn: capture,
    };

    try {
      process.exitCode = undefined;
      const run = Command.runWith(checkChangedCommand, { version: "0.0.0" })([
        "HEAD",
        "--concurrency",
        "1",
        "--timeout",
        "10",
      ]).pipe(
        Effect.provideService(FileSystem.FileSystem, testFs),
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        Effect.provideService(Console.Console, testConsole),
        Effect.provide(Stdio.layerTest({})),
      );

      const fiber = yield* Effect.forkChild(run);
      yield* Deferred.await(emitted);
      yield* TestClock.adjust("10 seconds");
      yield* Fiber.join(fiber);

      const stdout = logs.join("\n");
      const summaryIndex = stdout.indexOf("check:changed summary");
      const summary = summaryIndex >= 0 ? stdout.slice(summaryIndex) : "";
      const logPath = /Full log: (.+)/.exec(summary)?.[1];
      const fullLog =
        logPath && NodeFS.existsSync(logPath) ? NodeFS.readFileSync(logPath, "utf8") : null;
      return {
        stdout,
        summary,
        logPath,
        fullLog,
        exitCode: process.exitCode,
        vpScopeClosed,
        tempLogs,
      };
    } finally {
      process.exitCode = previousExitCode;
      NodeFS.rmSync(tempLogs, { recursive: true, force: true });
    }
  }).pipe(Effect.provide(NodeServices.layer));

describe("check:changed timeout output", () => {
  it.effect.each([
    { label: "format", changedFile: "README.md", hangCommand: "fmt" },
    { label: "unused patches", changedFile: "patches/example.patch", hangCommand: "install" },
  ])(
    "preserves long partial output in a full log, console tail, and TIMEOUT summary when $label times out",
    ({ label, changedFile, hangCommand }) =>
      Effect.gen(function* () {
        const early = "early progress line\n".repeat(800);
        const tail = "stuck waiting on fixture step 42\n";
        const result = yield* runTimedOutCheck({
          changedFile,
          hangCommand,
          chunks: [early, tail],
        });

        assert.strictEqual(result.exitCode, 1);
        assert.isTrue(result.vpScopeClosed);
        assert.include(result.stdout, `> vp ${label}  TIMEOUT  killed after 10s`);
        assert.include(result.stdout, "Output tail (earlier output saved in full):");
        assert.include(result.stdout, "stuck waiting on fixture step 42");
        assert.isBelow(result.stdout.length, 16_000);
        assert.include(result.summary, `TIMEOUT  ${label}  killed after 10s`);
        assert.include(result.summary, "TIMEOUT: ran past 10s and was killed");
        assert.isDefined(result.logPath, result.summary);
        assert.strictEqual(result.fullLog, early + tail);
      }),
  );

  it.effect("prints short partial output directly on timeout without writing a log file", () =>
    Effect.gen(function* () {
      const result = yield* runTimedOutCheck({
        changedFile: "README.md",
        hangCommand: "fmt",
        chunks: ["starting format...\n", "hung on README.md\n"],
      });

      assert.strictEqual(result.exitCode, 1);
      assert.isTrue(result.vpScopeClosed);
      assert.include(result.stdout, "> vp format  TIMEOUT  killed after 10s");
      assert.include(result.stdout, "starting format...\nhung on README.md");
      assert.include(result.summary, "TIMEOUT  format  killed after 10s");
      assert.include(result.summary, "TIMEOUT: ran past 10s and was killed");
      assert.isUndefined(result.logPath);
    }),
  );

  it.effect("falls back to printing partial output when saving the full log fails on timeout", () =>
    Effect.gen(function* () {
      const early = "early progress line\n".repeat(800);
      const tail = "hung after unwritable log failure\n";
      const result = yield* runTimedOutCheck({
        changedFile: "README.md",
        hangCommand: "fmt",
        chunks: [early, tail],
        failLogWrite: true,
      });

      assert.strictEqual(result.exitCode, 1);
      assert.include(result.stdout, "hung after unwritable log failure");
      assert.include(result.stdout, "Could not save full log:");
      assert.include(result.summary, "TIMEOUT  format  killed after 10s");
      assert.isUndefined(result.logPath);
    }),
  );
});
