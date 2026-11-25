import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import {
  DEFAULT_TERMINAL_ID,
  ProjectId,
  type TerminalEvent,
  type TerminalOpenInput,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as PtyAdapter from "@t3tools/shared/PtyAdapter";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as Ref from "effect/Ref";
import * as TestClock from "effect/testing/TestClock";
import { expect } from "vite-plus/test";

import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProcessRunner from "../processRunner.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ProjectSetupScriptRunner from "../project/ProjectSetupScriptRunner.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as UpdateDrainAdmission from "../updateDrain/UpdateDrainAdmission.ts";
import * as WorkspaceAcquisitionTestkit from "../workspace/WorkspaceAcquisition.testkit.ts";
import * as TerminalManager from "./Manager.ts";

class FakePtyProcess implements PtyAdapter.PtyProcess {
  readonly writes: string[] = [];
  readonly resizeCalls: Array<{ cols: number; rows: number }> = [];
  readonly killSignals: Array<string | undefined> = [];
  readonly pid: number;
  writeFailure: unknown | undefined;
  resizeFailure: unknown | undefined;
  killFailure: unknown | undefined;
  private readonly dataListeners = new Set<(data: string) => void>();
  private readonly exitListeners = new Set<(event: PtyAdapter.PtyExitEvent) => void>();
  private exitEvent: PtyAdapter.PtyExitEvent | undefined;
  killed = false;
  exitOnSubscribe: PtyAdapter.PtyExitEvent | undefined;
  exitOnKill: string | undefined = "SIGKILL";
  onKill: ((signal: string | undefined) => void) | undefined;

  constructor(pid: number) {
    this.pid = pid;
  }

  write(data: string): void {
    if (this.writeFailure !== undefined) {
      throw this.writeFailure;
    }
    this.writes.push(data);
  }

  resize(cols: number, rows: number): void {
    if (this.resizeFailure !== undefined) {
      throw this.resizeFailure;
    }
    this.resizeCalls.push({ cols, rows });
  }

  kill(signal?: string): void {
    this.killed = true;
    this.killSignals.push(signal);
    if (this.killFailure !== undefined) {
      throw this.killFailure;
    }
    this.onKill?.(signal);
    if (this.exitOnKill !== undefined && signal === this.exitOnKill) {
      this.emitExit({ exitCode: 0, signal: signal === "SIGKILL" ? 9 : null });
    }
  }

  onData(callback: (data: string) => void): () => void {
    this.dataListeners.add(callback);
    return () => {
      this.dataListeners.delete(callback);
    };
  }

  onExit(callback: (event: PtyAdapter.PtyExitEvent) => void): () => void {
    const exited = this.exitEvent ?? this.exitOnSubscribe;
    if (exited !== undefined) {
      callback(exited);
      return () => {};
    }
    this.exitListeners.add(callback);
    return () => {
      this.exitListeners.delete(callback);
    };
  }

  emitData(data: string): void {
    for (const listener of this.dataListeners) {
      listener(data);
    }
  }

  get exitListenerCount(): number {
    return this.exitListeners.size;
  }

  emitExit(event: PtyAdapter.PtyExitEvent): void {
    if (this.exitEvent !== undefined) return;
    this.exitEvent = event;
    for (const listener of this.exitListeners) {
      listener(event);
    }
    this.exitListeners.clear();
  }
}

class FakePtyAdapter {
  readonly spawnInputs: PtyAdapter.PtySpawnInput[] = [];
  readonly processes: FakePtyProcess[] = [];
  readonly spawnFailures: Error[] = [];
  private readonly mode: "sync" | "async";
  private nextPid = 9000;
  exitOnSubscribe: PtyAdapter.PtyExitEvent | undefined;

  constructor(mode: "sync" | "async" = "sync") {
    this.mode = mode;
  }

  spawn(
    input: PtyAdapter.PtySpawnInput,
  ): Effect.Effect<PtyAdapter.PtyProcess, PtyAdapter.PtySpawnError> {
    this.spawnInputs.push(input);
    const failure = this.spawnFailures.shift();
    if (failure) {
      return Effect.fail(
        new PtyAdapter.PtySpawnError({
          adapter: "fake",
          shell: input.shell,
          cause: failure,
        }),
      );
    }
    const process = new FakePtyProcess(this.nextPid++);
    process.exitOnSubscribe = this.exitOnSubscribe;
    this.processes.push(process);
    if (this.mode === "async") {
      return Effect.tryPromise({
        try: async () => process,
        catch: (cause) =>
          new PtyAdapter.PtySpawnError({
            adapter: "fake",
            shell: input.shell,
            cause,
          }),
      });
    }
    return Effect.succeed(process);
  }
}

function openInput(overrides: Partial<TerminalOpenInput> = {}): TerminalOpenInput {
  return {
    threadId: "thread-1",
    terminalId: DEFAULT_TERMINAL_ID,
    cwd: process.cwd(),
    cols: 100,
    rows: 24,
    ...overrides,
  };
}

type CreateManagerOptions = Pick<
  Parameters<typeof TerminalManager.makeWithOptions>[0],
  "shellResolver" | "processTable" | "registerTerminalProcesses" | "subprocessInspector"
> & { readonly ptyAdapter?: FakePtyAdapter };

const createManager = Effect.fn(function* (
  historyLineLimit = 5,
  options: CreateManagerOptions = {},
) {
  const fs = yield* FileSystem.FileSystem;
  const { join } = yield* Path.Path;
  const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3code-terminal-" });
  const logsDir = join(baseDir, "userdata", "logs", "terminals");
  const ptyAdapter = options.ptyAdapter ?? new FakePtyAdapter();
  const manager = yield* TerminalManager.makeWithOptions({
    logsDir,
    historyLineLimit,
    ...options,
    ptyAdapter,
    processKillGraceMs: 1,
    processExitWaitMs: 10,
  }).pipe(Effect.provide(WorkspaceAcquisitionTestkit.layer));
  const eventsRef = yield* Ref.make<ReadonlyArray<TerminalEvent>>([]);
  const unsubscribe = yield* manager.subscribe((event) =>
    Ref.update(eventsRef, (events) => [...events, event]),
  );
  yield* Effect.addFinalizer(() => Effect.sync(unsubscribe));
  return { baseDir, ptyAdapter, manager };
});

const layerWithHostPlatform = (platform: NodeJS.Platform) =>
  Layer.succeed(HostProcess.Platform, platform);

it.layer(
  Layer.mergeAll(
    NodeServices.layer,
    NodeCrypto.layer,
    ProcessRunner.layer.pipe(Layer.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
  ),
  { excludeTestServices: true },
)("TerminalManager LastCode setup readiness", (it) => {
  it.effect(
    "setup proceeds with a retained background writer after the foreground startup prompt returns",
    () =>
      Effect.gen(function* () {
        const foregroundStartup = yield* Ref.make<"separate" | "shared" | "background">("separate");
        const owned = yield* Ref.make<ReadonlyArray<number>>([]);
        const processRunner: ProcessRunner.ProcessRunner["Service"] = {
          run: (input) =>
            Ref.get(foregroundStartup).pipe(
              Effect.map((stage) => {
                const foreground = stage !== "background";
                const group = stage === "separate" ? 9002 : 9000;
                expect(input.args).toEqual(["-eo", "pid=,pgid=,tpgid=,comm="]);
                return {
                  stdout: `9000 9000 ${group} bash\n9001 9001 ${group} background-worker\n${foreground ? `9002 ${group} ${group} installer\n` : ""}`,
                  stderr: "",
                  code: ChildProcessSpawner.ExitCode(0),
                  timedOut: false,
                  stdoutTruncated: false,
                  stderrTruncated: false,
                  stdoutInvalidUtf8: false,
                  stderrInvalidUtf8: false,
                };
              }),
            ),
        };
        const { manager, ptyAdapter, baseDir } = yield* createManager(5, {
          shellResolver: () => "/bin/bash",
          processTable: Ref.get(foregroundStartup).pipe(
            Effect.map((stage) => [
              { pid: 9000, ppid: 1, name: "bash" },
              { pid: 9001, ppid: 9000, name: "background-worker" },
              ...(stage !== "background" ? [{ pid: 9002, ppid: 9000, name: "installer" }] : []),
            ]),
          ),
          registerTerminalProcesses: ({ processIds }) => Ref.set(owned, processIds),
        }).pipe(Effect.provideService(ProcessRunner.ProcessRunner, processRunner));
        const runnerLayer = ProjectSetupScriptRunner.layer.pipe(
          Layer.provide(
            Layer.mergeAll(
              Layer.succeed(TerminalManager.TerminalManager, manager),
              Layer.mock(ProjectService.ProjectService)({}),
              Layer.mock(ProjectionStore.ProjectionStoreV2)({
                getThreadShell: () => Effect.succeed(null),
              }),
              Layer.mock(UpdateDrainAdmission.UpdateDrainAdmission)({
                admit: (_kind, effect) => effect,
              }),
              ServerSettings.layerTest(),
              NodeCrypto.layer,
              WorkspaceAcquisitionTestkit.layer,
            ),
          ),
        );
        yield* Effect.gen(function* () {
          const runner = yield* ProjectSetupScriptRunner.ProjectSetupScriptRunner;
          const result = yield* runner.runForThread({
            threadId: "thread-1",
            worktreePath: baseDir,
            observeCompletion: {},
            project: {
              id: ProjectId.make("setup-background"),
              workspaceRoot: baseDir,
              scripts: [
                {
                  id: "setup",
                  name: "Setup",
                  command: "prepare-worktree",
                  icon: "configure",
                  runOnWorktreeCreate: true,
                },
              ],
            },
          });
          if (result.status !== "started" || !result.completion)
            return yield* Effect.die("missing setup completion");
          const process = ptyAdapter.processes[0]!;
          process.exitOnKill = "SIGTERM";
          const backgroundOutput = Effect.forEach(
            ["background one\r\n", "background two\r\n", "background three\r\n"],
            (data) =>
              Effect.sync(() => process.emitData(data)).pipe(
                Effect.andThen(TestClock.adjust("1 second")),
              ),
            { discard: true },
          );
          yield* manager.refreshMetadata;
          yield* backgroundOutput;
          expect(process.writes).toEqual([]);
          yield* Ref.set(foregroundStartup, "shared");
          yield* backgroundOutput;
          expect(process.writes).toEqual([]);
          yield* Ref.set(foregroundStartup, "background");
          expect((yield* manager.metadata)[0]?.hasRunningSubprocess).toBe(true);
          yield* backgroundOutput;
          expect(process.writes).toHaveLength(1);
          expect(yield* Ref.get(owned)).toContain(9001);
          const sentinel = /__T3_SETUP_DONE___[a-f0-9]+:/u.exec(process.writes[0]!)?.[0];
          expect(sentinel).toBeDefined();
          process.emitData(`\r\n${sentinel}0\r\n$ `);
          expect((yield* result.completion).exitCode).toBe(0);
          expect(process.killed).toBe(false);
          expect((yield* manager.metadata)[0]?.hasRunningSubprocess).toBe(true);
          expect(yield* Ref.get(owned)).toContain(9001);
        }).pipe(Effect.provide(runnerLayer));
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            TestClock.layer(),
            layerWithHostPlatform("linux"),
            Layer.succeed(HostProcess.Environment, { SHELL: "/bin/bash" }),
          ),
        ),
      ),
  );

  it.effect("reads foreground activity while a previous shell is still terminating", () =>
    Effect.gen(function* () {
      const busy = yield* Ref.make(false);
      const ptyAdapter = new FakePtyAdapter();
      const processRunner: ProcessRunner.ProcessRunner["Service"] = {
        run: () =>
          Ref.get(busy).pipe(
            Effect.map((foreground) => {
              const current = ptyAdapter.processes.at(-1)!;
              const group = foreground ? 9100 : current.pid;
              return {
                stdout: `${current.pid} ${current.pid} ${group} zsh\n${foreground ? `9100 9100 9100 tool\n` : ""}`,
                stderr: "",
                code: ChildProcessSpawner.ExitCode(0),
                timedOut: false,
                stdoutTruncated: false,
                stderrTruncated: false,
                stdoutInvalidUtf8: false,
                stderrInvalidUtf8: false,
              };
            }),
          ),
      };
      const { manager, baseDir } = yield* createManager(5, {
        ptyAdapter,
        subprocessInspector: () =>
          Ref.get(busy).pipe(
            Effect.map((hasRunningSubprocess) => ({
              hasRunningSubprocess,
              childCommand: hasRunningSubprocess ? "tool" : null,
              processIds: [],
            })),
          ),
      }).pipe(Effect.provideService(ProcessRunner.ProcessRunner, processRunner));
      const input = openInput();
      expect(yield* manager.hasForegroundSubprocess(input)).toBe(false);
      yield* manager.open(input);
      const previous = ptyAdapter.processes[0]!;
      previous.exitOnKill = undefined;
      const replacement = yield* manager.open({ ...input, cwd: baseDir, worktreePath: baseDir });
      expect(replacement.pid).not.toBe(previous.pid);
      expect((yield* manager.metadata)[0]).toMatchObject({
        pid: previous.pid,
        hasRunningSubprocess: true,
      });
      expect(yield* manager.hasForegroundSubprocess(input)).toBe(false);
      yield* Ref.set(busy, true);
      yield* manager.refreshMetadata;
      expect(yield* manager.hasForegroundSubprocess(input)).toBe(true);
      const removed = yield* Deferred.make<void>();
      const unsubscribe = yield* manager.subscribeMetadata((event) =>
        event.type === "upsert" && event.terminal.pid === replacement.pid
          ? Deferred.succeed(removed, undefined).pipe(Effect.asVoid)
          : Effect.void,
      );
      yield* Effect.addFinalizer(() => Effect.sync(unsubscribe));
      previous.emitExit({ exitCode: 0, signal: 9 });
      yield* Deferred.await(removed);
      expect((yield* manager.metadata)[0]?.pid).toBe(replacement.pid);
    }),
  );
});
