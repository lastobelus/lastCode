import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  DEFAULT_TERMINAL_ID,
  type TerminalAttachStreamEvent,
  type TerminalEvent,
  type TerminalMetadataStreamEvent,
  type TerminalOpenInput,
  type TerminalRestartInput,
  ProviderDriverKind,
  ProviderInstanceId,
  ServerSettingsError,
  TerminalProviderInstanceNotFoundError,
} from "@t3tools/contracts";
import { HostProcessPlatform, HostProcessArchitecture } from "@t3tools/shared/hostProcess";
import * as Data from "effect/Data";
import * as Clock from "effect/Clock";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Base64Url from "effect/encoding/Base64Url";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PlatformError from "effect/PlatformError";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { ChildProcessSpawner } from "effect/process";
import { expect } from "vite-plus/test";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ProcessRunner from "../processRunner.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as TerminalManager from "./Manager.ts";
import * as PtyAdapter from "@t3tools/shared/PtyAdapter";

const encodeUnknownJson = Schema.encodeUnknownSync(Schema.fromJsonString(Schema.Unknown));

class WaitForConditionError extends Data.TaggedError("WaitForConditionError")<{
  readonly message: string;
}> {}

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

  get exitListenerCount(): number {
    return this.exitListeners.size;
  }

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

const waitFor = <E, R>(
  predicate: Effect.Effect<boolean, E, R>,
  timeout: Duration.Input = 800,
): Effect.Effect<void, WaitForConditionError | E, R> =>
  predicate.pipe(
    Effect.filterOrFail(
      (done) => done,
      () => new WaitForConditionError({ message: "Condition not met" }),
    ),
    Effect.retry(Schedule.spaced("15 millis")),
    Effect.timeoutOption(timeout),
    Effect.flatMap((result) =>
      Option.match(result, {
        onNone: () =>
          Effect.fail(new WaitForConditionError({ message: "Timed out waiting for condition" })),
        onSome: () => Effect.void,
      }),
    ),
  );

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

function restartInput(overrides: Partial<TerminalRestartInput> = {}): TerminalRestartInput {
  return {
    threadId: "thread-1",
    terminalId: DEFAULT_TERMINAL_ID,
    cwd: process.cwd(),
    cols: 100,
    rows: 24,
    ...overrides,
  };
}

const historyLogPath = (logsDir: string, threadId = "thread-1") =>
  Effect.service(Path.Path).pipe(
    Effect.map(({ join }) => join(logsDir, `terminal_${Base64Url.encode(threadId)}.log`)),
  );

const multiTerminalHistoryLogPath = (
  logsDir: string,
  threadId = "thread-1",
  terminalId = DEFAULT_TERMINAL_ID,
) =>
  Effect.service(Path.Path).pipe(
    Effect.map(({ join }) => {
      const threadPart = `terminal_${Base64Url.encode(threadId)}`;
      return join(
        logsDir,
        terminalId === DEFAULT_TERMINAL_ID
          ? `${threadPart}.log`
          : `${threadPart}_${Base64Url.encode(terminalId)}.log`,
      );
    }),
  );

interface CreateManagerOptions {
  shellResolver?: () => string;
  env?: NodeJS.ProcessEnv;
  localCiSettingsPath?: string;
  subprocessInspector?: (
    terminalPid: number,
    spawnedShellName: string | null,
  ) => Effect.Effect<{
    readonly hasRunningSubprocess: boolean;
    readonly childCommand: string | null;
    readonly processIds: ReadonlyArray<number>;
  }>;
  processTable?: Effect.Effect<
    ReadonlyArray<{ readonly pid: number; readonly ppid: number; readonly name: string }>,
    never
  >;
  subprocessPollIntervalMs?: number;
  processKillGraceMs?: number;
  processExitWaitMs?: number;
  maxRetainedInactiveSessions?: number;
  historyByteLimit?: number;
  ptyAdapter?: FakePtyAdapter;
  resolveProviderInstanceEnvironment?: Parameters<
    typeof TerminalManager.makeWithOptions
  >[0]["resolveProviderInstanceEnvironment"];
  managedBinaryCacheDir?: string;
  managedBinaryToolsDir?: string;
  registerTerminalProcesses?: Parameters<
    typeof TerminalManager.makeWithOptions
  >[0]["registerTerminalProcesses"];
  unregisterTerminal?: Parameters<typeof TerminalManager.makeWithOptions>[0]["unregisterTerminal"];
}

interface ManagerFixture {
  readonly baseDir: string;
  readonly logsDir: string;
  readonly ptyAdapter: FakePtyAdapter;
  readonly manager: TerminalManager.TerminalManager["Service"];
  readonly getEvents: Effect.Effect<ReadonlyArray<TerminalEvent>>;
}

const createManager = (
  historyLineLimit = 5,
  options: CreateManagerOptions = {},
): Effect.Effect<
  ManagerFixture,
  PlatformError.PlatformError,
  FileSystem.FileSystem | Path.Path | Scope.Scope | ProcessRunner.ProcessRunner
> =>
  Effect.flatMap(Effect.service(FileSystem.FileSystem), (fs) =>
    Effect.gen(function* () {
      const { join } = yield* Path.Path;
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3code-terminal-" });
      const logsDir = join(baseDir, "userdata", "logs", "terminals");
      const ptyAdapter = options.ptyAdapter ?? new FakePtyAdapter();

      const manager = yield* TerminalManager.makeWithOptions({
        logsDir,
        historyLineLimit,
        ptyAdapter,
        ...(options.historyByteLimit !== undefined
          ? { historyByteLimit: options.historyByteLimit }
          : {}),
        ...(options.shellResolver !== undefined ? { shellResolver: options.shellResolver } : {}),
        ...(options.env !== undefined ? { env: options.env } : {}),
        ...(options.localCiSettingsPath !== undefined
          ? { localCiSettingsPath: options.localCiSettingsPath }
          : {}),
        ...(options.subprocessInspector !== undefined
          ? { subprocessInspector: options.subprocessInspector }
          : {}),
        ...(options.processTable !== undefined ? { processTable: options.processTable } : {}),
        ...(options.subprocessPollIntervalMs !== undefined
          ? { subprocessPollIntervalMs: options.subprocessPollIntervalMs }
          : {}),
        processKillGraceMs: options.processKillGraceMs ?? 1,
        processExitWaitMs: options.processExitWaitMs ?? 10,
        ...(options.maxRetainedInactiveSessions !== undefined
          ? { maxRetainedInactiveSessions: options.maxRetainedInactiveSessions }
          : {}),
        ...(options.resolveProviderInstanceEnvironment !== undefined
          ? { resolveProviderInstanceEnvironment: options.resolveProviderInstanceEnvironment }
          : {}),
        ...(options.managedBinaryCacheDir === undefined
          ? {}
          : {
              managedBinaryCacheDir: options.managedBinaryCacheDir,
              managedBinaryToolsDir: options.managedBinaryToolsDir,
            }),
        ...(options.unregisterTerminal === undefined
          ? {}
          : { unregisterTerminal: options.unregisterTerminal }),
        ...(options.registerTerminalProcesses === undefined
          ? {}
          : { registerTerminalProcesses: options.registerTerminalProcesses }),
      });
      const eventsRef = yield* Ref.make<ReadonlyArray<TerminalEvent>>([]);
      const unsubscribe = yield* manager.subscribe((event) =>
        Ref.update(eventsRef, (events) => [...events, event]),
      );
      yield* Effect.addFinalizer(() => Effect.sync(unsubscribe));

      return {
        baseDir,
        logsDir,
        join,
        ptyAdapter,
        manager,
        getEvents: Ref.get(eventsRef),
      };
    }),
  );

const layerWithHostPlatform = (platform: NodeJS.Platform) =>
  Layer.succeed(HostProcessPlatform, platform);

// Apply the existing line policy, then find the longest code-point-aligned byte tail.
function retainedHistory(text: string, maxLines: number, maxBytes = Infinity): string {
  const terminated = text.endsWith("\n");
  const lines = text.split("\n");
  if (terminated) lines.pop();
  const retained = lines.slice(Math.max(0, lines.length - maxLines)).join("\n");
  const capped = terminated ? `${retained}\n` : retained;
  if (Buffer.byteLength(capped) <= maxBytes) return capped;
  const points = Array.from(capped);
  let start = points.length;
  let bytes = 0;
  while (start > 0) {
    const next = Buffer.byteLength(points[start - 1]!);
    if (bytes + next > maxBytes) break;
    bytes += next;
    start -= 1;
  }
  return points.slice(start).join("");
}

it("preserves line and byte limits across arbitrary chunks, Unicode, ANSI sequences, and clear", () => {
  let randomSeed = 0x20260904;
  const fragments = [
    "",
    "a",
    "\n",
    "\n\n",
    "\r",
    "\r\n",
    "café",
    "名",
    "🚀",
    "\u001b[31m",
    "\u001b[0m",
    "\u001b]8;;url\u0007",
    "\ud83d",
    "\ude80",
  ];
  const nextFragment = () => {
    randomSeed = (Math.imul(randomSeed, 1_664_525) + 1_013_904_223) >>> 0;
    return fragments[randomSeed % fragments.length]!;
  };

  for (const maxBytes of [0, 3, 8, 64, Infinity]) {
    for (const maxLines of [0, 1, 3, 5, 5_000]) {
      let expected = retainedHistory("before\ninitial\n", maxLines, maxBytes);
      const history = new TerminalManager.BoundedTerminalHistory(
        maxLines,
        "before\ninitial\n",
        maxBytes,
      );
      expect(history.value()).toBe(expected);

      for (let step = 0; step < 300; step += 1) {
        if (step % 73 === 0) {
          history.clear();
          expected = "";
          expect(history.value()).toBe(expected);
        }
        const chunk = nextFragment() + nextFragment();
        history.append(chunk);
        expected = retainedHistory(expected + chunk, maxLines, maxBytes);
        expect(history.value()).toBe(expected);
      }
    }
  }
});

it("bounds long partial lines and joins surrogate pairs across chunk boundaries", () => {
  const maxBytes = 65_539;
  let expected = "";
  const history = new TerminalManager.BoundedTerminalHistory(5_000, "", maxBytes);
  const writes = [
    "a".repeat(16_383) + "😀" + "b".repeat(70_000),
    "\r" + "c".repeat(70_000) + "\ud83d",
    "\ude80" + "d".repeat(100),
    "\uFEFF" + "名".repeat(30_000),
  ];
  for (const text of writes) {
    history.append(text);
    expected = retainedHistory(expected + text, 5_000, maxBytes);
    expect(history.value()).toBe(expected);
    expect(Buffer.byteLength(history.value())).toBeLessThanOrEqual(maxBytes);
  }
});

it("preserves retained lines as older storage is compacted", () => {
  for (const maxLines of [3, 5_000]) {
    let expected = "";
    const history = new TerminalManager.BoundedTerminalHistory(maxLines, expected);
    for (let batch = 0; batch < 40; batch += 1) {
      const chunk = Array.from({ length: 300 }, (_, line) => `${batch}:${line}\n`).join("");
      history.append(chunk);
      expected = retainedHistory(expected + chunk, maxLines);
      expect(history.value()).toBe(expected);
    }
  }
});

it.layer(
  Layer.merge(NodeServices.layer, ProcessRunner.layer.pipe(Layer.provide(NodeServices.layer))),
  { excludeTestServices: true },
)("TerminalManager", (it) => {
  it.effect("spawns lazily and reuses running terminal per thread", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter } = yield* createManager();
      const [first, second] = yield* Effect.all(
        [manager.open(openInput()), manager.open(openInput())],
        { concurrency: "unbounded" },
      );
      const third = yield* manager.open(openInput());

      assert.equal(first.threadId, "thread-1");
      assert.equal(first.terminalId, DEFAULT_TERMINAL_ID);
      assert.equal(second.threadId, "thread-1");
      assert.equal(third.threadId, "thread-1");
      expect(ptyAdapter.spawnInputs).toHaveLength(1);
    }),
  );

  it.effect("attaches to running sessions without restarting them", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter } = yield* createManager();

      yield* manager.open(openInput());
      const attachEvents = yield* Ref.make<ReadonlyArray<TerminalAttachStreamEvent>>([]);
      const unsubscribe = yield* manager.attachStream(
        {
          threadId: "thread-1",
          terminalId: DEFAULT_TERMINAL_ID,
          cols: 100,
          rows: 40,
        },
        (event) => Ref.update(attachEvents, (events) => [...events, event]),
        false,
      );
      yield* Effect.addFinalizer(() => Effect.sync(unsubscribe));

      const snapshot = (yield* Ref.get(attachEvents)).find((event) => event.type === "snapshot");
      expect(snapshot).toBeDefined();
      if (!snapshot || snapshot.type !== "snapshot") return;
      assert.equal(snapshot.snapshot.threadId, "thread-1");
      assert.equal(snapshot.snapshot.terminalId, DEFAULT_TERMINAL_ID);
      expect(ptyAdapter.spawnInputs).toHaveLength(1);
    }),
  );

  it.effect("refuses to create a missing terminal for read-only attach", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter } = yield* createManager();
      const result = yield* manager
        .attachStream(openInput(), () => Effect.void, false)
        .pipe(Effect.result);

      assert.equal(result._tag, "Failure");
      assert.equal(
        result._tag === "Failure" ? result.failure._tag : null,
        "TerminalSessionLookupError",
      );
      expect(ptyAdapter.spawnInputs).toHaveLength(0);
    }),
  );

  it.effect.each(["awaiting-exit", "metadata-removed"] as const)(
    "rejects attachment queued during shutdown when %s and permits a fresh attachment afterward",
    (phase) =>
      Effect.gen(function* () {
        const forceKillSent = yield* Deferred.make<void>();
        const removalStarted = yield* Deferred.make<void>();
        const closeStarted = yield* Deferred.make<void>();
        const releaseClose = yield* Deferred.make<void>();
        const { manager, ptyAdapter } = yield* createManager(5, {
          processKillGraceMs: 0,
          processExitWaitMs: 100,
        });
        yield* manager.open(openInput());
        const process = ptyAdapter.processes[0]!;
        process.exitOnKill = undefined;
        process.onKill = (signal) => {
          if (signal === "SIGKILL") Deferred.doneUnsafe(forceKillSent, Effect.void);
        };
        const unsubscribeMetadata = yield* manager.subscribeMetadata((event) =>
          event.type === "remove"
            ? Deferred.succeed(removalStarted, undefined).pipe(Effect.asVoid)
            : Effect.void,
        );
        yield* Effect.addFinalizer(() => Effect.sync(unsubscribeMetadata));
        const unsubscribeEvents = yield* manager.subscribe((event) =>
          phase === "metadata-removed" && event.type === "closed"
            ? Deferred.succeed(closeStarted, undefined).pipe(
                Effect.andThen(Deferred.await(releaseClose)),
              )
            : Effect.void,
        );
        yield* Effect.addFinalizer(() => Effect.sync(unsubscribeEvents));
        const stopping = yield* manager.shutdownThread("thread-1").pipe(Effect.forkScoped);
        yield* Deferred.await(forceKillSent);
        if (phase === "metadata-removed") {
          // Close owns the thread lock while delivering this event, so a slow
          // event consumer pins Stop independently of the exit observers.
          yield* Deferred.await(closeStarted);
          process.emitExit({ exitCode: 0, signal: 9 });
          yield* Deferred.await(removalStarted);
          expect(yield* manager.metadata).toEqual([]);
        }
        const rejectedEvents: TerminalAttachStreamEvent[] = [];
        const attaching = yield* manager
          .attachStream(openInput(), (event) =>
            Effect.sync(() => {
              rejectedEvents.push(event);
            }),
          )
          .pipe(Effect.result, Effect.forkScoped({ startImmediately: true }));
        expect(attaching.pollUnsafe()).toBeUndefined();
        expect(stopping.pollUnsafe()).toBeUndefined();
        expect(ptyAdapter.spawnInputs).toHaveLength(1);

        if (phase === "awaiting-exit") process.emitExit({ exitCode: 0, signal: 9 });
        else yield* Deferred.succeed(releaseClose, undefined);
        yield* Fiber.join(stopping);
        const result = yield* Fiber.join(attaching);
        expect(result._tag === "Failure" ? result.failure._tag : null).toBe(
          "TerminalNotRunningError",
        );
        expect(ptyAdapter.spawnInputs).toHaveLength(1);
        expect(rejectedEvents).toEqual([]);
        expect(yield* manager.metadata).toEqual([]);

        const unsubscribe = yield* manager.attachStream(openInput(), () => Effect.void);
        yield* Effect.addFinalizer(() => Effect.sync(unsubscribe));
        expect(ptyAdapter.spawnInputs).toHaveLength(2);
        expect(rejectedEvents).toEqual([]);
        ptyAdapter.processes[1]!.exitOnKill = "SIGTERM";
        yield* manager.shutdownThread("thread-1");
      }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("does not auto-open a session observed alive before concurrent idle close", () =>
    Effect.gen(function* () {
      const checking = yield* Deferred.make<void>();
      const finishCheck = yield* Deferred.make<void>();
      const { manager, ptyAdapter } = yield* createManager(5, {
        processKillGraceMs: 0,
        subprocessInspector: () =>
          Deferred.succeed(checking, undefined).pipe(
            Effect.andThen(Deferred.await(finishCheck)),
            Effect.as({ hasRunningSubprocess: false, childCommand: null, processIds: [] }),
          ),
      });
      yield* manager.open(openInput());
      const closing = yield* manager.closeIdle({ threadId: "thread-1" }).pipe(Effect.forkScoped);
      yield* Deferred.await(checking);
      const attaching = yield* manager
        .attachStream(openInput(), () => Effect.void)
        .pipe(Effect.result, Effect.forkScoped({ startImmediately: true }));
      expect(attaching.pollUnsafe()).toBeUndefined();
      expect(ptyAdapter.processes[0]?.killSignals).toEqual([]);

      yield* Deferred.succeed(finishCheck, undefined);
      yield* Fiber.join(closing);
      yield* manager.waitForThreadShutdown("thread-1");
      const result = yield* Fiber.join(attaching);
      expect(result._tag === "Failure" ? result.failure._tag : null).toBe(
        "TerminalNotRunningError",
      );
      expect(ptyAdapter.spawnInputs).toHaveLength(1);
      expect(yield* manager.metadata).toEqual([]);

      const unsubscribe = yield* manager.attachStream(openInput(), () => Effect.void);
      yield* Effect.addFinalizer(() => Effect.sync(unsubscribe));
      expect(ptyAdapter.spawnInputs).toHaveLength(2);
      yield* manager.shutdownThread("thread-1");
    }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect(
    "keeps concurrent shutdown protected after interruption and clears it after completion",
    () =>
      Effect.gen(function* () {
        const firstCleanup = yield* Deferred.make<void>();
        const secondCleanup = yield* Deferred.make<void>();
        const releaseFirst = yield* Deferred.make<void>();
        const releaseSecond = yield* Deferred.make<void>();
        const gates = [
          { started: firstCleanup, release: releaseFirst },
          { started: secondCleanup, release: releaseSecond },
        ];
        const { manager, ptyAdapter } = yield* createManager(5, {
          processKillGraceMs: 0,
          unregisterTerminal: ({ threadId }) =>
            Effect.suspend(() => {
              const gate = threadId === "thread-1" ? gates.shift() : undefined;
              return gate === undefined
                ? Effect.void
                : Deferred.succeed(gate.started, undefined).pipe(
                    Effect.andThen(Deferred.await(gate.release)),
                  );
            }),
        });
        yield* manager.open(openInput());
        const first = yield* manager.shutdownThread("thread-1").pipe(Effect.forkScoped);
        yield* Deferred.await(firstCleanup);
        const second = yield* manager
          .shutdownThread("thread-1")
          .pipe(Effect.forkScoped({ startImmediately: true }));
        yield* Fiber.interrupt(first);
        yield* Deferred.await(secondCleanup);
        const attaching = yield* manager
          .attachStream(openInput({ terminalId: "new-terminal" }), () => Effect.void)
          .pipe(Effect.result, Effect.forkScoped({ startImmediately: true }));
        expect(attaching.pollUnsafe()).toBeUndefined();
        const unsubscribeOther = yield* manager.attachStream(
          openInput({ threadId: "thread-2" }),
          () => Effect.void,
        );
        yield* Effect.addFinalizer(() => Effect.sync(unsubscribeOther));
        expect(ptyAdapter.spawnInputs).toHaveLength(2);

        yield* Deferred.succeed(releaseSecond, undefined);
        yield* Fiber.join(second);
        const result = yield* Fiber.join(attaching);
        expect(result._tag === "Failure" ? result.failure._tag : null).toBe(
          "TerminalNotRunningError",
        );
        expect(ptyAdapter.spawnInputs).toHaveLength(2);
        const unsubscribe = yield* manager.attachStream(
          openInput({ terminalId: "new-terminal" }),
          () => Effect.void,
        );
        yield* Effect.addFinalizer(() => Effect.sync(unsubscribe));
        expect(ptyAdapter.spawnInputs).toHaveLength(3);
        yield* manager.shutdownThread("thread-1");
        yield* manager.shutdownThread("thread-2");
      }),
  );

  it.effect("does not recreate a detached terminal from metadata during normal kill grace", () =>
    Effect.gen(function* () {
      const termSent = yield* Deferred.make<void>();
      const removed = yield* Deferred.make<void>();
      let environmentResolutions = 0;
      const { manager, ptyAdapter, logsDir } = yield* createManager(5, {
        processKillGraceMs: 10,
        resolveProviderInstanceEnvironment: () =>
          Effect.sync(() => {
            environmentResolutions += 1;
            return {};
          }),
      });
      yield* manager.open(openInput());
      const process = ptyAdapter.processes[0]!;
      process.onKill = (signal) => {
        if (signal === "SIGTERM") Deferred.doneUnsafe(termSent, Effect.void);
      };
      const unsubscribeMetadata = yield* manager.subscribeMetadata((event) =>
        event.type === "remove"
          ? Deferred.succeed(removed, undefined).pipe(Effect.asVoid)
          : Effect.void,
      );
      yield* Effect.addFinalizer(() => Effect.sync(unsubscribeMetadata));

      yield* manager.close({ threadId: "thread-1", deleteHistory: true });
      yield* Deferred.await(termSent);
      const retainedMetadata = yield* manager.metadata;
      const historyPath = yield* historyLogPath(logsDir);
      expect(yield* pathExists(historyPath)).toBe(false);
      const rejectedEvents: TerminalAttachStreamEvent[] = [];
      const error = yield* manager
        .attachStream(
          {
            ...openInput({ cwd: "/missing-terminal-directory" }),
            providerInstanceId: ProviderInstanceId.make("test-provider"),
            restartIfNotRunning: true,
          },
          (event) =>
            Effect.sync(() => {
              rejectedEvents.push(event);
            }),
        )
        .pipe(Effect.flip);

      expect(error._tag).toBe("TerminalNotRunningError");
      expect(environmentResolutions).toBe(0);
      expect(ptyAdapter.spawnInputs).toHaveLength(1);
      expect(process.killSignals).toEqual(["SIGTERM"]);
      expect(yield* manager.metadata).toEqual(retainedMetadata);
      expect(yield* pathExists(historyPath)).toBe(false);

      yield* TestClock.adjust("10 millis");
      yield* Deferred.await(removed);
      yield* manager.waitForThreadShutdown("thread-1");
      const snapshots: TerminalAttachStreamEvent[] = [];
      const unsubscribe = yield* manager.attachStream(openInput(), (event) =>
        Effect.sync(() => {
          snapshots.push(event);
        }),
      );
      yield* Effect.addFinalizer(() => Effect.sync(unsubscribe));

      expect(ptyAdapter.spawnInputs).toHaveLength(2);
      expect(snapshots).toEqual([
        expect.objectContaining({
          type: "snapshot",
          snapshot: expect.objectContaining({
            status: "running",
            pid: ptyAdapter.processes[1]?.pid,
          }),
        }),
      ]);
      expect(rejectedEvents).toEqual([]);
      ptyAdapter.processes[1]!.exitOnKill = "SIGTERM";
      yield* manager.shutdownThread("thread-1");
    }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect(
    "keeps failed retained terminals visible without respawning on repeated attachment",
    () =>
      Effect.gen(function* () {
        const removed = yield* Deferred.make<void>();
        const { manager, ptyAdapter } = yield* createManager(5, { processKillGraceMs: 0 });
        yield* manager.open(openInput());
        const process = ptyAdapter.processes[0]!;
        process.killFailure = new Error("signal failure");
        const unsubscribeMetadata = yield* manager.subscribeMetadata((event) =>
          event.type === "remove" && event.threadId === "thread-1"
            ? Deferred.succeed(removed, undefined).pipe(Effect.asVoid)
            : Effect.void,
        );
        yield* Effect.addFinalizer(() => Effect.sync(unsubscribeMetadata));
        expect((yield* manager.shutdownThread("thread-1").pipe(Effect.result))._tag).toBe(
          "Failure",
        );
        const retainedMetadata = yield* manager.metadata;
        const rejectedEvents: TerminalAttachStreamEvent[] = [];
        for (let attempt = 0; attempt < 3; attempt += 1) {
          const error = yield* manager
            .attachStream(openInput(), (event) =>
              Effect.sync(() => {
                rejectedEvents.push(event);
              }),
            )
            .pipe(Effect.flip);
          expect(error._tag).toBe("TerminalNotRunningError");
          expect(yield* manager.metadata).toEqual(retainedMetadata);
        }
        expect(ptyAdapter.spawnInputs).toHaveLength(1);
        expect(process.killSignals).toEqual(["SIGTERM"]);
        expect(retainedMetadata).toEqual([
          expect.objectContaining({
            threadId: "thread-1",
            pid: process.pid,
            status: "running",
            hasRunningSubprocess: true,
          }),
        ]);

        const unsubscribeOtherThread = yield* manager.attachStream(
          openInput({ threadId: "thread-2" }),
          () => Effect.void,
        );
        const unsubscribeOtherId = yield* manager.attachStream(
          openInput({ terminalId: "other-terminal" }),
          () => Effect.void,
        );
        yield* Effect.addFinalizer(() => Effect.sync(unsubscribeOtherThread));
        yield* Effect.addFinalizer(() => Effect.sync(unsubscribeOtherId));
        expect(ptyAdapter.spawnInputs).toHaveLength(3);
        expect(process.killSignals).toEqual(["SIGTERM"]);

        process.emitExit({ exitCode: 0, signal: null });
        yield* Deferred.await(removed);
        yield* manager.waitForThreadShutdown("thread-1");
        const unsubscribe = yield* manager.attachStream(openInput(), () => Effect.void);
        yield* Effect.addFinalizer(() => Effect.sync(unsubscribe));

        expect(ptyAdapter.spawnInputs).toHaveLength(4);
        expect(process.killSignals).toEqual(["SIGTERM"]);
        expect(rejectedEvents).toEqual([]);
        yield* manager.shutdownThread("thread-1");
        yield* manager.shutdownThread("thread-2");
      }),
  );

  it.effect(
    "blocks processless session attachment but attaches to an explicit live replacement",
    () =>
      Effect.gen(function* () {
        const replacementVisible = yield* Deferred.make<void>();
        const { manager, ptyAdapter } = yield* createManager(5, { processKillGraceMs: 0 });
        yield* manager.open(openInput());
        const original = ptyAdapter.processes[0]!;
        original.killFailure = new Error("signal failure");
        ptyAdapter.spawnFailures.push(new Error("replacement spawn failed"));
        const failedRestart = yield* manager.restart(restartInput());
        expect(failedRestart.status).toBe("error");
        expect((yield* manager.waitForThreadShutdown("thread-1").pipe(Effect.result))._tag).toBe(
          "Failure",
        );
        const retainedMetadata = yield* manager.metadata;
        const rejectedEvents: TerminalAttachStreamEvent[] = [];
        const error = yield* manager
          .attachStream({ ...openInput(), restartIfNotRunning: true }, (event) =>
            Effect.sync(() => {
              rejectedEvents.push(event);
            }),
          )
          .pipe(Effect.flip);

        expect(error._tag).toBe("TerminalNotRunningError");
        expect(ptyAdapter.spawnInputs).toHaveLength(2);
        expect(ptyAdapter.processes).toHaveLength(1);
        expect(yield* manager.metadata).toEqual(retainedMetadata);
        expect(original.killSignals).toEqual(["SIGTERM"]);

        const replacement = yield* manager.restart(restartInput());
        const attachedEvents: TerminalAttachStreamEvent[] = [];
        const unsubscribe = yield* manager.attachStream(
          { ...openInput(), restartIfNotRunning: true },
          (event) =>
            Effect.sync(() => {
              attachedEvents.push(event);
            }),
        );
        yield* Effect.addFinalizer(() => Effect.sync(unsubscribe));
        expect(ptyAdapter.spawnInputs).toHaveLength(3);
        expect(attachedEvents).toEqual([
          expect.objectContaining({ type: "snapshot", snapshot: replacement }),
        ]);
        expect(original.killSignals).toEqual(["SIGTERM"]);
        const unsubscribeMetadata = yield* manager.subscribeMetadata((event) =>
          event.type === "upsert" && event.terminal.pid === replacement.pid
            ? Deferred.succeed(replacementVisible, undefined).pipe(Effect.asVoid)
            : Effect.void,
        );
        yield* Effect.addFinalizer(() => Effect.sync(unsubscribeMetadata));

        original.emitExit({ exitCode: 0, signal: null });
        yield* Deferred.await(replacementVisible);
        expect(yield* manager.metadata).toEqual([
          expect.objectContaining({ status: "running", pid: replacement.pid }),
        ]);
        expect(rejectedEvents).toEqual([]);
        yield* manager.shutdownThread("thread-1");
      }),
  );

  it.effect("keeps attach streams live when a terminal id is closed and reopened", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter } = yield* createManager();
      const attachEvents = yield* Ref.make<ReadonlyArray<TerminalAttachStreamEvent>>([]);
      const unsubscribe = yield* manager.attachStream(openInput(), (event) =>
        Ref.update(attachEvents, (events) => [...events, event]),
      );
      yield* Effect.addFinalizer(() => Effect.sync(unsubscribe));

      yield* manager.close({
        threadId: "thread-1",
        terminalId: DEFAULT_TERMINAL_ID,
        deleteHistory: true,
      });
      yield* manager.open(openInput());

      const events = yield* Ref.get(attachEvents);
      expect(events.map((event) => event.type)).toEqual(["snapshot", "closed", "snapshot"]);
      expect(
        events.filter((event) => event.type === "snapshot").map((event) => event.snapshot.status),
      ).toEqual(["running", "running"]);
      expect(ptyAdapter.spawnInputs).toHaveLength(2);
    }),
  );

  it.effect("attaches to exited sessions without restarting them", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter, getEvents } = yield* createManager();

      yield* manager.open(openInput());
      const process = ptyAdapter.processes[0];
      expect(process).toBeDefined();
      if (!process) return;

      process.emitExit({ exitCode: 0, signal: 0 });

      yield* waitFor(
        Effect.map(getEvents, (events) => events.some((event) => event.type === "exited")),
        "1200 millis",
      );

      const attachEvents = yield* Ref.make<ReadonlyArray<TerminalAttachStreamEvent>>([]);
      const unsubscribe = yield* manager.attachStream(
        openInput({
          env: {
            T3CODE_WORKTREE_PATH: "/tmp/should-not-restart",
          },
          worktreePath: "/tmp/should-not-restart",
        }),
        (event) => Ref.update(attachEvents, (events) => [...events, event]),
      );
      yield* Effect.addFinalizer(() => Effect.sync(unsubscribe));

      const snapshot = (yield* Ref.get(attachEvents)).find((event) => event.type === "snapshot");
      expect(snapshot).toBeDefined();
      if (!snapshot || snapshot.type !== "snapshot") return;
      assert.equal(snapshot.snapshot.status, "exited");
      assert.equal(snapshot.snapshot.worktreePath, null);
      expect(ptyAdapter.spawnInputs).toHaveLength(1);
    }),
  );

  it.effect("restarts inactive sessions from attach only when requested", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter, getEvents } = yield* createManager();

      yield* manager.open(openInput());
      const process = ptyAdapter.processes[0];
      expect(process).toBeDefined();
      if (!process) return;

      process.emitExit({ exitCode: 0, signal: 0 });

      yield* waitFor(
        Effect.map(getEvents, (events) => events.some((event) => event.type === "exited")),
        "1200 millis",
      );

      const attachEvents = yield* Ref.make<ReadonlyArray<TerminalAttachStreamEvent>>([]);
      const unsubscribe = yield* manager.attachStream(
        {
          ...openInput({
            env: {
              T3CODE_WORKTREE_PATH: "/tmp/restart-requested",
            },
            worktreePath: "/tmp/restart-requested",
          }),
          restartIfNotRunning: true,
        },
        (event) => Ref.update(attachEvents, (events) => [...events, event]),
      );
      yield* Effect.addFinalizer(() => Effect.sync(unsubscribe));

      const snapshot = (yield* Ref.get(attachEvents)).find((event) => event.type === "snapshot");
      expect(snapshot).toBeDefined();
      if (!snapshot || snapshot.type !== "snapshot") return;
      assert.equal(snapshot.snapshot.status, "running");
      assert.equal(snapshot.snapshot.worktreePath, "/tmp/restart-requested");
      expect(ptyAdapter.spawnInputs).toHaveLength(2);
    }),
  );

  const makeDirectory = (filePath: string) =>
    Effect.flatMap(Effect.service(FileSystem.FileSystem), (fs) =>
      fs.makeDirectory(filePath, { recursive: true }),
    );

  const chmod = (filePath: string, mode: number) =>
    Effect.flatMap(Effect.service(FileSystem.FileSystem), (fs) => fs.chmod(filePath, mode));

  const pathExists = (filePath: string) =>
    Effect.flatMap(Effect.service(FileSystem.FileSystem), (fs) => fs.exists(filePath));

  const readFileString = (filePath: string) =>
    Effect.flatMap(Effect.service(FileSystem.FileSystem), (fs) => fs.readFileString(filePath));

  const writeFileString = (filePath: string, contents: string) =>
    Effect.flatMap(Effect.service(FileSystem.FileSystem), (fs) =>
      fs.writeFileString(filePath, contents),
    );

  it.effect("reports a missing cwd without an artificial cause", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;

      const { manager, baseDir } = yield* createManager();
      const cwd = path.join(baseDir, "missing-cwd");
      const error = yield* Effect.flip(manager.open(openInput({ cwd })));

      expect(error).toMatchObject({
        _tag: "TerminalCwdNotFoundError",
        cwd,
      });
      expect("cause" in error).toBe(false);
    }),
  );

  it.effect("reports a cwd that is not a directory", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;

      const { manager, baseDir } = yield* createManager();
      const cwd = path.join(baseDir, "cwd-file");
      yield* writeFileString(cwd, "not a directory");
      const error = yield* Effect.flip(manager.open(openInput({ cwd })));

      expect(error).toMatchObject({
        _tag: "TerminalCwdNotDirectoryError",
        cwd,
      });
      expect("cause" in error).toBe(false);
    }),
  );

  it.effect("preserves non-notFound cwd stat failures", () =>
    Effect.gen(function* () {
      if ((yield* HostProcessPlatform) === "win32") return;

      const path = yield* Path.Path;

      const { manager, baseDir } = yield* createManager();
      const blockedRoot = path.join(baseDir, "blocked-root");
      const blockedCwd = path.join(blockedRoot, "cwd");
      yield* makeDirectory(blockedCwd);
      yield* chmod(blockedRoot, 0o000);

      const error = yield* Effect.flip(manager.open(openInput({ cwd: blockedCwd }))).pipe(
        Effect.ensuring(chmod(blockedRoot, 0o755).pipe(Effect.ignore)),
      );

      expect(error).toMatchObject({
        _tag: "TerminalCwdStatError",
        cwd: blockedCwd,
        cause: {
          _tag: "PlatformError",
        },
      });
    }),
  );

  it.effect("handles an exit replayed during subscription after publishing startup", () =>
    Effect.gen(function* () {
      const ptyAdapter = new FakePtyAdapter();
      ptyAdapter.exitOnSubscribe = { exitCode: 7, signal: null };
      const { manager, getEvents } = yield* createManager(5, { ptyAdapter });
      const exited = yield* Deferred.make<void>();
      const unsubscribe = yield* manager.subscribe((event) =>
        event.type === "exited"
          ? Deferred.succeed(exited, undefined).pipe(Effect.asVoid)
          : Effect.void,
      );
      yield* Effect.addFinalizer(() => Effect.sync(unsubscribe));
      yield* manager.open(openInput());
      yield* Deferred.await(exited);
      const events = yield* getEvents;
      expect(events.map((event) => event.type)).toEqual(["started", "exited"]);
      expect(events[1]).toMatchObject({ exitCode: 7 });
      const attached: TerminalAttachStreamEvent[] = [];
      const stopAttach = yield* manager.attachStream(openInput(), (event) =>
        Effect.sync(() => {
          attached.push(event);
        }),
      );
      yield* Effect.addFinalizer(() => Effect.sync(stopAttach));
      expect(attached.find((event) => event.type === "snapshot")).toMatchObject({
        snapshot: { status: "exited", exitCode: 7 },
      });
    }),
  );

  it.effect("supports asynchronous PTY spawn effects", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter } = yield* createManager(5, {
        ptyAdapter: new FakePtyAdapter("async"),
      });

      const snapshot = yield* manager.open(openInput());

      assert.equal(snapshot.status, "running");
      expect(ptyAdapter.spawnInputs).toHaveLength(1);
      expect(ptyAdapter.processes).toHaveLength(1);
    }),
  );

  it.effect("forwards write and resize to active pty process", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter } = yield* createManager();
      yield* manager.open(openInput());
      const process = ptyAdapter.processes[0];
      expect(process).toBeDefined();
      if (!process) return;

      yield* manager.write({
        threadId: "thread-1",
        terminalId: DEFAULT_TERMINAL_ID,
        data: "ls\n",
      });
      yield* manager.resize({
        threadId: "thread-1",
        terminalId: DEFAULT_TERMINAL_ID,
        cols: 120,
        rows: 30,
      });

      expect(process.writes).toEqual(["ls\n"]);
      expect(process.resizeCalls).toEqual([{ cols: 120, rows: 30 }]);
    }),
  );

  it.effect("preserves structured context and causes for PTY I/O failures", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter } = yield* createManager();
      yield* manager.open(openInput());
      const process = ptyAdapter.processes[0];
      expect(process).toBeDefined();
      if (!process) return;

      const writeCause = new Error("PTY input handle is unavailable");
      process.writeFailure = writeCause;
      const writeError = yield* Effect.flip(
        manager.write({
          threadId: "thread-1",
          terminalId: DEFAULT_TERMINAL_ID,
          data: "secret input that must not be attached to the error",
        }),
      );

      expect(writeError).toMatchObject({
        _tag: "TerminalWriteError",
        threadId: "thread-1",
        terminalId: DEFAULT_TERMINAL_ID,
        terminalPid: process.pid,
      });
      expect(writeError.cause).toBe(writeCause);
      expect(writeError).not.toHaveProperty("data");

      const resizeCause = new Error("PTY resize handle is unavailable");
      process.resizeFailure = resizeCause;
      const resizeError = yield* Effect.flip(
        manager.resize({
          threadId: "thread-1",
          terminalId: DEFAULT_TERMINAL_ID,
          cols: 132,
          rows: 40,
        }),
      );

      expect(resizeError).toMatchObject({
        _tag: "TerminalResizeError",
        threadId: "thread-1",
        terminalId: DEFAULT_TERMINAL_ID,
        terminalPid: process.pid,
        cols: 132,
        rows: 40,
      });
      expect(resizeError.cause).toBe(resizeCause);

      process.resizeFailure = undefined;
      yield* manager.open(openInput({ cols: 132, rows: 40 }));
      expect(process.resizeCalls).toEqual([{ cols: 132, rows: 40 }]);
    }),
  );

  it.effect("ignores delayed resize requests after a terminal closes", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter } = yield* createManager();
      yield* manager.open(openInput());
      const process = ptyAdapter.processes[0];
      expect(process).toBeDefined();
      if (!process) return;

      yield* manager.close({
        threadId: "thread-1",
        terminalId: DEFAULT_TERMINAL_ID,
        deleteHistory: true,
      });
      yield* manager.resize({
        threadId: "thread-1",
        terminalId: DEFAULT_TERMINAL_ID,
        cols: 120,
        rows: 30,
      });

      expect(process.resizeCalls).toEqual([]);
    }),
  );

  it.effect("resizes running terminal on open when a different size is requested", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter } = yield* createManager();
      yield* manager.open(openInput({ cols: 100, rows: 24 }));
      const process = ptyAdapter.processes[0];
      expect(process).toBeDefined();
      if (!process) return;

      const reopened = yield* manager.open(openInput({ cols: 120, rows: 30 }));

      assert.equal(reopened.status, "running");
      expect(process.resizeCalls).toEqual([{ cols: 120, rows: 30 }]);
    }),
  );

  it.effect("supports multiple terminals per thread independently", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter } = yield* createManager();
      yield* manager.open(openInput({ terminalId: "default" }));
      yield* manager.open(openInput({ terminalId: "term-2" }));

      const first = ptyAdapter.processes[0];
      const second = ptyAdapter.processes[1];
      expect(first).toBeDefined();
      expect(second).toBeDefined();
      if (!first || !second) return;

      yield* manager.write({ threadId: "thread-1", terminalId: "default", data: "pwd\n" });
      yield* manager.write({ threadId: "thread-1", terminalId: "term-2", data: "ls\n" });

      expect(first.writes).toEqual(["pwd\n"]);
      expect(second.writes).toEqual(["ls\n"]);
      expect(ptyAdapter.spawnInputs).toHaveLength(2);
    }),
  );

  it.effect("clears transcript and emits cleared event", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter, logsDir, getEvents } = yield* createManager();
      const path = yield* Path.Path;
      yield* manager.open(openInput());
      const process = ptyAdapter.processes[0];
      expect(process).toBeDefined();
      if (!process) return;

      process.emitData("hello\n");
      yield* waitFor(
        historyLogPath(logsDir).pipe(
          Effect.provideService(Path.Path, path),
          Effect.flatMap(pathExists),
        ),
      );
      yield* manager.clear({ threadId: "thread-1", terminalId: DEFAULT_TERMINAL_ID });
      yield* waitFor(
        historyLogPath(logsDir).pipe(
          Effect.provideService(Path.Path, path),
          Effect.flatMap(readFileString),
          Effect.map((text) => text === ""),
        ),
      );

      const events = yield* getEvents;
      expect(events.some((event) => event.type === "cleared")).toBe(true);
      expect(
        events.some(
          (event) =>
            event.type === "cleared" &&
            event.threadId === "thread-1" &&
            event.terminalId === DEFAULT_TERMINAL_ID,
        ),
      ).toBe(true);
    }),
  );

  it.effect("restarts terminal with empty transcript and respawns pty", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter, logsDir } = yield* createManager();
      yield* manager.open(openInput());
      const firstProcess = ptyAdapter.processes[0];
      expect(firstProcess).toBeDefined();
      if (!firstProcess) return;
      firstProcess.emitData("before restart\n");
      const path = yield* Path.Path;
      yield* waitFor(
        historyLogPath(logsDir).pipe(
          Effect.provideService(Path.Path, path),
          Effect.flatMap(pathExists),
        ),
      );

      const snapshot = yield* manager.restart(restartInput());
      assert.equal(snapshot.history, "");
      assert.equal(snapshot.status, "running");
      expect(ptyAdapter.spawnInputs).toHaveLength(2);
      yield* waitFor(
        historyLogPath(logsDir).pipe(
          Effect.provideService(Path.Path, path),
          Effect.flatMap(readFileString),
          Effect.map((text) => text === ""),
        ),
      );
    }),
  );

  it.effect("restarts a running session when open is called with a different cwd", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter, logsDir, baseDir } = yield* createManager();
      const path = yield* Path.Path;
      const originalCwd = path.join(baseDir, "original");
      const differentCwd = path.join(baseDir, "different");
      yield* makeDirectory(originalCwd);
      yield* makeDirectory(differentCwd);

      yield* manager.open(openInput({ cwd: originalCwd }));
      const firstProcess = ptyAdapter.processes[0];
      expect(firstProcess).toBeDefined();
      if (!firstProcess) return;

      firstProcess.emitData("before reopen\n");
      const logPath = yield* historyLogPath(logsDir);
      yield* waitFor(pathExists(logPath));

      const reopened = yield* manager.open(openInput({ cwd: differentCwd }));

      expect(ptyAdapter.spawnInputs).toHaveLength(2);
      assert.equal(firstProcess.killed, true);
      assert.equal(reopened.cwd, differentCwd);
      assert.equal(reopened.history, "");
      yield* waitFor(Effect.map(readFileString(logPath), (text) => text === ""));
    }),
  );

  it.effect("propagates explicit worktree metadata through snapshots and lifecycle events", () =>
    Effect.gen(function* () {
      const { manager, getEvents, baseDir } = yield* createManager();
      const path = yield* Path.Path;
      const firstWorktreePath = path.join(baseDir, "worktrees", "feature-a");
      const secondWorktreePath = path.join(baseDir, "worktrees", "feature-b");
      yield* makeDirectory(firstWorktreePath);
      yield* makeDirectory(secondWorktreePath);
      const startedSnapshot = yield* manager.open(
        openInput({
          cwd: firstWorktreePath,
          worktreePath: firstWorktreePath,
        }),
      );
      const restartedSnapshot = yield* manager.restart(
        restartInput({
          cwd: secondWorktreePath,
          worktreePath: secondWorktreePath,
        }),
      );

      assert.equal(startedSnapshot.worktreePath, firstWorktreePath);
      assert.equal(restartedSnapshot.worktreePath, secondWorktreePath);

      const events = yield* getEvents;
      const startedEvent = events.find(
        (event): event is Extract<TerminalEvent, { type: "started" }> => event.type === "started",
      );
      const restartedEvent = events.find(
        (event): event is Extract<TerminalEvent, { type: "restarted" }> =>
          event.type === "restarted",
      );

      assert.equal(startedEvent?.snapshot.worktreePath, firstWorktreePath);
      assert.equal(restartedEvent?.snapshot.worktreePath, secondWorktreePath);
    }),
  );

  it.effect("preserves worktree metadata when reopening an exited session", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter, getEvents, baseDir } = yield* createManager();
      const path = yield* Path.Path;
      const worktreePath = path.join(baseDir, "worktrees", "feature-a");
      yield* makeDirectory(worktreePath);

      yield* manager.open(
        openInput({
          cwd: worktreePath,
          worktreePath,
        }),
      );

      const process = ptyAdapter.processes[0];
      expect(process).toBeDefined();
      if (!process) return;
      process.emitExit({ exitCode: 0, signal: 0 });

      yield* waitFor(
        Effect.map(getEvents, (events) => events.some((event) => event.type === "exited")),
      );

      const reopenedSnapshot = yield* manager.open(
        openInput({
          cwd: worktreePath,
          worktreePath,
        }),
      );

      assert.equal(reopenedSnapshot.worktreePath, worktreePath);

      const events = yield* getEvents;
      const reopenedEvent = events
        .toReversed()
        .find(
          (event): event is Extract<TerminalEvent, { type: "started" }> => event.type === "started",
        );

      assert.equal(reopenedEvent?.snapshot.worktreePath, worktreePath);
    }),
  );

  it.effect("emits exited event and reopens with clean transcript after exit", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter, logsDir, getEvents } = yield* createManager();
      const path = yield* Path.Path;
      yield* manager.open(openInput());
      const process = ptyAdapter.processes[0];
      expect(process).toBeDefined();
      if (!process) return;
      process.emitData("old data\n");
      yield* waitFor(
        historyLogPath(logsDir).pipe(
          Effect.provideService(Path.Path, path),
          Effect.flatMap(pathExists),
        ),
      );
      process.emitExit({ exitCode: 0, signal: 0 });

      yield* waitFor(
        Effect.map(getEvents, (events) => events.some((event) => event.type === "exited")),
      );
      const reopened = yield* manager.open(openInput());

      assert.equal(reopened.history, "");
      expect(ptyAdapter.spawnInputs).toHaveLength(2);
      expect(
        yield* historyLogPath(logsDir).pipe(
          Effect.provideService(Path.Path, path),
          Effect.flatMap(readFileString),
        ),
      ).toBe("");
    }),
  );

  it.effect("ignores trailing writes after terminal exit", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter } = yield* createManager();
      yield* manager.open(openInput());
      const process = ptyAdapter.processes[0];
      expect(process).toBeDefined();
      if (!process) return;

      process.emitExit({ exitCode: 0, signal: 0 });

      yield* manager.write({
        threadId: "thread-1",
        terminalId: DEFAULT_TERMINAL_ID,
        data: "\r",
      });
      expect(process.writes).toEqual([]);
    }),
  );

  it.effect("emits subprocess activity events when child-process state changes", () =>
    Effect.gen(function* () {
      let inspect: {
        readonly hasRunningSubprocess: boolean;
        readonly childCommand: string | null;
        readonly processIds: ReadonlyArray<number>;
      } = { hasRunningSubprocess: false, childCommand: null, processIds: [] };
      const { manager, getEvents } = yield* createManager(5, {
        subprocessInspector: () => Effect.succeed(inspect),
        subprocessPollIntervalMs: 20,
      });

      yield* manager.open(openInput());
      expect((yield* getEvents).some((event) => event.type === "activity")).toBe(false);

      inspect = { hasRunningSubprocess: true, childCommand: "vim", processIds: [100, 101] };
      yield* waitFor(
        Effect.map(getEvents, (events) =>
          events.some(
            (event) =>
              event.type === "activity" &&
              event.hasRunningSubprocess === true &&
              event.label === "vim",
          ),
        ),
        "1200 millis",
      );

      inspect = { hasRunningSubprocess: false, childCommand: null, processIds: [] };
      yield* waitFor(
        Effect.map(getEvents, (events) =>
          events.some(
            (event) =>
              event.type === "activity" &&
              event.hasRunningSubprocess === false &&
              event.label === "Terminal 1",
          ),
        ),
        "1200 millis",
      );
    }),
  );

  it.effect("does not invoke subprocess polling until a terminal session is running", () =>
    Effect.gen(function* () {
      let checks = 0;
      const { manager } = yield* createManager(5, {
        subprocessInspector: () => {
          checks += 1;
          return Effect.succeed({
            hasRunningSubprocess: false,
            childCommand: null,
            processIds: [],
          });
        },
        subprocessPollIntervalMs: 20,
      });

      yield* Effect.sleep("80 millis");
      assert.equal(checks, 0);

      yield* manager.open(openInput());
      yield* waitFor(
        Effect.sync(() => checks > 0),
        "1200 millis",
      );
    }),
  );

  it.effect("derives subprocess activity for every terminal from one shared process snapshot", () =>
    Effect.gen(function* () {
      const runCalls: Array<{ command: string; args: ReadonlyArray<string> }> = [];
      // FakePtyAdapter assigns pids starting at 9000, so the two terminals
      // opened below run as pids 9000 and 9001.
      const psStdout = ["  100  9000 vim", "  101   100 git", "  200  9001 /usr/bin/python3"].join(
        "\n",
      );
      const processRunner: ProcessRunner.ProcessRunner["Service"] = {
        run: (input) =>
          Effect.sync(() => {
            runCalls.push({ command: input.command, args: input.args });
            return {
              stdout: psStdout,
              stderr: "",
              code: ChildProcessSpawner.ExitCode(0),
              timedOut: false,
              stdoutTruncated: false,
              stderrTruncated: false,
              stdoutInvalidUtf8: false,
              stderrInvalidUtf8: false,
            };
          }),
      };

      const { manager, getEvents } = yield* createManager(5, {
        subprocessPollIntervalMs: 20,
      }).pipe(
        Effect.provideService(ProcessRunner.ProcessRunner, processRunner),
        Effect.provide(layerWithHostPlatform("linux")),
      );

      yield* manager.open(openInput());
      yield* manager.open(openInput({ threadId: "thread-2" }));

      yield* waitFor(
        Effect.map(
          getEvents,
          (events) =>
            events.some(
              (event) =>
                event.type === "activity" &&
                event.hasRunningSubprocess === true &&
                event.label === "vim",
            ) &&
            events.some(
              (event) =>
                event.type === "activity" &&
                event.hasRunningSubprocess === true &&
                event.label === "python3",
            ),
        ),
        "1200 millis",
      );
      yield* waitFor(
        Effect.sync(() => runCalls.length >= 3),
        "1200 millis",
      );

      // Every spawn is the shared table snapshot — no per-terminal `pgrep`
      // or per-child `ps -p` invocations.
      expect(runCalls.every((call) => call.args.join(" ") === "-eo pid=,ppid=,comm=")).toBe(true);
    }),
  );

  const exitSnapshotTestProcesses = Effect.fnUntraced(function* (
    manager: ManagerFixture["manager"],
    ptyAdapter: FakePtyAdapter,
    terminals: ReadonlyArray<Pick<TerminalOpenInput, "threadId" | "terminalId">>,
  ) {
    const remainingTerminals = new Set(
      terminals.map(({ threadId, terminalId }) => JSON.stringify([threadId, terminalId])),
    );
    const exited = yield* Deferred.make<void>();
    const unsubscribe = yield* manager.subscribe((event) =>
      Effect.gen(function* () {
        if (
          event.type === "exited" &&
          remainingTerminals.delete(JSON.stringify([event.threadId, event.terminalId])) &&
          remainingTerminals.size === 0
        ) {
          yield* Deferred.succeed(exited, undefined);
        }
      }),
    );
    // Restarted processes have no live manager listener; wait for one exit
    // per current terminal rather than counting every historical fake process.
    for (const process of ptyAdapter.processes) process.emitExit({ exitCode: 0, signal: null });
    yield* Deferred.await(exited);
    unsubscribe();
  });

  it.effect.each([
    { source: "native", grouping: "threads" },
    { source: "fallback", grouping: "threads" },
    { source: "native", grouping: "terminals" },
    { source: "fallback", grouping: "terminals" },
  ] as const)(
    "shares overlapping first-input $source snapshots across $grouping and refreshes later shells",
    ({ source, grouping }) =>
      Effect.gen(function* () {
        const requestStarted = yield* Deferred.make<void>();
        const releaseRequest = yield* Deferred.make<void>();
        const ptyAdapter = new FakePtyAdapter();
        let snapshotCalls = 0;
        const processTable = Effect.gen(function* () {
          snapshotCalls += 1;
          const entries = ptyAdapter.processes.map((process) => ({
            pid: process.pid,
            ppid: 1,
            name: "zsh",
          }));
          yield* Deferred.succeed(requestStarted, undefined);
          yield* Deferred.await(releaseRequest);
          return entries;
        });
        const processRunner: ProcessRunner.ProcessRunner["Service"] = {
          run: (input) =>
            processTable.pipe(
              Effect.map((entries) => {
                expect(input.args).toEqual(["-eo", "pid=,ppid=,comm="]);
                return {
                  stdout: entries.map(({ pid, ppid, name }) => `${pid} ${ppid} ${name}`).join("\n"),
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
        const { manager } = yield* createManager(5, {
          ptyAdapter,
          shellResolver: () => "/opt/tools/my-shell",
          subprocessPollIntervalMs: 60_000,
          ...(source === "native" ? { processTable } : {}),
        }).pipe(
          Effect.provideService(ProcessRunner.ProcessRunner, processRunner),
          Effect.provide(layerWithHostPlatform("linux")),
        );
        // Let the empty-session poll park before opening any terminals.
        yield* TestClock.adjust(0);
        const terminals = [1, 2, 3].map((index) => ({
          threadId: grouping === "threads" ? `thread-${index}` : "thread-1",
          terminalId: grouping === "threads" ? DEFAULT_TERMINAL_ID : `terminal-${index}`,
        }));
        yield* Effect.forEach(terminals, (terminal) => manager.open(openInput(terminal)));
        const write = (terminal: (typeof terminals)[number]) =>
          manager.write({ ...terminal, data: "command\r" });
        const writing = yield* Effect.forEach(terminals, write, {
          concurrency: "unbounded",
        }).pipe(Effect.forkScoped);
        yield* Deferred.await(requestStarted);
        yield* TestClock.adjust(0);
        expect(snapshotCalls).toBe(1);
        expect(ptyAdapter.processes.map((process) => process.writes)).toEqual([[], [], []]);
        yield* Deferred.succeed(releaseRequest, undefined);
        yield* Fiber.join(writing);
        expect(ptyAdapter.processes.map((process) => process.writes)).toEqual([
          ["command\r"],
          ["command\r"],
          ["command\r"],
        ]);

        const laterTerminal = {
          threadId: grouping === "threads" ? "thread-4" : "thread-1",
          terminalId: grouping === "threads" ? DEFAULT_TERMINAL_ID : "terminal-4",
        };
        yield* manager.open(openInput(laterTerminal));
        yield* write(laterTerminal);
        expect(snapshotCalls).toBe(2);
        ptyAdapter.processes[0]!.exitOnKill = "SIGTERM";
        yield* manager.restart(restartInput(terminals[0]!));
        yield* write(terminals[0]!);
        expect(snapshotCalls).toBe(3);
        yield* exitSnapshotTestProcesses(manager, ptyAdapter, [...terminals, laterTerminal]);
      }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect.each([
    { source: "native", outcome: "cancel", grouping: "threads" },
    { source: "native", outcome: "timeout", grouping: "threads" },
    { source: "fallback", outcome: "cancel", grouping: "threads" },
    { source: "fallback", outcome: "timeout", grouping: "threads" },
    { source: "native", outcome: "cancel", grouping: "terminals" },
    { source: "native", outcome: "timeout", grouping: "terminals" },
    { source: "fallback", outcome: "cancel", grouping: "terminals" },
    { source: "fallback", outcome: "timeout", grouping: "terminals" },
  ] as const)(
    "abandons a shared $source snapshot across $grouping after its last waiter leaves via $outcome",
    ({ source, outcome, grouping }) =>
      Effect.gen(function* () {
        const requestStarted = yield* Deferred.make<void>();
        const releaseRequest = yield* Deferred.make<void>();
        const requestStopped = yield* Deferred.make<void>();
        const ptyAdapter = new FakePtyAdapter();
        let snapshotCalls = 0;
        let activeRequests = 0;
        const processTable = Effect.gen(function* () {
          snapshotCalls += 1;
          activeRequests += 1;
          if (snapshotCalls === 1) {
            yield* Deferred.succeed(requestStarted, undefined);
            yield* Deferred.await(releaseRequest);
          }
          return ptyAdapter.processes.map((process) => ({
            pid: process.pid,
            ppid: 1,
            name: "zsh",
          }));
        }).pipe(
          Effect.ensuring(
            Effect.sync(() => {
              activeRequests -= 1;
            }).pipe(Effect.andThen(Deferred.succeed(requestStopped, undefined))),
          ),
        );
        const processRunner: ProcessRunner.ProcessRunner["Service"] = {
          run: () =>
            processTable.pipe(
              Effect.map((entries) => ({
                stdout: entries.map(({ pid, ppid, name }) => `${pid} ${ppid} ${name}`).join("\n"),
                stderr: "",
                code: ChildProcessSpawner.ExitCode(0),
                timedOut: false,
                stdoutTruncated: false,
                stderrTruncated: false,
                stdoutInvalidUtf8: false,
                stderrInvalidUtf8: false,
              })),
            ),
        };
        const { manager } = yield* createManager(5, {
          ptyAdapter,
          shellResolver: () => "/bin/zsh",
          subprocessPollIntervalMs: 60_000,
          ...(source === "native" ? { processTable } : {}),
        }).pipe(
          Effect.provideService(ProcessRunner.ProcessRunner, processRunner),
          Effect.provide(layerWithHostPlatform("linux")),
        );
        yield* TestClock.adjust(0);
        const terminals = [1, 2].map((index) => ({
          threadId: grouping === "threads" ? `thread-${index}` : "thread-1",
          terminalId: grouping === "threads" ? DEFAULT_TERMINAL_ID : `terminal-${index}`,
        }));
        yield* Effect.forEach(terminals, (terminal) => manager.open(openInput(terminal)));
        const write = (terminal: (typeof terminals)[number]) =>
          manager.write({ ...terminal, data: "command\r" });
        const writers = yield* Effect.forEach(terminals, (terminal) =>
          write(terminal).pipe(Effect.forkScoped),
        );
        yield* Deferred.await(requestStarted);
        yield* TestClock.adjust(0);
        expect(snapshotCalls).toBe(1);
        if (outcome === "cancel") {
          yield* Fiber.interrupt(writers[0]!);
          expect(activeRequests).toBe(1);
          yield* Fiber.interrupt(writers[1]!);
        } else {
          yield* TestClock.adjust("100 millis");
          yield* Effect.forEach(writers, Fiber.join);
        }
        yield* Deferred.await(requestStopped);
        expect(snapshotCalls).toBe(1);
        expect(activeRequests).toBe(0);
        expect(ptyAdapter.processes.map((process) => process.writes)).toEqual(
          outcome === "cancel" ? [[], []] : [["command\r"], ["command\r"]],
        );
        // Releasing an abandoned source cannot publish a reusable result.
        yield* Deferred.succeed(releaseRequest, undefined);
        const nextTerminal =
          outcome === "cancel"
            ? terminals[0]!
            : {
                threadId: grouping === "threads" ? "thread-3" : "thread-1",
                terminalId: grouping === "threads" ? DEFAULT_TERMINAL_ID : "terminal-3",
              };
        if (outcome === "timeout") yield* manager.open(openInput(nextTerminal));
        yield* write(nextTerminal);
        expect(snapshotCalls).toBe(2);
        expect(activeRequests).toBe(0);
        yield* exitSnapshotTestProcesses(
          manager,
          ptyAdapter,
          outcome === "timeout" ? [...terminals, nextTerminal] : terminals,
        );
      }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("keeps last known subprocess state when the process snapshot fails", () =>
    Effect.gen(function* () {
      let failSnapshots = false;
      let failedCalls = 0;
      const processRunner: ProcessRunner.ProcessRunner["Service"] = {
        run: () =>
          Effect.sync(() => {
            if (failSnapshots) failedCalls += 1;
            return {
              stdout: failSnapshots ? "" : "  100  9000 vim",
              stderr: "",
              code: ChildProcessSpawner.ExitCode(failSnapshots ? 1 : 0),
              timedOut: false,
              stdoutTruncated: false,
              stderrTruncated: false,
              stdoutInvalidUtf8: false,
              stderrInvalidUtf8: false,
            };
          }),
      };

      const { manager, getEvents } = yield* createManager(5, {
        subprocessPollIntervalMs: 20,
      }).pipe(
        Effect.provideService(ProcessRunner.ProcessRunner, processRunner),
        Effect.provide(layerWithHostPlatform("linux")),
      );

      yield* manager.open(openInput());
      yield* waitFor(
        Effect.map(getEvents, (events) =>
          events.some(
            (event) =>
              event.type === "activity" &&
              event.hasRunningSubprocess === true &&
              event.label === "vim",
          ),
        ),
        "1200 millis",
      );

      failSnapshots = true;
      yield* waitFor(
        Effect.sync(() => failedCalls >= 3),
        "1200 millis",
      );

      // A failed snapshot is not authoritative: no terminal flips to idle.
      const activityEvents = (yield* getEvents).filter((event) => event.type === "activity");
      expect(activityEvents.length).toBeGreaterThan(0);
      expect(activityEvents.every((event) => event.hasRunningSubprocess === true)).toBe(true);
    }),
  );

  it("calculates snapshot failure backoff and success reset delays", () => {
    assert.equal(TerminalManager.subprocessSnapshotPollDelayMs(1_000, 0), 1_000);
    assert.equal(TerminalManager.subprocessSnapshotPollDelayMs(1_000, 1), 2_000);
    assert.equal(TerminalManager.subprocessSnapshotPollDelayMs(1_000, 2), 4_000);
    assert.equal(TerminalManager.subprocessSnapshotPollDelayMs(1_000, 30), 60_000);
  });

  it.effect("uses process snapshots from the resource monitor", () =>
    Effect.gen(function* () {
      let snapshotCalls = 0;
      const { manager, getEvents } = yield* createManager(5, {
        subprocessPollIntervalMs: 20,
        processTable: Effect.sync(() => {
          snapshotCalls += 1;
          return [{ pid: 100, ppid: 9000, name: "ping.exe" }];
        }),
      }).pipe(Effect.provide(layerWithHostPlatform("win32")));

      yield* manager.open(openInput());
      yield* waitFor(
        Effect.map(getEvents, (events) =>
          events.some(
            (event) =>
              event.type === "activity" && event.hasRunningSubprocess && event.label === "ping",
          ),
        ),
        "1200 millis",
      );
      expect(snapshotCalls).toBeGreaterThan(0);
    }),
  );

  it.effect("closes only a thread's idle shells, ignoring a helper forked from the shell", () =>
    Effect.gen(function* () {
      // FakePtyAdapter assigns pids from 9000 in open order.
      const { manager, ptyAdapter } = yield* createManager(5, {
        shellResolver: () => "/bin/zsh",
        processTable: Effect.succeed([
          { pid: 9000, ppid: 1, name: "zsh" },
          // An async prompt worker: a copy of the shell with no children.
          { pid: 100, ppid: 9000, name: "zsh" },
          { pid: 9001, ppid: 1, name: "zsh" },
          { pid: 200, ppid: 9001, name: "node" },
          { pid: 9002, ppid: 1, name: "zsh" },
          // A subshell with a child is real work.
          { pid: 300, ppid: 9002, name: "zsh" },
          { pid: 301, ppid: 300, name: "sleep" },
          { pid: 9003, ppid: 1, name: "zsh" },
        ]),
      }).pipe(Effect.provide(layerWithHostPlatform("linux")));
      yield* manager.open(openInput({ terminalId: "idle" }));
      yield* manager.open(openInput({ terminalId: "dev-server" }));
      yield* manager.open(openInput({ terminalId: "subshell" }));
      yield* manager.open(openInput({ threadId: "thread-2" }));

      yield* manager.closeIdle({ threadId: "thread-1" });

      expect(ptyAdapter.processes.map((process) => process.killed)).toEqual([
        true,
        false,
        false,
        false,
      ]);
    }),
  );

  it.effect("batches idle checks while excluding managed preview terminals", () =>
    Effect.gen(function* () {
      let snapshotCalls = 0;
      const ptyAdapter = new FakePtyAdapter();
      const { manager } = yield* createManager(5, {
        ptyAdapter,
        shellResolver: () => "/bin/zsh",
        subprocessPollIntervalMs: 60_000,
        processTable: Effect.sync(() => {
          snapshotCalls += 1;
          return ptyAdapter.processes.map((process) => ({
            pid: process.pid,
            ppid: 1,
            name: "zsh",
          }));
        }),
      }).pipe(Effect.provide(layerWithHostPlatform("linux")));
      yield* manager.open(openInput({ terminalId: "idle-one" }));
      yield* manager.open(openInput({ terminalId: "preview-managed" }));
      yield* manager.open(openInput({ terminalId: "idle-two" }));
      // Ignore any initial monitor tick triggered while opening the sessions.
      snapshotCalls = 0;
      yield* manager.closeIdle({
        threadId: "thread-1",
        excludedTerminalIds: ["preview-managed"],
      });

      expect(ptyAdapter.processes.map((process) => process.killed)).toEqual([true, false, true]);
      expect(snapshotCalls).toBe(1);
    }),
  );

  it.effect.each(["darwin", "linux"] as const)(
    "keeps a childless exec command while closing idle shells on %s",
    (platform) =>
      Effect.gen(function* () {
        let commandsStarted = false;
        const { manager, ptyAdapter } = yield* createManager(5, {
          shellResolver: () => "/bin/zsh",
          subprocessPollIntervalMs: 60_000,
          processTable: Effect.sync(() =>
            [
              { pid: 9000, ppid: 1, name: "node" },
              { pid: 9001, ppid: 1, name: "/bin/zsh" },
              { pid: 9002, ppid: 1, name: "-zsh" },
              // A login shell's async prompt helper is still idle.
              { pid: 100, ppid: 9002, name: "zsh" },
              { pid: 9003, ppid: 1, name: "zsh" },
              { pid: 200, ppid: 9003, name: "node" },
              { pid: 9004, ppid: 1, name: "zsh" },
              { pid: 300, ppid: 9004, name: "zsh" },
              { pid: 301, ppid: 300, name: "sleep" },
              // A missing process name alone is not evidence of exec.
              { pid: 9005, ppid: 1, name: "" },
            ].map((entry) =>
              entry.ppid === 1 && !commandsStarted ? { ...entry, name: "zsh" } : entry,
            ),
          ),
        }).pipe(Effect.provide(layerWithHostPlatform(platform)));
        for (const terminalId of ["exec", "idle", "login", "child", "subshell", "unknown"]) {
          yield* manager.open(openInput({ terminalId }));
          yield* manager.write({ threadId: "thread-1", terminalId, data: "exec command\r" });
        }

        commandsStarted = true;
        yield* manager.closeIdle({ threadId: "thread-1" });

        expect(ptyAdapter.processes.map((process) => process.killed)).toEqual([
          false,
          true,
          true,
          false,
          false,
          true,
        ]);
      }),
  );

  it.effect("attributes exec roots and descendants during preview metadata refresh", () =>
    Effect.gen(function* () {
      let commandsStarted = false;
      const registered = new Map<string, ReadonlyArray<number>>();
      const { manager } = yield* createManager(5, {
        shellResolver: () => "/bin/zsh",
        subprocessPollIntervalMs: 60_000,
        processTable: Effect.sync(() =>
          [
            { pid: 9000, ppid: 1, name: "/usr/bin/node" },
            { pid: 9001, ppid: 1, name: "zsh" },
            { pid: 100, ppid: 9001, name: "node" },
            { pid: 101, ppid: 100, name: "sleep" },
            { pid: 9002, ppid: 1, name: "-zsh" },
            { pid: 200, ppid: 9002, name: "zsh" },
          ].map((entry) =>
            entry.ppid === 1 && !commandsStarted ? { ...entry, name: "zsh" } : entry,
          ),
        ),
        registerTerminalProcesses: ({ terminalId, processIds }) =>
          Effect.sync(() => {
            registered.set(terminalId, processIds);
          }),
      }).pipe(Effect.provide(layerWithHostPlatform("darwin")));
      for (const terminalId of ["exec", "child", "idle"]) {
        yield* manager.open(openInput({ terminalId }));
        yield* manager.write({ threadId: "thread-1", terminalId, data: "exec command\r" });
      }

      commandsStarted = true;
      const summaries = yield* manager.refreshMetadata;

      expect(summaries.find((summary) => summary.terminalId === "exec")).toEqual(
        expect.objectContaining({ hasRunningSubprocess: true, label: "node" }),
      );
      expect(registered.get("exec")).toEqual([9000]);
      expect(registered.get("child")).toEqual([9001, 100, 101]);
      expect(registered.get("idle")).toEqual([]);
    }),
  );

  it.effect("reports the command that replaced the shell through terminal activity", () =>
    Effect.gen(function* () {
      let commandsStarted = false;
      const activity = yield* Deferred.make<TerminalEvent>();
      const { manager } = yield* createManager(5, {
        shellResolver: () => "/bin/zsh",
        processTable: Effect.sync(() => [
          { pid: 9000, ppid: 1, name: commandsStarted ? "/usr/bin/node" : "zsh" },
        ]),
      }).pipe(Effect.provide(layerWithHostPlatform("linux")));
      const unsubscribe = yield* manager.subscribe((event) =>
        event.type === "activity"
          ? Deferred.succeed(activity, event).pipe(Effect.asVoid)
          : Effect.void,
      );
      yield* Effect.addFinalizer(() => Effect.sync(unsubscribe));
      yield* manager.open(openInput());
      yield* manager.write({
        threadId: "thread-1",
        terminalId: DEFAULT_TERMINAL_ID,
        data: "exec node\r",
      });
      commandsStarted = true;

      expect(yield* Deferred.await(activity)).toEqual(
        expect.objectContaining({ type: "activity", hasRunningSubprocess: true, label: "node" }),
      );
    }),
  );

  it.effect("uses the successful fallback shell identity when checking idle terminals", () =>
    Effect.gen(function* () {
      const ptyAdapter = new FakePtyAdapter();
      ptyAdapter.spawnFailures.push(new Error("posix_spawnp failed."));
      const { manager } = yield* createManager(5, {
        ptyAdapter,
        shellResolver: () => "/missing/preferred-shell",
        env: { SHELL: "/bin/zsh" },
        subprocessPollIntervalMs: 60_000,
        processTable: Effect.succeed([{ pid: 9000, ppid: 1, name: "zsh" }]),
      }).pipe(Effect.provide(layerWithHostPlatform("linux")));
      yield* manager.open(openInput());
      expect(ptyAdapter.spawnInputs.map((input) => input.shell)).toEqual([
        "/missing/preferred-shell",
        "/bin/zsh",
      ]);
      // zsh's spawn arguments must not be included in its captured identity.
      expect(ptyAdapter.spawnInputs[1]?.args).toEqual(["-o", "nopromptsp"]);

      yield* manager.closeIdle({ threadId: "thread-1" });

      expect(ptyAdapter.processes[0]?.killed).toBe(true);
    }),
  );

  it.effect("recognizes an idle custom shell without a shell-name allowlist", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter } = yield* createManager(5, {
        shellResolver: () => "/opt/tools/custom-shell",
        subprocessPollIntervalMs: 60_000,
        processTable: Effect.succeed([
          { pid: 9000, ppid: 1, name: "custom-shell" },
          { pid: 100, ppid: 9000, name: "custom-shell" },
        ]),
      }).pipe(Effect.provide(layerWithHostPlatform("linux")));
      yield* manager.open(openInput());

      yield* manager.closeIdle({ threadId: "thread-1" });

      expect(ptyAdapter.processes[0]?.killed).toBe(true);
    }),
  );

  it.effect.each([
    { shellName: "custom-login-shell", commName: "custom-login-sh" },
    { shellName: "custom-é-shell-name", commName: "custom-é-shell" },
  ])(
    "closes full shell names but keeps ambiguous Linux comm names for $shellName",
    ({ shellName, commName }) =>
      Effect.gen(function* () {
        let commandsStarted = false;
        const { manager, ptyAdapter } = yield* createManager(5, {
          shellResolver: () => `/opt/tools/${shellName}`,
          subprocessPollIntervalMs: 60_000,
          processTable: Effect.sync(() =>
            [
              { pid: 9000, ppid: 1, name: `-${shellName}` },
              { pid: 100, ppid: 9000, name: shellName },
              { pid: 9001, ppid: 1, name: commName },
              { pid: 200, ppid: 9001, name: commName },
              { pid: 9002, ppid: 1, name: "node" },
              // Neither a shorter prefix nor a different full name is the shell.
              { pid: 9003, ppid: 1, name: "custom" },
              { pid: 9004, ppid: 1, name: `${shellName}-worker` },
            ].map((entry) =>
              entry.ppid === 1 && !commandsStarted ? { ...entry, name: shellName } : entry,
            ),
          ),
        }).pipe(Effect.provide(layerWithHostPlatform("linux")));
        for (const terminalId of ["full", "comm", "exec", "short-prefix", "different-full"]) {
          yield* manager.open(openInput({ terminalId }));
          yield* manager.write({ threadId: "thread-1", terminalId, data: "exec command\r" });
        }

        commandsStarted = true;
        yield* manager.closeIdle({ threadId: "thread-1" });

        expect(ptyAdapter.processes.map((process) => process.killed)).toEqual([
          true,
          false,
          false,
          false,
          false,
        ]);
      }),
  );

  it.effect.each(["custom-login-shell", "my-shell", "custom-login-sh"])(
    "retains a childless matching-prefix exec and ownership when configured shell is %s",
    (shellName) =>
      Effect.gen(function* () {
        const ownedProcessIds = yield* Deferred.make<ReadonlyArray<number>>();
        const { manager, ptyAdapter } = yield* createManager(5, {
          shellResolver: () => `/opt/tools/${shellName}`,
          // custom-login-shell-worker has the same 15-byte comm as the shell.
          processTable: Effect.succeed([{ pid: 9000, ppid: 1, name: "custom-login-sh" }]),
          registerTerminalProcesses: ({ processIds }) =>
            processIds.length > 0
              ? Deferred.succeed(ownedProcessIds, processIds).pipe(Effect.asVoid)
              : Effect.void,
        }).pipe(Effect.provide(layerWithHostPlatform("linux")));
        yield* manager.open(openInput());

        expect(yield* Deferred.await(ownedProcessIds)).toEqual([9000]);
        yield* manager.write({
          threadId: "thread-1",
          terminalId: DEFAULT_TERMINAL_ID,
          data: "exec custom-login-shell-worker\r",
        });
        yield* manager.closeIdle({ threadId: "thread-1" });

        expect(ptyAdapter.processes[0]?.killed).toBe(false);
      }),
  );

  it.effect("closes an idle shell started through a differently named wrapper", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter } = yield* createManager(5, {
        shellResolver: () => "/opt/tools/my-shell",
        processTable: Effect.succeed([{ pid: 9000, ppid: 1, name: "zsh" }]),
      }).pipe(Effect.provide(layerWithHostPlatform("linux")));
      yield* manager.open(openInput());
      expect((yield* manager.refreshMetadata)[0]?.hasRunningSubprocess).toBe(false);
      yield* manager.closeIdle({ threadId: "thread-1" });
      expect(ptyAdapter.processes[0]?.killed).toBe(true);
    }),
  );

  it.effect("keeps later input behind the first PTY write after capture completes", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter } = yield* createManager(5, {
        shellResolver: () => "/bin/zsh",
        subprocessPollIntervalMs: 60_000,
        processTable: Effect.succeed([{ pid: 9000, ppid: 1, name: "zsh" }]),
      }).pipe(Effect.provide(layerWithHostPlatform("linux")));
      yield* manager.open(openInput());
      const process = ptyAdapter.processes[0]!;
      const originalWrite = process.write.bind(process);
      const startLaterWrite = yield* Deferred.make<void>();
      const laterWrite = yield* Deferred.await(startLaterWrite).pipe(
        Effect.andThen(
          manager.write({
            threadId: "thread-1",
            terminalId: DEFAULT_TERMINAL_ID,
            data: "later input\r",
          }),
        ),
        Effect.forkScoped({ startImmediately: true }),
      );
      process.write = (data) => {
        if (data === "first input\r") {
          // Start the next chunk synchronously at the forwarding boundary.
          // It must still queue even though the cached capture has completed.
          Deferred.doneUnsafe(startLaterWrite, Effect.void);
        }
        originalWrite(data);
      };

      yield* manager.write({
        threadId: "thread-1",
        terminalId: DEFAULT_TERMINAL_ID,
        data: "first input\r",
      });
      yield* Fiber.join(laterWrite);
      expect(process.writes).toEqual(["first input\r", "later input\r"]);
    }),
  );

  it.effect.each(["deliver", "cancel", "fail"] as const)(
    "preserves three-chunk input order when the queued middle chunk must %s",
    (outcome) =>
      Effect.gen(function* () {
        const captureEntered = yield* Deferred.make<void>();
        const finishCapture = yield* Deferred.make<void>();
        const startThird = yield* Deferred.make<void>();
        const { manager, ptyAdapter } = yield* createManager(5, {
          shellResolver: () => "/bin/zsh",
          subprocessPollIntervalMs: 60_000,
          processTable: Effect.gen(function* () {
            yield* Deferred.succeed(captureEntered, undefined);
            yield* Deferred.await(finishCapture);
            return [{ pid: 9000, ppid: 1, name: "zsh" }];
          }),
        }).pipe(Effect.provide(layerWithHostPlatform("linux")));
        yield* manager.open(openInput());
        const process = ptyAdapter.processes[0]!;
        const originalWrite = process.write.bind(process);
        process.write = (data) => {
          if (outcome === "fail" && data === "middle\r") throw new Error("middle write failed");
          originalWrite(data);
        };
        const write = (data: string) =>
          manager.write({ threadId: "thread-1", terminalId: DEFAULT_TERMINAL_ID, data });
        const third = yield* Deferred.await(startThird).pipe(
          Effect.andThen(write("third\r")),
          Effect.forkScoped({ startImmediately: true }),
        );
        const first = yield* write("first\r").pipe(
          // This continuation runs after successful forwarding clears the
          // first-input gate, while the earlier middle request is queued.
          Effect.andThen(Deferred.succeed(startThird, undefined)),
          Effect.forkScoped({ startImmediately: true }),
        );
        yield* Deferred.await(captureEntered);
        const middle = yield* write("middle\r").pipe(
          Effect.result,
          Effect.forkScoped({ startImmediately: true }),
        );
        expect(middle.pollUnsafe()).toBeUndefined();
        if (outcome === "cancel") yield* Fiber.interrupt(middle);
        expect(process.writes).toEqual([]);
        yield* Deferred.succeed(finishCapture, undefined);
        yield* Fiber.join(first);
        if (outcome !== "cancel") {
          expect((yield* Fiber.join(middle))._tag).toBe(
            outcome === "deliver" ? "Success" : "Failure",
          );
        }
        yield* Fiber.join(third);
        expect(process.writes).toEqual(
          outcome === "deliver" ? ["first\r", "middle\r", "third\r"] : ["first\r", "third\r"],
        );
        yield* exitSnapshotTestProcesses(manager, ptyAdapter, [openInput()]);
      }),
  );

  it.effect("keeps forwarded exec active when its writer is canceled before resuming", () =>
    Effect.gen(function* () {
      const captureEntered = yield* Deferred.make<void>();
      const finishCapture = yield* Deferred.make<void>();
      let commandName = "zsh";
      const { manager, ptyAdapter } = yield* createManager(5, {
        shellResolver: () => "/bin/zsh",
        subprocessPollIntervalMs: 60_000,
        processTable: Effect.gen(function* () {
          const name = commandName;
          yield* Deferred.succeed(captureEntered, undefined);
          yield* Deferred.await(finishCapture);
          return [{ pid: 9000, ppid: 1, name }];
        }),
      }).pipe(Effect.provide(layerWithHostPlatform("linux")));
      yield* manager.open(openInput());
      const process = ptyAdapter.processes[0]!;
      const originalWrite = process.write.bind(process);
      let interruptWriter = () => {};
      process.write = (data) => {
        originalWrite(data);
        commandName = "node";
        interruptWriter();
      };
      const writing = yield* manager
        .write({ threadId: "thread-1", terminalId: DEFAULT_TERMINAL_ID, data: "exec node\r" })
        .pipe(Effect.forkScoped({ startImmediately: true }));
      interruptWriter = () => writing.interruptUnsafe();
      yield* Deferred.await(captureEntered);
      yield* Deferred.succeed(finishCapture, undefined);
      expect(Exit.isFailure(yield* Fiber.await(writing))).toBe(true);
      expect(process.writes).toEqual(["exec node\r"]);

      yield* manager.closeIdle({ threadId: "thread-1" });
      expect(process.killed).toBe(false);
      expect((yield* manager.refreshMetadata)[0]?.hasRunningSubprocess).toBe(true);
    }),
  );

  it.effect.each(["close", "restart"] as const)(
    "freezes wrapper identity while first input and %s overlap",
    (operation) =>
      Effect.gen(function* () {
        const captureEntered = yield* Deferred.make<void>();
        const releaseCapture = yield* Deferred.make<void>();
        const secondStarted = yield* Deferred.make<void>();
        const closeStarted = yield* Deferred.make<void>();
        let commandName = "zsh";
        let snapshotCalls = 0;
        let capturing = false;
        const { manager, ptyAdapter } = yield* createManager(5, {
          shellResolver: () => "/opt/tools/my-shell",
          subprocessPollIntervalMs: 60_000,
          processTable: Effect.gen(function* () {
            snapshotCalls += 1;
            const name = commandName;
            if (capturing) {
              yield* Deferred.succeed(captureEntered, undefined);
              yield* Deferred.await(releaseCapture);
            }
            return [
              { pid: 9000, ppid: 1, name },
              { pid: 9001, ppid: 1, name },
            ];
          }),
        }).pipe(Effect.provide(layerWithHostPlatform("linux")));
        yield* manager.open(openInput());
        const process = ptyAdapter.processes[0]!;
        const originalWrite = process.write.bind(process);
        process.write = (data) => {
          originalWrite(data);
          commandName = "node";
        };
        capturing = true;
        const first = yield* manager
          .write({ threadId: "thread-1", terminalId: DEFAULT_TERMINAL_ID, data: "exec node\r" })
          .pipe(Effect.forkScoped);
        yield* Deferred.await(captureEntered);
        const second = yield* Deferred.succeed(secondStarted, undefined).pipe(
          Effect.andThen(
            operation === "close"
              ? manager.write({
                  threadId: "thread-1",
                  terminalId: DEFAULT_TERMINAL_ID,
                  data: "second input\r",
                })
              : Effect.void,
          ),
          Effect.forkScoped,
        );
        yield* Deferred.await(secondStarted);
        const close = yield* Deferred.succeed(closeStarted, undefined).pipe(
          Effect.andThen(
            operation === "close"
              ? manager.closeIdle({ threadId: "thread-1" })
              : manager.restart(restartInput()),
          ),
          Effect.forkScoped,
        );
        yield* Deferred.await(closeStarted);
        expect(process.killed).toBe(false);
        expect(process.writes).toEqual([]);
        yield* Deferred.succeed(releaseCapture, undefined);
        yield* Fiber.join(first);
        yield* Fiber.join(second);
        expect(snapshotCalls).toBeLessThanOrEqual(3);
        capturing = false;
        yield* Fiber.join(close);
        expect(process.writes).toEqual(
          operation === "close" ? ["exec node\r", "second input\r"] : ["exec node\r"],
        );
        expect(process.killed).toBe(operation === "restart");
        if (operation === "restart") {
          // Restart must capture the new shell, rather than retaining old identity.
          commandName = "zsh";
          yield* manager.write({
            threadId: "thread-1",
            terminalId: DEFAULT_TERMINAL_ID,
            data: "exec node\r",
          });
          commandName = "node";
          yield* manager.closeIdle({ threadId: "thread-1" });
          expect(ptyAdapter.processes[1]?.killed).toBe(false);
          expect(ptyAdapter.processes[1]?.writes).toEqual(["exec node\r"]);
        }
      }),
  );

  it.effect.each(["deliver", "cancel", "fail"] as const)(
    "protects first input queued behind idle cleanup and releases pending input after %s",
    (outcome) =>
      Effect.gen(function* () {
        const inspectionEntered = yield* Deferred.make<void>();
        const finishInspection = yield* Deferred.make<void>();
        let checking = false;
        const { manager, ptyAdapter } = yield* createManager(5, {
          shellResolver: () => "/bin/zsh",
          subprocessPollIntervalMs: 60_000,
          processKillGraceMs: 0,
          processTable: Effect.gen(function* () {
            if (checking) {
              yield* Deferred.succeed(inspectionEntered, undefined);
              yield* Deferred.await(finishInspection);
            }
            return [{ pid: 9000, ppid: 1, name: "zsh" }];
          }),
        }).pipe(Effect.provide(layerWithHostPlatform("linux")));
        yield* manager.open(openInput());
        const process = ptyAdapter.processes[0]!;
        process.exitOnKill = "SIGTERM";
        if (outcome === "fail") process.writeFailure = new Error("write failed");
        checking = true;
        const closing = yield* manager
          .closeIdle({ threadId: "thread-1" })
          .pipe(Effect.forkScoped({ startImmediately: true }));
        yield* Deferred.await(inspectionEntered);
        const writing = yield* manager
          .write({ threadId: "thread-1", terminalId: DEFAULT_TERMINAL_ID, data: "command\r" })
          .pipe(Effect.result, Effect.forkScoped({ startImmediately: true }));
        expect(writing.pollUnsafe()).toBeUndefined();
        if (outcome === "cancel") yield* Fiber.interrupt(writing);
        checking = false;
        yield* Deferred.succeed(finishInspection, undefined);
        yield* Fiber.join(closing);
        if (outcome !== "cancel") {
          expect((yield* Fiber.join(writing))._tag).toBe(
            outcome === "deliver" ? "Success" : "Failure",
          );
        }
        expect(process.killed).toBe(false);
        expect(process.writes).toEqual(outcome === "deliver" ? ["command\r"] : []);
        // Failed/canceled requests must not leave a permanent cleanup blocker.
        yield* manager.closeIdle({ threadId: "thread-1" });
        expect(process.killed).toBe(true);
      }),
  );

  it.effect(
    "bounds first input when the process monitor stalls without adopting the later exec",
    () =>
      Effect.gen(function* () {
        const captureEntered = yield* Deferred.make<void>();
        const stalledMonitor = yield* Deferred.make<void>();
        const ownedProcessIds = yield* Deferred.make<ReadonlyArray<number>>();
        const exited = yield* Deferred.make<void>();
        let stalled = true;
        const { manager, ptyAdapter } = yield* createManager(5, {
          shellResolver: () => "/bin/zsh",
          subprocessPollIntervalMs: 60_000,
          processTable: Effect.gen(function* () {
            if (stalled) {
              yield* Deferred.succeed(captureEntered, undefined);
              yield* Deferred.await(stalledMonitor);
            }
            return [{ pid: 9000, ppid: 1, name: "node" }];
          }),
          registerTerminalProcesses: ({ processIds }) =>
            processIds.length > 0
              ? Deferred.succeed(ownedProcessIds, processIds).pipe(Effect.asVoid)
              : Effect.void,
        }).pipe(Effect.provide(layerWithHostPlatform("linux")));
        const unsubscribe = yield* manager.subscribe((event) =>
          event.type === "exited"
            ? Deferred.succeed(exited, undefined).pipe(Effect.asVoid)
            : Effect.void,
        );
        yield* Effect.addFinalizer(() => Effect.sync(unsubscribe));
        yield* manager.open(openInput());
        const process = ptyAdapter.processes[0]!;
        process.exitOnKill = "SIGTERM";
        const writing = yield* manager
          .write({ threadId: "thread-1", terminalId: DEFAULT_TERMINAL_ID, data: "exec node\r" })
          .pipe(Effect.forkScoped({ startImmediately: true }));
        yield* Deferred.await(captureEntered);
        expect(process.writes).toEqual([]);
        yield* TestClock.adjust("100 millis");
        yield* Fiber.join(writing);
        expect(process.writes).toEqual(["exec node\r"]);
        stalled = false;
        yield* Deferred.succeed(stalledMonitor, undefined);
        yield* manager.closeIdle({ threadId: "thread-1" });
        expect(process.killed).toBe(false);
        yield* TestClock.adjust("60 seconds");
        expect(yield* Deferred.await(ownedProcessIds)).toEqual([9000]);
        process.emitExit({ exitCode: 0, signal: null });
        yield* Deferred.await(exited);
      }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("keeps Windows root detection based on child processes", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter } = yield* createManager(5, {
        shellResolver: () => "pwsh.exe",
        subprocessPollIntervalMs: 60_000,
        processTable: Effect.succeed([
          { pid: 9000, ppid: 1, name: "node.exe" },
          { pid: 9001, ppid: 1, name: "pwsh.exe" },
          { pid: 100, ppid: 9001, name: "node.exe" },
        ]),
      }).pipe(Effect.provide(layerWithHostPlatform("win32")));
      yield* manager.open(openInput({ terminalId: "root" }));
      yield* manager.open(openInput({ terminalId: "child" }));

      yield* manager.closeIdle({ threadId: "thread-1" });

      expect(ptyAdapter.processes.map((process) => process.killed)).toEqual([true, false]);
    }),
  );

  it.effect("keeps terminals that get input or output while closeIdle checks them", () =>
    Effect.gen(function* () {
      const ptyAdapter = new FakePtyAdapter();
      // The typed command's process misses the snapshot, but its input or echo lands.
      let duringCheck: (pid: number) => Effect.Effect<void> = () => Effect.void;
      const { manager, getEvents } = yield* createManager(5, {
        ptyAdapter,
        subprocessPollIntervalMs: 60_000,
        subprocessInspector: (pid) =>
          duringCheck(pid).pipe(
            Effect.as({ hasRunningSubprocess: false, childCommand: null, processIds: [] }),
          ),
      });
      yield* manager.open(openInput({ terminalId: "typed" }));
      yield* manager.open(openInput({ terminalId: "echoed" }));
      const [typed, echoed] = ptyAdapter.processes;
      duringCheck = (pid) =>
        pid === typed!.pid
          ? manager
              .write({ threadId: "thread-1", terminalId: "typed", data: "make build\r" })
              .pipe(Effect.orDie)
          : Effect.gen(function* () {
              echoed!.emitData("make build\r\n");
              yield* waitFor(
                Effect.map(getEvents, (events) => events.some((event) => event.type === "output")),
              );
            }).pipe(Effect.orDie);

      yield* manager.closeIdle({ threadId: "thread-1" });

      expect(ptyAdapter.processes.map((process) => process.killed)).toEqual([false, false]);
    }),
  );

  it.effect("backs off the spawned fallback when the resource monitor snapshot fails", () =>
    Effect.gen(function* () {
      const fallbackCalls: Array<number> = [];
      const processRunner: ProcessRunner.ProcessRunner["Service"] = {
        run: () =>
          Clock.currentTimeMillis.pipe(
            Effect.map((now) => {
              fallbackCalls.push(now);
              return {
                stdout: "  100  9000 vim",
                stderr: "",
                code: ChildProcessSpawner.ExitCode(0),
                timedOut: false,
                stdoutTruncated: false,
                stderrInvalidUtf8: false,
                stdoutInvalidUtf8: false,
                stderrTruncated: false,
              };
            }),
          ),
      };

      const { manager, getEvents } = yield* createManager(5, {
        subprocessPollIntervalMs: 20,
        processTable: Effect.fail("sidecar unavailable").pipe(
          Effect.mapError((cause) => cause as never),
        ),
      }).pipe(
        Effect.provideService(ProcessRunner.ProcessRunner, processRunner),
        Effect.provide(layerWithHostPlatform("linux")),
      );

      yield* manager.open(openInput());
      // The fallback data is still applied while the sidecar is down.
      yield* waitFor(
        Effect.map(getEvents, (events) =>
          events.some(
            (event) =>
              event.type === "activity" &&
              event.hasRunningSubprocess === true &&
              event.label === "vim",
          ),
        ),
        "1200 millis",
      );

      yield* waitFor(
        Effect.sync(() => fallbackCalls.length >= 4),
        "2000 millis",
      );
      // Four snapshots at the 20 ms base cadence would span ~60 ms. Backoff
      // (40 + 80 + 160 ms) stretches the same four snapshots past 150 ms, so
      // a stalled sidecar no longer hot-loops the spawned fallback.
      const spanMs = fallbackCalls[3]! - fallbackCalls[0]!;
      expect(spanMs).toBeGreaterThan(150);
    }),
  );

  it.effect("caps persisted history to configured line limit", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter } = yield* createManager(3);
      yield* manager.open(openInput());
      const process = ptyAdapter.processes[0];
      expect(process).toBeDefined();
      if (!process) return;

      process.emitData("line1\nline2\nline3\nline4\n");
      yield* manager.close({ threadId: "thread-1" });

      const reopened = yield* manager.open(openInput());
      const nonEmptyLines = reopened.history.split("\n").filter((line) => line.length > 0);
      expect(nonEmptyLines).toEqual(["line2", "line3", "line4"]);
    }),
  );

  it.effect("caps incrementally appended history without losing partial or empty lines", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter } = yield* createManager(3);
      yield* manager.open(openInput());
      const process = ptyAdapter.processes[0];
      expect(process).toBeDefined();
      if (!process) return;

      process.emitData("line1\n");
      process.emitData("\n");
      process.emitData("line3");
      process.emitData("-continued\nline4");
      yield* manager.close({ threadId: "thread-1" });

      const reopened = yield* manager.open(openInput());
      expect(reopened.history).toBe("\nline3-continued\nline4");
    }),
  );

  it.effect("bounds persisted and attached history without truncating live output", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter, logsDir } = yield* createManager(5, { historyByteLimit: 10 });
      const attachEvents = yield* Ref.make<ReadonlyArray<TerminalAttachStreamEvent>>([]);
      const unsubscribe = yield* manager.attachStream(openInput(), (event) =>
        Ref.update(attachEvents, (events) => [...events, event]),
      );
      yield* Effect.addFinalizer(() => Effect.sync(unsubscribe));
      const writes = ["a".repeat(32), "😀\rEND"];
      const process = ptyAdapter.processes[0]!;
      for (const text of writes) process.emitData(text);
      yield* manager.close({ threadId: "thread-1" });
      expect(yield* readFileString(yield* historyLogPath(logsDir))).toBe("aa😀\rEND");

      const reopened = yield* manager.open(openInput());
      const events = yield* Ref.get(attachEvents);
      expect(events.filter((event) => event.type === "output").map((event) => event.data)).toEqual(
        writes,
      );
      const snapshot = events.filter((event) => event.type === "snapshot").at(-1)?.snapshot;
      expect(snapshot?.history).toBe("aa😀\rEND");
      expect(snapshot?.sequence).toBe(reopened.sequence);
    }),
  );

  it.effect.each(["current", "legacy"] as const)(
    "reads only a Unicode-safe tail from oversized %s history",
    (source) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        let sourcePath: string | undefined;
        let closedReads = 0;
        const readRequests: number[] = [];
        const trackedFileSystem = FileSystem.FileSystem.of({
          ...fs,
          readFileString: (candidate, encoding) =>
            candidate === sourcePath
              ? Effect.die("History restoration must not read the whole file")
              : fs.readFileString(candidate, encoding),
          open: (candidate, options) =>
            Effect.gen(function* () {
              if (candidate !== sourcePath) return yield* fs.open(candidate, options);
              yield* Effect.addFinalizer(() =>
                Effect.sync(() => {
                  closedReads += 1;
                }),
              );
              const file = yield* fs.open(candidate, options);
              return new Proxy(file, {
                get(target, key) {
                  if (key === "read") {
                    return (buffer: Uint8Array) => {
                      readRequests.push(buffer.byteLength);
                      return target.read(buffer.subarray(0, 5));
                    };
                  }
                  return Reflect.get(target, key, target);
                },
              });
            }),
        });
        const { manager, logsDir } = yield* createManager(5, { historyByteLimit: 15 }).pipe(
          Effect.provideService(FileSystem.FileSystem, trackedFileSystem),
        );
        const nextPath = yield* historyLogPath(logsDir);
        sourcePath = source === "current" ? nextPath : path.join(logsDir, "thread-1.log");
        yield* fs.writeFileString(sourcePath, "old".repeat(32_768) + "😀\uFEFFnewest\ré");

        const snapshot = yield* manager.open(openInput());
        expect(snapshot.history).toBe("\uFEFFnewest\ré");
        expect(readRequests).toEqual([15, 10, 5]);
        expect(closedReads).toBe(1);
        expect(Buffer.from(yield* fs.readFile(nextPath)).toString()).toBe("\uFEFFnewest\ré");
        if (source === "legacy") expect(yield* fs.exists(sourcePath)).toBe(false);
        yield* manager.close({ threadId: "thread-1" });
        expect((yield* manager.open(openInput())).history).toBe("\uFEFFnewest\ré");
      }),
  );

  it.effect("flushes pending terminal output before reading persisted history", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter, getEvents } = yield* createManager();
      yield* manager.open(openInput());
      const process = ptyAdapter.processes[0];
      expect(process).toBeDefined();
      if (!process) return;

      process.emitData("fresh output\n");
      yield* waitFor(
        Effect.map(getEvents, (events) =>
          events.some((event) => event.type === "output" && event.data === "fresh output\n"),
        ),
      );

      assert.equal(
        yield* manager.history({ threadId: "thread-1", terminalId: DEFAULT_TERMINAL_ID }),
        "fresh output\n",
      );
    }),
  );

  it.effect("strips replay-unsafe terminal query and reply sequences from persisted history", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter } = yield* createManager();
      yield* manager.open(openInput());
      const process = ptyAdapter.processes[0];
      expect(process).toBeDefined();
      if (!process) return;

      process.emitData("prompt ");
      process.emitData("\u001b[32mok\u001b[0m ");
      process.emitData("\u001b]11;rgb:ffff/ffff/ffff\u0007");
      process.emitData("\u001b]777;T3ActionEvent;run-1;token;payload\u0007");
      process.emitData("\u001b[1;1R");
      process.emitData("done\n");

      yield* manager.close({ threadId: "thread-1" });

      const reopened = yield* manager.open(openInput());
      assert.equal(reopened.history, "prompt \u001b[32mok\u001b[0m done\n");
    }),
  );

  it.effect("strips replayable CSI and DCS traffic while preserving setters", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter } = yield* createManager();
      yield* manager.open(openInput());
      const process = ptyAdapter.processes[0];
      expect(process).toBeDefined();
      if (!process) return;

      process.emitData("prompt ");
      // DECRQM/DECRPM, XTVERSION, and kitty-keyboard CSI query/reply traffic.
      process.emitData("\u001b[?2026$p\u001b[?2026;2$y\u001b[>q\u001b[?u\u001b[?31u");
      // DECRQSS and XTGETTCAP query/reply traffic in 7-bit DCS form.
      process.emitData("\u001bP$q m\u001b\\\u001bP1$r0m\u001b\\");
      process.emitData("\u001bP+q544e\u001b\\\u001bP1+r544e=1b\u001b\\");
      // The same DCS traffic in 8-bit form.
      process.emitData("\u0090$q m\u009c\u00901$r0m\u009c");
      process.emitData("\u0090+q544e\u009c\u00901+r544e=1b\u009c");
      // Setters and cursor movement share final bytes with query families but
      // have visible terminal-state value and must survive replay.
      process.emitData('\u001b[!p\u001b["p\u001b[4 q\u001b[u');
      process.emitData("done\n");

      yield* manager.close({ threadId: "thread-1" });

      const reopened = yield* manager.open(openInput());
      assert.equal(reopened.history, 'prompt \u001b[!p\u001b["p\u001b[4 q\u001b[udone\n');
    }),
  );

  it.effect("handles CSI and DCS query sequences split across output chunks", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter } = yield* createManager();
      yield* manager.open(openInput());
      const process = ptyAdapter.processes[0];
      expect(process).toBeDefined();
      if (!process) return;

      process.emitData("before ");
      process.emitData("\u001b[?2026$");
      process.emitData("pafter ");
      process.emitData("\u001bP$q ");
      process.emitData("m\u001b");
      process.emitData("\\after ");
      process.emitData("\u009b?3");
      process.emitData("1uafter ");
      process.emitData("\u0090+q544e");
      process.emitData("\u009cafter\n");

      yield* manager.close({ threadId: "thread-1" });

      const reopened = yield* manager.open(openInput());
      assert.equal(reopened.history, "before after after after after\n");
    }),
  );

  it.effect(
    "preserves clear and style control sequences while dropping chunk-split query traffic",
    () =>
      Effect.gen(function* () {
        const { manager, ptyAdapter } = yield* createManager();
        yield* manager.open(openInput());
        const process = ptyAdapter.processes[0];
        expect(process).toBeDefined();
        if (!process) return;

        process.emitData("before clear\n");
        process.emitData("\u001b[H\u001b[2J");
        process.emitData("prompt ");
        process.emitData("\u001b]11;");
        process.emitData("rgb:ffff/ffff/ffff\u0007\u001b[1;1");
        process.emitData("R\u001b[36mdone\u001b[0m\n");

        yield* manager.close({ threadId: "thread-1" });

        const reopened = yield* manager.open(openInput());
        assert.equal(
          reopened.history,
          "before clear\n\u001b[H\u001b[2Jprompt \u001b[36mdone\u001b[0m\n",
        );
      }),
  );

  it.effect("does not leak final bytes from ESC sequences with intermediate bytes", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter } = yield* createManager();
      yield* manager.open(openInput());
      const process = ptyAdapter.processes[0];
      expect(process).toBeDefined();
      if (!process) return;

      process.emitData("before ");
      process.emitData("\u001b(B");
      process.emitData("after\n");

      yield* manager.close({ threadId: "thread-1" });

      const reopened = yield* manager.open(openInput());
      assert.equal(reopened.history, "before \u001b(Bafter\n");
    }),
  );

  it.effect(
    "preserves chunk-split ESC sequences with intermediate bytes without leaking final bytes",
    () =>
      Effect.gen(function* () {
        const { manager, ptyAdapter } = yield* createManager();
        yield* manager.open(openInput());
        const process = ptyAdapter.processes[0];
        expect(process).toBeDefined();
        if (!process) return;

        process.emitData("before ");
        process.emitData("\u001b(");
        process.emitData("Bafter\n");

        yield* manager.close({ threadId: "thread-1" });

        const reopened = yield* manager.open(openInput());
        assert.equal(reopened.history, "before \u001b(Bafter\n");
      }),
  );

  it.effect("deletes history file when close(deleteHistory=true)", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter, logsDir } = yield* createManager();
      yield* manager.open(openInput());
      const process = ptyAdapter.processes[0];
      expect(process).toBeDefined();
      if (!process) return;
      process.emitData("bye\n");
      const path = yield* Path.Path;
      yield* waitFor(
        historyLogPath(logsDir).pipe(
          Effect.provideService(Path.Path, path),
          Effect.flatMap(pathExists),
        ),
      );

      yield* manager.close({ threadId: "thread-1", deleteHistory: true });
      expect(
        yield* historyLogPath(logsDir).pipe(
          Effect.provideService(Path.Path, path),
          Effect.flatMap(pathExists),
        ),
      ).toBe(false);
    }),
  );

  it.effect("closes all terminals for a thread when close omits terminalId", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter, logsDir } = yield* createManager();
      yield* manager.open(openInput({ terminalId: "default" }));
      yield* manager.open(openInput({ terminalId: "sidecar" }));
      const defaultProcess = ptyAdapter.processes[0];
      const sidecarProcess = ptyAdapter.processes[1];
      expect(defaultProcess).toBeDefined();
      expect(sidecarProcess).toBeDefined();
      if (!defaultProcess || !sidecarProcess) return;

      defaultProcess.emitData("default\n");
      sidecarProcess.emitData("sidecar\n");
      const path = yield* Path.Path;
      yield* waitFor(
        multiTerminalHistoryLogPath(logsDir, "thread-1", "default").pipe(
          Effect.provideService(Path.Path, path),
          Effect.flatMap(pathExists),
        ),
      );
      yield* waitFor(
        multiTerminalHistoryLogPath(logsDir, "thread-1", "sidecar").pipe(
          Effect.provideService(Path.Path, path),
          Effect.flatMap(pathExists),
        ),
      );

      yield* manager.close({ threadId: "thread-1", deleteHistory: true });

      assert.equal(defaultProcess.killed, true);
      assert.equal(sidecarProcess.killed, true);
      expect(
        yield* multiTerminalHistoryLogPath(logsDir, "thread-1", "default").pipe(
          Effect.provideService(Path.Path, path),
          Effect.flatMap(pathExists),
        ),
      ).toBe(false);
      expect(
        yield* multiTerminalHistoryLogPath(logsDir, "thread-1", "sidecar").pipe(
          Effect.provideService(Path.Path, path),
          Effect.flatMap(pathExists),
        ),
      ).toBe(false);
    }),
  );

  it.effect("archives a thread without deleting retained preview history", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter, logsDir } = yield* createManager();
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const retainedHistoryPath = yield* multiTerminalHistoryLogPath(
        logsDir,
        "thread-1",
        "preview-orphan",
      );
      const ordinaryOrphanHistoryPath = yield* multiTerminalHistoryLogPath(
        logsDir,
        "thread-1",
        "shell-orphan",
      );
      const defaultHistoryPath = yield* multiTerminalHistoryLogPath(logsDir, "thread-1");
      const legacyHistoryPath = path.join(logsDir, "thread-1.log");
      const otherThreadHistoryPath = yield* multiTerminalHistoryLogPath(
        logsDir,
        "thread-2",
        "other-terminal",
      );
      yield* fs.writeFileString(retainedHistoryPath, "keep orphan preview output");
      yield* fs.writeFileString(ordinaryOrphanHistoryPath, "remove orphan shell output");
      yield* fs.writeFileString(defaultHistoryPath, "remove default output");
      yield* fs.writeFileString(legacyHistoryPath, "remove legacy default output");
      yield* fs.writeFileString(otherThreadHistoryPath, "keep other thread output");

      const livePreviewHistoryPath = yield* multiTerminalHistoryLogPath(
        logsDir,
        "thread-1",
        "preview-live",
      );
      yield* fs.writeFileString(livePreviewHistoryPath, "keep live preview output\n");
      yield* manager.open(openInput({ terminalId: "preview-live" }));
      yield* manager.open(openInput({ terminalId: "shell-live" }));
      const livePreviewProcess = ptyAdapter.processes[0];
      const liveShellProcess = ptyAdapter.processes[1];
      expect(livePreviewProcess).toBeDefined();
      expect(liveShellProcess).toBeDefined();
      if (!livePreviewProcess || !liveShellProcess) return;
      yield* manager.closeThreadExcept("thread-1", ["preview-live", "preview-orphan"]);

      assert.equal(livePreviewProcess.killed, false);
      assert.equal(liveShellProcess.killed, true);
      assert.equal(yield* fs.exists(retainedHistoryPath), true);
      assert.equal(yield* fs.exists(ordinaryOrphanHistoryPath), false);
      assert.equal(yield* fs.exists(defaultHistoryPath), false);
      assert.equal(yield* fs.exists(legacyHistoryPath), false);
      assert.equal(yield* fs.exists(otherThreadHistoryPath), true);
      assert.equal(yield* fs.exists(livePreviewHistoryPath), true);
    }),
  );

  it.effect(
    "archives ordinary terminals while conservatively retaining unknown preview ownership",
    () =>
      Effect.gen(function* () {
        const { manager, ptyAdapter, logsDir } = yield* createManager();
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const retainedHistoryPath = yield* multiTerminalHistoryLogPath(
          logsDir,
          "thread-1",
          "preview-orphan",
        );
        const ordinaryOrphanHistoryPath = yield* multiTerminalHistoryLogPath(
          logsDir,
          "thread-1",
          "shell-orphan",
        );
        const defaultHistoryPath = yield* multiTerminalHistoryLogPath(logsDir, "thread-1");
        const legacyHistoryPath = path.join(logsDir, "thread-1.log");
        const otherThreadHistoryPath = yield* multiTerminalHistoryLogPath(
          logsDir,
          "thread-2",
          "other-terminal",
        );
        yield* fs.writeFileString(retainedHistoryPath, "keep orphan preview output");
        yield* fs.writeFileString(ordinaryOrphanHistoryPath, "remove orphan shell output");
        yield* fs.writeFileString(defaultHistoryPath, "remove default output");
        yield* fs.writeFileString(legacyHistoryPath, "remove legacy default output");
        yield* fs.writeFileString(otherThreadHistoryPath, "keep other thread output");

        const livePreviewHistoryPath = yield* multiTerminalHistoryLogPath(
          logsDir,
          "thread-1",
          "preview-live",
        );
        yield* fs.writeFileString(livePreviewHistoryPath, "keep live preview output\n");
        yield* manager.open(openInput({ terminalId: "preview-live" }));
        yield* manager.open(openInput({ terminalId: "shell-live" }));
        const livePreviewProcess = ptyAdapter.processes[0];
        const liveShellProcess = ptyAdapter.processes[1];
        expect(livePreviewProcess).toBeDefined();
        expect(liveShellProcess).toBeDefined();
        if (!livePreviewProcess || !liveShellProcess) return;
        yield* manager.closeThreadExcept("thread-1", [], ["preview-"]);

        assert.equal(livePreviewProcess.killed, false);
        assert.equal(liveShellProcess.killed, true);
        assert.equal(yield* fs.exists(retainedHistoryPath), true);
        assert.equal(yield* fs.exists(ordinaryOrphanHistoryPath), false);
        assert.equal(yield* fs.exists(defaultHistoryPath), false);
        assert.equal(yield* fs.exists(legacyHistoryPath), false);
        assert.equal(yield* fs.exists(otherThreadHistoryPath), true);
        assert.equal(yield* fs.exists(livePreviewHistoryPath), true);
      }),
  );

  it.effect("escalates terminal shutdown to SIGKILL when process does not exit in time", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter } = yield* createManager(5, { processKillGraceMs: 10 });
      yield* manager.open(openInput());
      const process = ptyAdapter.processes[0];
      expect(process).toBeDefined();
      if (!process) return;

      const closeFiber = yield* manager.close({ threadId: "thread-1" }).pipe(Effect.forkScoped);
      yield* Effect.yieldNow;
      yield* TestClock.adjust("10 millis");
      yield* Fiber.join(closeFiber);

      assert.equal(process.killSignals[0], "SIGTERM");
      expect(process.killSignals).toContain("SIGKILL");
    }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("keeps a closing terminal in blocker metadata until kill escalation finishes", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter } = yield* createManager(5, { processKillGraceMs: 10 });
      yield* manager.open(openInput());

      const closeFiber = yield* manager.close({ threadId: "thread-1" }).pipe(Effect.forkScoped);
      yield* Effect.yieldNow;

      expect(yield* manager.refreshMetadata).toEqual([
        expect.objectContaining({
          threadId: "thread-1",
          terminalId: DEFAULT_TERMINAL_ID,
          status: "running",
          hasRunningSubprocess: true,
        }),
      ]);
      expect(yield* manager.metadata).toEqual(yield* manager.refreshMetadata);
      yield* manager.close({ threadId: "thread-1" });
      expect(ptyAdapter.processes[0]?.killSignals).toEqual(["SIGTERM"]);

      yield* TestClock.adjust("10 millis");
      yield* Fiber.join(closeFiber);
      yield* Effect.yieldNow;

      expect(yield* manager.metadata).toEqual([]);
      expect(yield* manager.refreshMetadata).toEqual([]);
    }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("accepts an exit replayed while detaching a terminal without sending signals", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter } = yield* createManager(5, { processKillGraceMs: 0 });
      yield* manager.open(openInput());
      const process = ptyAdapter.processes[0]!;
      process.exitOnSubscribe = { exitCode: 0, signal: null };

      yield* manager.shutdownThread("thread-1");

      expect(process.killSignals).toEqual([]);
      expect(process.exitListenerCount).toBe(0);
      expect(yield* manager.metadata).toEqual([]);
    }),
  );

  it.effect.each(["SIGTERM", "SIGKILL"])(
    "accepts synchronous %s exit confirmation and releases its subscription",
    (signal) =>
      Effect.gen(function* () {
        const { manager, ptyAdapter } = yield* createManager(5, { processKillGraceMs: 0 });
        yield* manager.open(openInput());
        const process = ptyAdapter.processes[0]!;
        process.exitOnKill = signal;

        yield* manager.shutdownThread("thread-1");

        expect(process.killSignals).toEqual(
          signal === "SIGTERM" ? ["SIGTERM"] : ["SIGTERM", "SIGKILL"],
        );
        expect(process.exitListenerCount).toBe(0);
        expect(yield* manager.metadata).toEqual([]);
      }),
  );

  it.effect("holds shutdown until delayed SIGKILL exit while keeping other threads usable", () =>
    Effect.gen(function* () {
      const forceKillSent = yield* Deferred.make<void>();
      const { manager, ptyAdapter } = yield* createManager(5, {
        processKillGraceMs: 0,
        processExitWaitMs: 100,
      });
      yield* manager.open(openInput());
      const process = ptyAdapter.processes[0]!;
      process.exitOnKill = undefined;
      process.onKill = (signal) => {
        if (signal === "SIGKILL") Deferred.doneUnsafe(forceKillSent, Effect.void);
      };
      const stopping = yield* manager.shutdownThread("thread-1").pipe(Effect.forkScoped);
      yield* Deferred.await(forceKillSent);
      expect(process.killSignals).toEqual(["SIGTERM", "SIGKILL"]);
      expect(process.exitListenerCount).toBe(1);
      const opening = yield* manager
        .open(openInput({ terminalId: "new-terminal" }))
        .pipe(Effect.forkScoped);
      const restarting = yield* manager.restart(restartInput()).pipe(Effect.forkScoped);
      yield* manager.open(openInput({ threadId: "thread-2" }));

      expect(stopping.pollUnsafe()).toBeUndefined();
      expect(opening.pollUnsafe()).toBeUndefined();
      expect(restarting.pollUnsafe()).toBeUndefined();
      expect(process.killSignals).toEqual(["SIGTERM", "SIGKILL"]);
      expect(ptyAdapter.processes).toHaveLength(2);
      expect(ptyAdapter.processes[1]?.killSignals).toEqual([]);
      expect(yield* manager.metadata).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ threadId: "thread-1", pid: process.pid, status: "running" }),
          expect.objectContaining({ threadId: "thread-2", status: "running" }),
        ]),
      );

      process.emitExit({ exitCode: 0, signal: 9 });
      yield* Fiber.join(stopping);
      yield* Fiber.join(opening);
      yield* Fiber.join(restarting);
      expect(process.exitListenerCount).toBe(0);
      expect(ptyAdapter.processes[1]?.killSignals).toEqual([]);
      yield* manager.shutdownThread("thread-1");
      yield* manager.shutdownThread("thread-2");
    }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("times out unconfirmed exit and retries only the selected retained process", () =>
    Effect.gen(function* () {
      const forceKillSent = yield* Deferred.make<void>();
      const { manager, ptyAdapter } = yield* createManager(5, {
        processKillGraceMs: 0,
        processExitWaitMs: 10,
      });
      yield* manager.open(openInput());
      yield* manager.open(openInput({ threadId: "thread-2" }));
      const original = (yield* manager.metadata).find(
        (terminal) => terminal.threadId === "thread-1",
      );
      const process = ptyAdapter.processes[0]!;
      process.exitOnKill = undefined;
      process.onKill = (signal) => {
        if (signal === "SIGKILL") Deferred.doneUnsafe(forceKillSent, Effect.void);
      };
      const stopping = yield* manager
        .shutdownThread("thread-1")
        .pipe(Effect.result, Effect.forkScoped);
      yield* Deferred.await(forceKillSent);
      expect(stopping.pollUnsafe()).toBeUndefined();

      yield* TestClock.adjust("10 millis");
      const result = yield* Fiber.join(stopping);
      expect(result._tag).toBe("Failure");
      if (result._tag === "Failure") {
        expect(result.failure._tag).toBe("TerminalShutdownError");
        if (result.failure._tag === "TerminalShutdownError") {
          expect(result.failure.terminalIds).toEqual([DEFAULT_TERMINAL_ID]);
        }
      }
      expect(process.exitListenerCount).toBe(1);
      expect(yield* manager.metadata).toContainEqual(
        expect.objectContaining({
          threadId: "thread-1",
          pid: process.pid,
          cwd: original?.cwd,
          label: original?.label,
          status: "running",
          hasRunningSubprocess: true,
        }),
      );

      process.exitOnKill = "SIGKILL";
      yield* manager.shutdownThread("thread-1");

      expect(process.killSignals).toEqual(["SIGTERM", "SIGKILL", "SIGTERM", "SIGKILL"]);
      expect(process.exitListenerCount).toBe(0);
      expect(ptyAdapter.processes[1]?.killSignals).toEqual([]);
      expect(yield* manager.metadata).toEqual([
        expect.objectContaining({ threadId: "thread-2", status: "running" }),
      ]);
      yield* manager.shutdownThread("thread-2");
    }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect(
    "removes retained metadata when actual exit arrives after the confirmation timeout",
    () =>
      Effect.gen(function* () {
        const forceKillSent = yield* Deferred.make<void>();
        const removed = yield* Deferred.make<void>();
        const { manager, ptyAdapter } = yield* createManager(5, {
          processKillGraceMs: 0,
          processExitWaitMs: 10,
        });
        yield* manager.open(openInput());
        const process = ptyAdapter.processes[0]!;
        process.exitOnKill = undefined;
        process.onKill = (signal) => {
          if (signal === "SIGKILL") Deferred.doneUnsafe(forceKillSent, Effect.void);
        };
        const unsubscribe = yield* manager.subscribeMetadata((event) =>
          event.type === "remove"
            ? Deferred.succeed(removed, undefined).pipe(Effect.asVoid)
            : Effect.void,
        );
        yield* Effect.addFinalizer(() => Effect.sync(unsubscribe));
        const stopping = yield* manager
          .shutdownThread("thread-1")
          .pipe(Effect.result, Effect.forkScoped);
        yield* Deferred.await(forceKillSent);
        yield* TestClock.adjust("10 millis");
        expect((yield* Fiber.join(stopping))._tag).toBe("Failure");
        expect(yield* manager.metadata).toHaveLength(1);
        expect(process.exitListenerCount).toBe(1);

        process.emitExit({ exitCode: 0, signal: 9 });
        yield* Deferred.await(removed);
        yield* manager.waitForThreadShutdown("thread-1");

        expect(yield* manager.metadata).toEqual([]);
        expect(process.killSignals).toEqual(["SIGTERM", "SIGKILL"]);
        expect(process.exitListenerCount).toBe(0);
      }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("releases a retained exit subscription when the manager scope closes", () =>
    Effect.gen(function* () {
      const ptyAdapter = new FakePtyAdapter();
      yield* Effect.scoped(
        Effect.gen(function* () {
          const { manager } = yield* createManager(5, { ptyAdapter });
          yield* manager.open(openInput());
          ptyAdapter.processes[0]!.killFailure = new Error("signal failure");
          expect((yield* manager.shutdownThread("thread-1").pipe(Effect.result))._tag).toBe(
            "Failure",
          );
          expect(ptyAdapter.processes[0]?.exitListenerCount).toBe(1);
        }),
      );
      expect(ptyAdapter.processes[0]?.exitListenerCount).toBe(0);
    }),
  );

  it.effect("keeps a closing terminal blocked when process signaling fails", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter } = yield* createManager();
      yield* manager.open(openInput());
      const original = (yield* manager.metadata)[0];
      const metadataEvents = yield* Ref.make<ReadonlyArray<TerminalMetadataStreamEvent>>([]);
      const unsubscribe = yield* manager.subscribeMetadata((event) =>
        Ref.update(metadataEvents, (events) => [...events, event]),
      );
      yield* Effect.addFinalizer(() => Effect.sync(unsubscribe));
      const process = ptyAdapter.processes[0];
      expect(process).toBeDefined();
      if (!process) return;
      process.killFailure = new Error("simulated signal failure");

      yield* manager.close({ threadId: "thread-1" });

      expect(process.killSignals).toEqual(["SIGTERM"]);
      const metadata = yield* manager.metadata;
      expect(metadata).toEqual([
        expect.objectContaining({
          threadId: "thread-1",
          terminalId: DEFAULT_TERMINAL_ID,
          status: "running",
          hasRunningSubprocess: true,
          pid: process.pid,
          cwd: original?.cwd,
          worktreePath: original?.worktreePath,
          label: original?.label,
        }),
      ]);
      expect((yield* Ref.get(metadataEvents)).at(-1)).toEqual({
        type: "upsert",
        terminal: metadata[0],
      });
      const snapshots: TerminalMetadataStreamEvent[] = [];
      const unsubscribeSnapshot = yield* manager.subscribeMetadata((event) =>
        Effect.sync(() => {
          snapshots.push(event);
        }),
      );
      unsubscribeSnapshot();
      expect(snapshots).toEqual([{ type: "snapshot", terminals: metadata }]);
      expect(yield* manager.refreshMetadata).toEqual([
        expect.objectContaining({
          threadId: "thread-1",
          terminalId: DEFAULT_TERMINAL_ID,
          status: "running",
          hasRunningSubprocess: true,
        }),
      ]);
    }),
  );

  it.effect("retries only failed handles for the selected thread without duplicating cleanup", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter } = yield* createManager(5, { processKillGraceMs: 0 });
      yield* manager.open(openInput());
      yield* manager.open(openInput({ threadId: "thread-2" }));
      const first = ptyAdapter.processes[0]!;
      const second = ptyAdapter.processes[1]!;
      first.killFailure = new Error("simulated signal failure");
      second.killFailure = new Error("another thread's signal failure");
      yield* manager.close({ threadId: "thread-1" });
      yield* manager.close({ threadId: "thread-2" });
      expect((yield* manager.waitForThreadShutdown("thread-1").pipe(Effect.result))._tag).toBe(
        "Failure",
      );
      expect((yield* manager.waitForThreadShutdown("thread-2").pipe(Effect.result))._tag).toBe(
        "Failure",
      );

      first.killFailure = undefined;
      yield* manager.close({ threadId: "thread-1" });
      yield* manager.close({ threadId: "thread-1" });
      yield* manager.waitForThreadShutdown("thread-1");

      expect(first.killSignals).toEqual(["SIGTERM", "SIGTERM", "SIGKILL"]);
      expect(second.killSignals).toEqual(["SIGTERM"]);
      expect(yield* manager.metadata).toEqual([
        expect.objectContaining({ threadId: "thread-2", hasRunningSubprocess: true }),
      ]);
    }),
  );

  it.effect("delivers successful cleanup after an in-flight retained metadata update", () =>
    Effect.gen(function* () {
      const { manager } = yield* createManager(5, { processKillGraceMs: 10 });
      yield* manager.open(openInput());
      const upsertStarted = yield* Deferred.make<void>();
      const releaseUpsert = yield* Deferred.make<void>();
      const removed = yield* Deferred.make<void>();
      const events: TerminalMetadataStreamEvent[] = [];
      const unsubscribe = yield* manager.subscribeMetadata((event) =>
        Effect.gen(function* () {
          if (event.type === "upsert") {
            yield* Deferred.succeed(upsertStarted, undefined);
            yield* Deferred.await(releaseUpsert);
          }
          events.push(event);
          if (event.type === "remove") yield* Deferred.succeed(removed, undefined);
        }),
      );
      yield* Effect.addFinalizer(() => Effect.sync(unsubscribe));
      const closing = yield* manager.close({ threadId: "thread-1" }).pipe(Effect.forkScoped);
      yield* Deferred.await(upsertStarted);
      yield* TestClock.adjust("10 millis");
      expect(yield* manager.metadata).toEqual([]);
      yield* Deferred.succeed(releaseUpsert, undefined);
      yield* Fiber.join(closing);
      yield* manager.waitForThreadShutdown("thread-1");
      yield* Deferred.await(removed);

      expect(events.map((event) => event.type)).toEqual(["snapshot", "upsert", "remove"]);
      expect(events.at(-1)).toEqual({
        type: "remove",
        threadId: "thread-1",
        terminalId: DEFAULT_TERMINAL_ID,
      });
    }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("keeps opens and restarts outside the selected thread's shutdown interval", () =>
    Effect.gen(function* () {
      const cleanupStarted = yield* Deferred.make<void>();
      const finishCleanup = yield* Deferred.make<void>();
      let blockCleanup = true;
      const { manager, ptyAdapter } = yield* createManager(5, {
        processKillGraceMs: 0,
        unregisterTerminal: (terminal) =>
          terminal.threadId === "thread-1" && blockCleanup
            ? Deferred.succeed(cleanupStarted, undefined).pipe(
                Effect.andThen(Deferred.await(finishCleanup)),
              )
            : Effect.void,
      });
      yield* manager.open(openInput());
      const stopping = yield* manager.shutdownThread("thread-1").pipe(Effect.forkScoped);
      yield* Deferred.await(cleanupStarted);
      const opening = yield* manager
        .open(openInput({ terminalId: "new-terminal" }))
        .pipe(Effect.forkScoped);
      const restarting = yield* manager.restart(restartInput()).pipe(Effect.forkScoped);

      yield* manager.open(openInput({ threadId: "thread-2" }));
      expect(stopping.pollUnsafe()).toBeUndefined();
      expect(opening.pollUnsafe()).toBeUndefined();
      expect(restarting.pollUnsafe()).toBeUndefined();
      expect(ptyAdapter.processes).toHaveLength(2);
      expect(ptyAdapter.processes[0]?.killSignals).toEqual([]);
      expect(ptyAdapter.processes[1]?.killSignals).toEqual([]);

      blockCleanup = false;
      yield* Deferred.succeed(finishCleanup, undefined);
      yield* Fiber.join(stopping);
      yield* Fiber.join(opening);
      yield* Fiber.join(restarting);
      expect(ptyAdapter.processes[0]?.killSignals).toEqual(["SIGTERM", "SIGKILL"]);
      expect(ptyAdapter.processes[1]?.killSignals).toEqual([]);
      expect(ptyAdapter.processes).toHaveLength(4);
      yield* manager.shutdownThread("thread-1");
      yield* manager.shutdownThread("thread-2");
    }),
  );

  it.effect("waits for the selected thread's cleanup without waiting for another thread", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter } = yield* createManager(5, { processKillGraceMs: 10 });
      yield* manager.open(openInput());
      yield* manager.open(openInput({ threadId: "thread-2" }));
      yield* manager.close({ threadId: "thread-1" });
      expect(ptyAdapter.processes[0]?.killSignals).toEqual(["SIGTERM"]);

      const waiting = yield* manager.waitForThreadShutdown("thread-1").pipe(Effect.forkScoped);
      yield* TestClock.adjust("5 millis");
      expect(waiting.pollUnsafe()).toBeUndefined();
      yield* manager.close({ threadId: "thread-2" });
      yield* TestClock.adjust("5 millis");
      yield* Fiber.join(waiting);

      expect(ptyAdapter.processes[0]?.killSignals).toEqual(["SIGTERM", "SIGKILL"]);
      expect(ptyAdapter.processes[1]?.killSignals).toEqual(["SIGTERM"]);
      expect(yield* manager.refreshMetadata).toEqual([
        expect.objectContaining({ threadId: "thread-2" }),
      ]);
      yield* TestClock.adjust("5 millis");
      yield* manager.waitForThreadShutdown("thread-2");
    }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("reports failed termination after the asynchronous close has returned", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter } = yield* createManager();
      yield* manager.open(openInput());
      const process = ptyAdapter.processes[0]!;
      process.killFailure = new Error("simulated signal failure");
      yield* manager.close({ threadId: "thread-1" });

      const result = yield* manager.waitForThreadShutdown("thread-1").pipe(Effect.result);
      assert.equal(result._tag, "Failure");
      if (result._tag === "Failure") {
        assert.equal(result.failure._tag, "TerminalShutdownError");
        assert.equal(result.failure.threadId, "thread-1");
        assert.deepEqual(result.failure.terminalIds, [DEFAULT_TERMINAL_ID]);
      }
      yield* manager.waitForThreadShutdown("thread-2");
    }),
  );

  it.effect("publishes closed events when terminals are explicitly closed", () =>
    Effect.gen(function* () {
      const { manager, getEvents } = yield* createManager();
      yield* manager.open(openInput({ terminalId: "default" }));
      yield* manager.open(openInput({ terminalId: "sidecar" }));

      yield* manager.close({
        threadId: "thread-1",
        terminalId: "default",
        deleteHistory: true,
      });
      yield* manager.close({ threadId: "thread-1" });

      const closedEvents = (yield* getEvents).filter(
        (event): event is Extract<TerminalEvent, { type: "closed" }> => event.type === "closed",
      );
      expect(closedEvents.map((event) => event.terminalId).sort()).toEqual(["default", "sidecar"]);
      expect(closedEvents.find((event) => event.terminalId === "default")?.deleteHistory).toBe(
        true,
      );
      expect(closedEvents.find((event) => event.terminalId === "sidecar")?.deleteHistory).toBe(
        false,
      );
    }),
  );

  it.effect("evicts oldest inactive terminal sessions when retention limit is exceeded", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter, logsDir, getEvents } = yield* createManager(5, {
        maxRetainedInactiveSessions: 1,
      });

      yield* manager.open(openInput({ threadId: "thread-1" }));
      yield* manager.open(openInput({ threadId: "thread-2" }));

      const first = ptyAdapter.processes[0];
      const second = ptyAdapter.processes[1];
      expect(first).toBeDefined();
      expect(second).toBeDefined();
      if (!first || !second) return;

      first.emitData("first-history\n");
      second.emitData("second-history\n");
      const path = yield* Path.Path;
      yield* waitFor(
        historyLogPath(logsDir, "thread-1").pipe(
          Effect.provideService(Path.Path, path),
          Effect.flatMap(pathExists),
        ),
      );
      first.emitExit({ exitCode: 0, signal: 0 });
      yield* Effect.sleep(Duration.millis(5));
      second.emitExit({ exitCode: 0, signal: 0 });

      yield* waitFor(
        Effect.map(
          getEvents,
          (events) => events.filter((event) => event.type === "exited").length === 2,
        ),
      );

      const reopenedSecond = yield* manager.open(openInput({ threadId: "thread-2" }));
      const reopenedFirst = yield* manager.open(openInput({ threadId: "thread-1" }));

      assert.equal(reopenedFirst.history, "first-history\n");
      assert.equal(reopenedSecond.history, "");
    }),
  );

  it.effect("migrates legacy transcript filenames to terminal-scoped history path on open", () =>
    Effect.gen(function* () {
      const { manager, logsDir } = yield* createManager();
      const path = yield* Path.Path;
      const legacyPath = path.join(logsDir, "thread-1.log");
      const nextPath = yield* historyLogPath(logsDir);
      yield* writeFileString(legacyPath, "legacy-line\n");

      const snapshot = yield* manager.open(openInput());

      assert.equal(snapshot.history, "legacy-line\n");
      expect(yield* pathExists(nextPath)).toBe(true);
      expect(yield* readFileString(nextPath)).toBe("legacy-line\n");
      expect(yield* pathExists(legacyPath)).toBe(false);
    }),
  );

  it.effect("retries with fallback shells when preferred shell spawn fails", () =>
    Effect.gen(function* () {
      const platform = yield* HostProcessPlatform;
      const missingShell =
        platform === "win32" ? "C:\\definitely\\missing-shell.exe" : "/definitely/missing-shell -l";
      const { manager, ptyAdapter } = yield* createManager(5, {
        shellResolver: () => missingShell,
      });
      ptyAdapter.spawnFailures.push(new Error("posix_spawnp failed."));

      const snapshot = yield* manager.open(openInput());

      assert.equal(snapshot.status, "running");
      expect(ptyAdapter.spawnInputs.length).toBeGreaterThanOrEqual(2);
      expect(ptyAdapter.spawnInputs[0]?.shell).toBe(
        platform === "win32" ? missingShell : "/definitely/missing-shell",
      );

      if (platform === "win32") {
        expect(
          ptyAdapter.spawnInputs.some(
            (input) =>
              input.shell === "pwsh.exe" ||
              input.shell === "powershell.exe" ||
              input.shell === "cmd.exe",
          ),
        ).toBe(true);
      } else {
        expect(
          ptyAdapter.spawnInputs
            .slice(1)
            .some((input) => input.shell !== "/definitely/missing-shell"),
        ).toBe(true);
      }
    }),
  );

  it.effect("prefers PowerShell over ComSpec for Windows terminals", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter } = yield* createManager(5, {
        env: {
          ComSpec: "C:\\Windows\\System32\\cmd.exe",
          PATH: "C:\\Windows\\System32",
          SystemRoot: "C:\\Windows",
        },
      }).pipe(Effect.provide(layerWithHostPlatform("win32")));

      const snapshot = yield* manager.open(openInput());

      expect(ptyAdapter.spawnInputs[0]).toEqual(
        expect.objectContaining({
          shell: "pwsh.exe",
          args: ["-NoLogo"],
        }),
      );
      expect(snapshot.shellFamily).toBe("powershell");
    }),
  );

  it.effect("reports cmd when Windows shell fallback reaches ComSpec", () =>
    Effect.gen(function* () {
      const ptyAdapter = new FakePtyAdapter();
      const { manager } = yield* createManager(5, {
        ptyAdapter,
        shellResolver: () => "C:\\missing\\custom-shell.exe",
        env: {
          ComSpec: "C:\\Windows\\System32\\cmd.exe",
          PATH: "C:\\Windows\\System32",
          SystemRoot: "C:\\Windows",
        },
      }).pipe(Effect.provide(layerWithHostPlatform("win32")));
      ptyAdapter.spawnFailures.push(
        new Error("spawn custom-shell.exe ENOENT"),
        new Error("spawn pwsh.exe ENOENT"),
        new Error("spawn built-in powershell.exe ENOENT"),
        new Error("spawn powershell.exe ENOENT"),
      );

      const snapshot = yield* manager.open(openInput());

      expect(ptyAdapter.spawnInputs.at(-1)?.shell).toBe("C:\\Windows\\System32\\cmd.exe");
      expect(snapshot.shellFamily).toBe("cmd");
    }),
  );

  it.effect("preserves Windows Path casing when appending managed ACP binaries", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const cacheDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-terminal-acp-path-",
      });
      const installBin = path.join(
        cacheDir,
        "tools",
        "example-agent",
        "1.2.3",
        "windows-x86_64",
        "bin",
      );
      yield* fileSystem.makeDirectory(installBin, { recursive: true });
      yield* fileSystem.makeDirectory(path.join(cacheDir, "acp-registry"), { recursive: true });
      yield* fileSystem.writeFileString(
        path.join(cacheDir, "acp-registry", "registry.json"),
        encodeUnknownJson({
          version: "1.0.0",
          agents: [
            {
              id: "example-agent",
              name: "Example Agent",
              version: "1.2.3",
              description: "ACP Registry test agent",
              distribution: {
                binary: {
                  "windows-x86_64": {
                    archive: "https://registry.test/example-agent.zip",
                    cmd: "bin/example-agent.exe",
                  },
                },
              },
            },
          ],
        }),
      );
      const { manager, ptyAdapter } = yield* createManager(5, {
        managedBinaryCacheDir: cacheDir,
        managedBinaryToolsDir: path.join(cacheDir, "tools"),
        env: {
          ComSpec: "C:\\Windows\\System32\\cmd.exe",
          Path: "C:\\Windows\\System32",
          SystemRoot: "C:\\Windows",
        },
      }).pipe(
        Effect.provide(
          Layer.merge(
            layerWithHostPlatform("win32"),
            Layer.succeed(HostProcessArchitecture, "x64"),
          ),
        ),
      );

      yield* manager.open(openInput());

      const spawnEnv = ptyAdapter.spawnInputs[0]?.env;
      expect(spawnEnv?.PATH).toBeUndefined();
      expect(spawnEnv?.Path).toBe(`C:\\Windows\\System32;${installBin}`);
    }),
  );

  it.effect("falls back to built-in PowerShell by absolute path on Windows", () =>
    Effect.gen(function* () {
      const ptyAdapter = new FakePtyAdapter();
      const { manager } = yield* createManager(5, {
        ptyAdapter,
        shellResolver: () => "C:\\missing\\custom-shell.exe",
        env: {
          ComSpec: "C:\\Windows\\System32\\cmd.exe",
          PATH: "C:\\Windows\\System32",
          SystemRoot: "C:\\Windows",
        },
      }).pipe(Effect.provide(layerWithHostPlatform("win32")));
      ptyAdapter.spawnFailures.push(
        new Error("spawn custom-shell.exe ENOENT"),
        new Error("spawn pwsh.exe ENOENT"),
      );

      yield* manager.open(openInput());

      expect(ptyAdapter.spawnInputs.map((input) => input.shell)).toEqual([
        "C:\\missing\\custom-shell.exe",
        "pwsh.exe",
        "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
      ]);
      expect(ptyAdapter.spawnInputs[1]?.args).toEqual(["-NoLogo"]);
      expect(ptyAdapter.spawnInputs[2]?.args).toEqual(["-NoLogo"]);
    }),
  );

  it.effect.each(["linux", "darwin", "win32"] as const)(
    "advertises truecolor before the PTY backend on %s without replacing explicit values",
    (platform) =>
      Effect.gen(function* () {
        for (const [parentColor, runtimeColor, expected] of [
          [undefined, undefined, "truecolor"],
          ["", undefined, "truecolor"],
          ["24bit", undefined, "24bit"],
          ["24bit", "", ""],
          [undefined, "", ""],
          ["24bit", "custom", "custom"],
        ] as const) {
          const env = Object.freeze({ COLORTERM: parentColor });
          const { manager, ptyAdapter } = yield* createManager(5, {
            shellResolver: () => "/bin/sh",
            env,
          }).pipe(Effect.provide(layerWithHostPlatform(platform)));
          yield* manager.open(
            openInput({ env: runtimeColor === undefined ? {} : { COLORTERM: runtimeColor } }),
          );
          expect(ptyAdapter.spawnInputs[0]?.env.COLORTERM).toBe(expected);
          expect(env.COLORTERM).toBe(parentColor);
        }
      }),
  );

  it.effect("binds action terminals to the server settings path over shell overrides", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter } = yield* createManager(5, {
        env: { T3CODE_LOCAL_CI_SETTINGS_PATH: "/inherited/settings.json" },
        localCiSettingsPath: "/server/custom-state/settings.json",
      });
      yield* manager.open(
        openInput({
          env: { T3CODE_LOCAL_CI_SETTINGS_PATH: "/client/settings.json" },
        }),
      );
      expect(ptyAdapter.spawnInputs[0]?.env.T3CODE_LOCAL_CI_SETTINGS_PATH).toBe(
        "/server/custom-state/settings.json",
      );
    }),
  );

  it.effect("filters app runtime env variables from terminal sessions", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter } = yield* createManager(5, {
        env: {
          PORT: "5173",
          T3CODE_PORT: "3773",
          VITE_DEV_SERVER_URL: "http://localhost:5173",
          TEST_TERMINAL_KEEP: "keep-me",
        },
      });
      yield* manager.open(openInput());
      const spawnInput = ptyAdapter.spawnInputs[0];
      expect(spawnInput).toBeDefined();
      if (!spawnInput) return;

      expect(spawnInput.env.PORT).toBeUndefined();
      expect(spawnInput.env.T3CODE_PORT).toBeUndefined();
      expect(spawnInput.env.VITE_DEV_SERVER_URL).toBeUndefined();
      // Arbitrary host env vars must pass through — terminals inherit the
      // user's environment apart from the explicit blocklist.
      expect(spawnInput.env.TEST_TERMINAL_KEEP).toBe("keep-me");
    }),
  );

  it.effect("expands provider home paths passed to setup terminals", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter } = yield* createManager(5);

      yield* manager.open({
        ...openInput(),
        env: {
          CODEX_HOME: "~/.codex-work",
          CLAUDE_CONFIG_DIR: "~/.claude-work",
          CUSTOM_ACCOUNT: "~/leave-this-value-alone",
        },
      });

      const environment = ptyAdapter.spawnInputs[0]?.env;
      expect(environment?.CODEX_HOME).toMatch(/[\\/][.]codex-work$/);
      expect(environment?.CLAUDE_CONFIG_DIR).toMatch(/[\\/][.]claude-work$/);
      expect(environment?.CUSTOM_ACCOUNT).toBe("~/leave-this-value-alone");
    }),
  );

  it.effect("strips AppImage runtime env from terminal sessions", () =>
    Effect.gen(function* () {
      const appDir = "/tmp/.mount_T3Codeabc123";
      const { manager, ptyAdapter } = yield* createManager(5, {
        env: {
          APPIMAGE: "/home/user/T3-Code.AppImage",
          APPDIR: appDir,
          ARGV0: "/home/user/T3-Code.AppImage",
          OWD: "/home/user/project",
          PATH: `${appDir}/usr/bin:${appDir}:/usr/local/bin:/usr/bin:/bin`,
          LD_LIBRARY_PATH: `${appDir}/usr/lib:/home/user/.local/lib`,
          XDG_DATA_DIRS: `${appDir}/usr/share:/usr/local/share:/usr/share`,
          GSETTINGS_SCHEMA_DIR: `${appDir}/usr/share/glib-2.0/schemas`,
          TEST_TERMINAL_KEEP: "keep-me",
        },
      });
      yield* manager.open(openInput());
      const spawnInput = ptyAdapter.spawnInputs[0];
      expect(spawnInput).toBeDefined();
      if (!spawnInput) return;

      // AppImage runtime markers must never reach the PTY — tools inside the
      // terminal otherwise resolve against the AppImage mount (e.g. PHP_BINARY
      // reporting the AppImage path instead of the real binary).
      expect(spawnInput.env.APPIMAGE).toBeUndefined();
      expect(spawnInput.env.APPDIR).toBeUndefined();
      expect(spawnInput.env.ARGV0).toBeUndefined();
      expect(spawnInput.env.OWD).toBeUndefined();
      // PATH/LD_LIBRARY_PATH keep the user's real entries but drop the AppImage
      // mount segments that the runtime prepended.
      expect(spawnInput.env.PATH).toBe("/usr/local/bin:/usr/bin:/bin");
      expect(spawnInput.env.LD_LIBRARY_PATH).toBe("/home/user/.local/lib");
      // XDG_DATA_DIRS keeps the host entries but drops the AppImage share dir.
      expect(spawnInput.env.XDG_DATA_DIRS).toBe("/usr/local/share:/usr/share");
      // GSETTINGS_SCHEMA_DIR pointed only at the mount, so it is removed and
      // gsettings falls back to the host schema location.
      expect(spawnInput.env.GSETTINGS_SCHEMA_DIR).toBeUndefined();
      // Unrelated host vars still pass through untouched.
      expect(spawnInput.env.TEST_TERMINAL_KEEP).toBe("keep-me");
    }),
  );

  it.effect("leaves the environment untouched when not launched from an AppImage", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter } = yield* createManager(5, {
        env: {
          PATH: "/usr/local/bin:/usr/bin:/bin",
          LD_LIBRARY_PATH: "/home/user/.local/lib",
          // Without APPIMAGE/APPDIR set, OWD is an ordinary variable and must
          // not be stripped — only an AppImage launch gives it special meaning.
          OWD: "/home/user/keep-this",
        },
      });
      yield* manager.open(openInput());
      const spawnInput = ptyAdapter.spawnInputs[0];
      expect(spawnInput).toBeDefined();
      if (!spawnInput) return;

      expect(spawnInput.env.PATH).toBe("/usr/local/bin:/usr/bin:/bin");
      expect(spawnInput.env.LD_LIBRARY_PATH).toBe("/home/user/.local/lib");
      expect(spawnInput.env.OWD).toBe("/home/user/keep-this");
    }),
  );

  it.effect("injects runtime env overrides into spawned terminals", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter } = yield* createManager(5, { env: { FORCE_COLOR: "3" } });
      yield* manager.open(
        openInput({
          env: {
            T3CODE_PROJECT_ROOT: "/repo",
            T3CODE_WORKTREE_PATH: "/repo/worktree-a",
            CUSTOM_FLAG: "1",
            NO_COLOR: "1",
            FORCE_COLOR: "0",
          },
        }),
      );
      const spawnInput = ptyAdapter.spawnInputs[0];
      expect(spawnInput).toBeDefined();
      if (!spawnInput) return;

      assert.equal(spawnInput.env.T3CODE_PROJECT_ROOT, "/repo");
      assert.equal(spawnInput.env.T3CODE_WORKTREE_PATH, "/repo/worktree-a");
      assert.equal(spawnInput.env.CUSTOM_FLAG, "1");
      assert.equal(spawnInput.env.NO_COLOR, "1");
      assert.equal(spawnInput.env.FORCE_COLOR, "0");
    }),
  );

  it.effect("resolves a provider instance environment before spawning", () =>
    Effect.gen(function* () {
      const providerInstanceId = ProviderInstanceId.make("codex_work");
      const { manager, ptyAdapter } = yield* createManager(5, {
        env: { T3CODE_SECRET: "server-only" },
        resolveProviderInstanceEnvironment: (requestedId, env) =>
          Effect.succeed({
            ...env,
            PROVIDER_SECRET: requestedId === providerInstanceId ? "secret-value" : "wrong",
            CODEX_HOME: "/accounts/codex-work",
          }),
      });

      const snapshot = yield* manager.open(
        openInput({ providerInstanceId, env: { CLIENT_FLAG: "1" } }),
      );

      expect(ptyAdapter.spawnInputs[0]?.env.PROVIDER_SECRET).toBe("secret-value");
      expect(ptyAdapter.spawnInputs[0]?.env.CODEX_HOME).toBe("/accounts/codex-work");
      expect(ptyAdapter.spawnInputs[0]?.env.CLIENT_FLAG).toBe("1");
      expect(ptyAdapter.spawnInputs[0]?.env.T3CODE_SECRET).toBeUndefined();
      expect(snapshot).not.toHaveProperty("env");
      expect(snapshot).not.toHaveProperty("providerInstanceId");
    }),
  );

  it.effect("fails closed when a provider instance is missing", () =>
    Effect.gen(function* () {
      const providerInstanceId = ProviderInstanceId.make("deleted_instance");
      const { manager, ptyAdapter } = yield* createManager(5, {
        resolveProviderInstanceEnvironment: (requestedId) =>
          Effect.fail(
            new TerminalProviderInstanceNotFoundError({
              providerInstanceId: ProviderInstanceId.make(requestedId),
            }),
          ),
      });

      const error = yield* manager.open(openInput({ providerInstanceId })).pipe(Effect.flip);

      assert.deepStrictEqual(
        error,
        new TerminalProviderInstanceNotFoundError({ providerInstanceId }),
      );
      expect(ptyAdapter.spawnInputs).toHaveLength(0);
    }),
  );

  it.effect("preserves the settings failure when provider environment resolution fails", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const providerInstanceId = ProviderInstanceId.make("codex_work");
      const settingsCause = new Error("secret store read failed");
      const settingsError = new ServerSettingsError({
        settingsPath: "/test/settings.json",
        operation: "read-secret",
        providerInstanceId,
        environmentVariable: "OPENROUTER_API_KEY",
        cause: settingsCause,
      });
      const serverSettings = ServerSettings.ServerSettingsService.of({
        start: Effect.void,
        ready: Effect.void,
        getSettings: Effect.fail(settingsError),
        updateSettings: () => Effect.fail(settingsError),
        updateProviderInstance: () => Effect.fail(settingsError),
        withSettingsSnapshot: () => Effect.fail(settingsError),
        streamChanges: Stream.empty,
        subscribeChanges: Effect.succeed(Stream.empty),
      });

      const error = yield* TerminalManager.resolveProviderInstanceTerminalEnvironment({
        serverSettings,
        path,
        rawProviderInstanceId: providerInstanceId,
        env: undefined,
      }).pipe(Effect.flip);

      expect(error).toMatchObject({
        _tag: "TerminalProviderEnvironmentError",
        providerInstanceId,
      });
      expect(error.cause).toBe(settingsError);
      expect(error.message).not.toContain(settingsError.message);
      expect(error.message).not.toContain("OPENROUTER_API_KEY");
    }),
  );

  it.effect.each([
    {
      name: "Codex home",
      driver: "codex",
      variable: "CODEX_HOME",
      config: { homePath: "/configured/codex" },
      expectedHome: "/configured/codex",
    },
    {
      name: "Codex shadow home",
      driver: "codex",
      variable: "CODEX_HOME",
      config: { homePath: "/configured/codex", shadowHomePath: "/configured/codex-shadow" },
      expectedHome: "/configured/codex-shadow",
    },
    {
      name: "Claude home",
      driver: "claudeAgent",
      variable: "CLAUDE_CONFIG_DIR",
      config: { homePath: "/configured/claude" },
      expectedHome: "/configured/claude",
    },
  ])("prefers $name over the instance environment", ({ driver, variable, config, expectedHome }) =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const serverSettings = yield* ServerSettings.ServerSettingsService;
      const environment = yield* TerminalManager.resolveProviderInstanceTerminalEnvironment({
        serverSettings,
        path,
        rawProviderInstanceId: "configured_home",
        env: undefined,
      });

      expect(environment[variable]).toBe(path.resolve(expectedHome));
    }).pipe(
      Effect.provide(
        ServerSettings.layerTest({
          providerInstances: {
            [ProviderInstanceId.make("configured_home")]: {
              driver: ProviderDriverKind.make(driver),
              environment: [{ name: variable, value: "~/.environment-account", sensitive: false }],
              config,
            },
          },
        }),
      ),
    ),
  );

  it.effect("resolves the Codex default slot", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const serverSettings = yield* ServerSettings.ServerSettingsService;
      const environment = yield* TerminalManager.resolveProviderInstanceTerminalEnvironment({
        serverSettings,
        path,
        rawProviderInstanceId: "codex",
        env: undefined,
      });

      expect(environment.CODEX_HOME).toMatch(/[\\/][.]codex-default$/);
    }).pipe(
      Effect.provide(
        ServerSettings.ServerSettingsService.layerTest({
          providerInstances: {
            [ProviderInstanceId.make("codex")]: {
              driver: ProviderDriverKind.make("codex"),
              config: { homePath: "~/.codex-default" },
            },
          },
        }),
      ),
    ),
  );

  it.effect("resolves the Claude default slot", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const serverSettings = yield* ServerSettings.ServerSettingsService;
      const environment = yield* TerminalManager.resolveProviderInstanceTerminalEnvironment({
        serverSettings,
        path,
        rawProviderInstanceId: "claudeAgent",
        env: undefined,
      });

      expect(environment.CLAUDE_CONFIG_DIR).toMatch(/[\\/][.]claude-default$/);
    }).pipe(
      Effect.provide(
        ServerSettings.ServerSettingsService.layerTest({
          providerInstances: {
            [ProviderInstanceId.make("claudeAgent")]: {
              driver: ProviderDriverKind.make("claudeAgent"),
              config: { homePath: "~/.claude-default" },
            },
          },
        }),
      ),
    ),
  );

  it.effect("resolves an empty Codex default slot with default config", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const serverSettings = yield* ServerSettings.ServerSettingsService;
      const environment = yield* TerminalManager.resolveProviderInstanceTerminalEnvironment({
        serverSettings,
        path,
        rawProviderInstanceId: "codex",
        env: { CODEX_HOME: "/inherited/codex-home" },
      });

      expect(environment.CODEX_HOME).toBe("/inherited/codex-home");
    }).pipe(
      Effect.provide(ServerSettings.ServerSettingsService.layerTest({ providerInstances: {} })),
    ),
  );

  it.effect("keeps unknown provider instance ids unavailable after default-slot hydration", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const serverSettings = yield* ServerSettings.ServerSettingsService;
      const error = yield* TerminalManager.resolveProviderInstanceTerminalEnvironment({
        serverSettings,
        path,
        rawProviderInstanceId: "codex_unknown",
        env: undefined,
      }).pipe(Effect.flip);

      expect(error).toMatchObject({
        _tag: "TerminalProviderInstanceNotFoundError",
        providerInstanceId: "codex_unknown",
      });
    }).pipe(Effect.provide(ServerSettings.ServerSettingsService.layerTest())),
  );

  it.effect("restarts a running terminal when the resolved provider environment changes", () =>
    Effect.gen(function* () {
      const providerInstanceId = ProviderInstanceId.make("codex_work");
      let providerSecret = "first-secret";
      const { manager, ptyAdapter } = yield* createManager(5, {
        resolveProviderInstanceEnvironment: () =>
          Effect.succeed({ PROVIDER_SECRET: providerSecret }),
      });

      yield* manager.open(openInput({ providerInstanceId }));
      providerSecret = "second-secret";
      yield* manager.open(openInput({ providerInstanceId }));

      expect(ptyAdapter.processes[0]?.killed).toBe(true);
      expect(ptyAdapter.spawnInputs).toHaveLength(2);
      expect(ptyAdapter.spawnInputs[1]?.env.PROVIDER_SECRET).toBe("second-secret");
    }),
  );

  it.effect("restarts with current provider secrets and clears bounded history", () =>
    Effect.gen(function* () {
      const serverSettings = yield* ServerSettings.ServerSettingsService;
      const path = yield* Path.Path;
      const providerInstanceId = ProviderInstanceId.make("codex_restart");
      const { manager, ptyAdapter, logsDir } = yield* createManager(2, {
        historyByteLimit: 8,
        resolveProviderInstanceEnvironment: (rawProviderInstanceId, env) =>
          TerminalManager.resolveProviderInstanceTerminalEnvironment({
            serverSettings,
            path,
            rawProviderInstanceId,
            env,
          }),
      });
      const homePath = path.join(logsDir, "codex");
      const updateSecret = (value: string) =>
        serverSettings.updateSettings({
          providerInstances: {
            [providerInstanceId]: {
              driver: ProviderDriverKind.make("codex"),
              config: { homePath },
              environment: [{ name: "PROVIDER_SECRET", value, sensitive: true }],
            },
          },
        });
      const input = {
        providerInstanceId,
        env: { CLIENT_FLAG: "1", PROVIDER_SECRET: "client-value" },
      };
      const outputProcessed = yield* Deferred.make<void>();
      const unsubscribe = yield* manager.subscribe((event) =>
        event.type === "output"
          ? Deferred.succeed(outputProcessed, undefined).pipe(Effect.asVoid)
          : Effect.void,
      );
      yield* Effect.addFinalizer(() => Effect.sync(unsubscribe));

      yield* updateSecret("first-secret");
      yield* manager.restart(restartInput(input));
      const firstProcess = ptyAdapter.processes[0]!;
      expect(ptyAdapter.spawnInputs[0]?.env.PROVIDER_SECRET).toBe("first-secret");
      firstProcess.emitData("discarded\nold-one\nold-two\n");
      yield* Deferred.await(outputProcessed);
      expect((yield* manager.open(openInput(input))).history).toBe("old-two\n");

      yield* updateSecret("second-secret");
      const restarted = yield* manager.restart(restartInput(input));

      expect(firstProcess.killed).toBe(true);
      expect(ptyAdapter.spawnInputs).toHaveLength(2);
      expect(ptyAdapter.spawnInputs[1]?.env).toMatchObject({
        PROVIDER_SECRET: "second-secret",
        CODEX_HOME: homePath,
        CLIENT_FLAG: "1",
      });
      expect(restarted.history).toBe("");
      expect(restarted.status).toBe("running");
      expect(restarted).not.toHaveProperty("env");
      expect(restarted).not.toHaveProperty("providerInstanceId");
      const logPath = yield* historyLogPath(logsDir);
      expect(yield* readFileString(logPath)).toBe("");

      ptyAdapter.processes[1]!.emitData("discarded again\nnew-one\nnew-two\n");
      yield* manager.close({ threadId: "thread-1" });
      expect(yield* readFileString(logPath)).toBe("new-two\n");
    }).pipe(
      Effect.provide(
        ServerSettings.layer.pipe(
          Layer.provide(ServerSecretStore.layer),
          Layer.provide(SqlitePersistence.layerMemory),
          Layer.provide(
            ServerConfig.layerTest(process.cwd(), { prefix: "t3code-terminal-provider-restart-" }),
          ),
        ),
      ),
    ),
  );

  it.effect("attaches to a running provider terminal without resolving the provider again", () =>
    Effect.gen(function* () {
      const providerInstanceId = ProviderInstanceId.make("codex_work");
      let providerAvailable = true;
      const { manager, ptyAdapter } = yield* createManager(5, {
        resolveProviderInstanceEnvironment: (requestedId) =>
          providerAvailable
            ? Effect.succeed({ PROVIDER_SECRET: "secret-value" })
            : Effect.fail(
                new TerminalProviderInstanceNotFoundError({
                  providerInstanceId: ProviderInstanceId.make(requestedId),
                }),
              ),
      });
      yield* manager.open(openInput({ providerInstanceId }));
      providerAvailable = false;
      const events: TerminalAttachStreamEvent[] = [];

      const unsubscribe = yield* manager.attachStream(
        { ...openInput({ providerInstanceId }), restartIfNotRunning: true },
        (event) => Effect.sync(() => events.push(event)),
      );
      unsubscribe();

      expect(events[0]?.type).toBe("snapshot");
      expect(ptyAdapter.spawnInputs).toHaveLength(1);
      expect(ptyAdapter.processes[0]?.killed).toBe(false);
    }),
  );

  it.effect("fails closed when attaching would create a missing provider terminal", () =>
    Effect.gen(function* () {
      const providerInstanceId = ProviderInstanceId.make("deleted_instance");
      const { manager, ptyAdapter } = yield* createManager(5, {
        resolveProviderInstanceEnvironment: (requestedId) =>
          Effect.fail(
            new TerminalProviderInstanceNotFoundError({
              providerInstanceId: ProviderInstanceId.make(requestedId),
            }),
          ),
      });

      const error = yield* manager
        .attachStream(openInput({ providerInstanceId }), () => Effect.void)
        .pipe(Effect.flip);

      assert.deepStrictEqual(
        error,
        new TerminalProviderInstanceNotFoundError({ providerInstanceId }),
      );
      expect(ptyAdapter.spawnInputs).toHaveLength(0);
    }),
  );

  it.effect("starts zsh with prompt spacer disabled to avoid `%` end markers", () =>
    Effect.gen(function* () {
      if ((yield* HostProcessPlatform) === "win32") return;
      const { manager, ptyAdapter } = yield* createManager(5, {
        shellResolver: () => "/bin/zsh",
      });
      yield* manager.open(openInput());
      const spawnInput = ptyAdapter.spawnInputs[0];
      expect(spawnInput).toBeDefined();
      if (!spawnInput) return;

      expect(spawnInput.args).toEqual(["-o", "nopromptsp"]);
    }),
  );

  it.effect("bridges PTY callbacks back into Effect-managed event streaming", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter, getEvents } = yield* createManager(5, {
        ptyAdapter: new FakePtyAdapter("async"),
      });

      yield* manager.open(openInput());
      const process = ptyAdapter.processes[0];
      expect(process).toBeDefined();
      if (!process) return;

      process.emitData("hello from callback\n");

      yield* waitFor(
        Effect.map(getEvents, (events) =>
          events.some((event) => event.type === "output" && event.data === "hello from callback\n"),
        ),
        "1200 millis",
      );
    }),
  );

  it.effect("pushes PTY callbacks to direct event subscribers", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter } = yield* createManager(5, {
        ptyAdapter: new FakePtyAdapter("async"),
      });
      const subscriberEvents = yield* Ref.make<ReadonlyArray<TerminalEvent>>([]);
      const unsubscribe = yield* manager.subscribe((event) =>
        Ref.update(subscriberEvents, (events) => [...events, event]),
      );
      yield* Effect.addFinalizer(() => Effect.sync(unsubscribe));

      yield* manager.open(openInput());
      const process = ptyAdapter.processes[0];
      expect(process).toBeDefined();
      if (!process) return;

      process.emitData("hello from subscriber\n");

      yield* waitFor(
        Effect.map(Ref.get(subscriberEvents), (events) =>
          events.some(
            (event) => event.type === "output" && event.data === "hello from subscriber\n",
          ),
        ),
        "1200 millis",
      );
    }),
  );

  it.effect("subscribes terminal metadata with an initial snapshot and live deltas", () =>
    Effect.gen(function* () {
      const { manager } = yield* createManager();
      yield* manager.open(openInput({ threadId: "existing-thread" }));

      const metadataEvents = yield* Ref.make<ReadonlyArray<TerminalMetadataStreamEvent>>([]);
      const unsubscribe = yield* manager.subscribeMetadata((event) =>
        Ref.update(metadataEvents, (events) => [...events, event]),
      );
      yield* Effect.addFinalizer(() => Effect.sync(unsubscribe));

      const initialEvents = yield* Ref.get(metadataEvents);
      expect(initialEvents[0]).toMatchObject({
        type: "snapshot",
        terminals: [
          {
            threadId: "existing-thread",
            terminalId: DEFAULT_TERMINAL_ID,
          },
        ],
      });

      yield* manager.open(openInput({ threadId: "new-thread" }));

      yield* waitFor(
        Effect.map(Ref.get(metadataEvents), (events) =>
          events.some(
            (event) =>
              event.type === "upsert" &&
              event.terminal.threadId === "new-thread" &&
              event.terminal.terminalId === DEFAULT_TERMINAL_ID,
          ),
        ),
        "1200 millis",
      );

      yield* manager.close({ threadId: "new-thread", terminalId: DEFAULT_TERMINAL_ID });

      yield* waitFor(
        Effect.map(Ref.get(metadataEvents), (events) =>
          events.some(
            (event) =>
              event.type === "remove" &&
              event.threadId === "new-thread" &&
              event.terminalId === DEFAULT_TERMINAL_ID,
          ),
        ),
        "1200 millis",
      );
    }),
  );

  it.effect("removes terminal metadata subscriptions when initial delivery fails", () =>
    Effect.gen(function* () {
      const { manager } = yield* createManager();
      yield* manager.open(openInput({ threadId: "existing-thread" }));

      const leakedLiveEvents = yield* Ref.make(0);
      const exit = yield* Effect.exit(
        manager.subscribeMetadata((event) =>
          event.type === "snapshot"
            ? Effect.die("snapshot listener failed")
            : Ref.update(leakedLiveEvents, (count) => count + 1),
        ),
      );

      expect(Exit.isFailure(exit)).toBe(true);

      yield* manager.open(openInput({ threadId: "new-thread" }));
      expect(yield* Ref.get(leakedLiveEvents)).toBe(0);
    }),
  );

  it.effect(
    "streams attach snapshots followed by live events without duplicate start snapshots",
    () =>
      Effect.gen(function* () {
        const { manager, ptyAdapter } = yield* createManager(5, {
          ptyAdapter: new FakePtyAdapter("async"),
        });
        const attachEvents = yield* Ref.make<ReadonlyArray<TerminalAttachStreamEvent>>([]);
        const unsubscribe = yield* manager.attachStream(openInput(), (event) =>
          Ref.update(attachEvents, (events) => [...events, event]),
        );
        yield* Effect.addFinalizer(() => Effect.sync(unsubscribe));

        const process = ptyAdapter.processes[0];
        expect(process).toBeDefined();
        if (!process) return;

        expect(yield* Ref.get(attachEvents)).toMatchObject([
          {
            type: "snapshot",
            snapshot: {
              threadId: "thread-1",
              terminalId: DEFAULT_TERMINAL_ID,
            },
          },
        ]);

        process.emitData("hello from attach\n");

        yield* waitFor(
          Effect.map(Ref.get(attachEvents), (events) =>
            events.some((event) => event.type === "output" && event.data === "hello from attach\n"),
          ),
          "1200 millis",
        );

        const events = yield* Ref.get(attachEvents);
        expect(events.filter((event) => event.type === "snapshot")).toHaveLength(1);
      }),
  );

  it.effect("observes terminal history and live output without changing the process", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter } = yield* createManager();
      const opened = yield* manager.open(openInput({ env: { OBSERVER_TEST: "original" } }));
      const process = ptyAdapter.processes[0]!;
      const historyReceived = yield* Deferred.make<void>();
      const unsubscribeHistory = yield* manager.subscribe((event) =>
        event.type === "output"
          ? Deferred.succeed(historyReceived, undefined).pipe(Effect.asVoid)
          : Effect.void,
      );
      process.emitData("existing history\n");
      yield* Deferred.await(historyReceived);
      unsubscribeHistory();

      const observed = yield* Ref.make<ReadonlyArray<TerminalAttachStreamEvent>>([]);
      const liveReceived = yield* Deferred.make<void>();
      const unsubscribe = yield* manager.observeStream(
        { threadId: opened.threadId, terminalId: opened.terminalId },
        (event) =>
          Ref.update(observed, (events) => [...events, event]).pipe(
            Effect.andThen(
              event.type === "output"
                ? Deferred.succeed(liveReceived, undefined).pipe(Effect.asVoid)
                : Effect.void,
            ),
          ),
      );
      yield* Effect.addFinalizer(() => Effect.sync(unsubscribe));
      process.emitData("live output\n");
      yield* Deferred.await(liveReceived);

      expect(yield* Ref.get(observed)).toMatchObject([
        {
          type: "snapshot",
          snapshot: {
            cwd: opened.cwd,
            worktreePath: opened.worktreePath,
            pid: opened.pid,
            history: "existing history\n",
          },
        },
        { type: "output", data: "live output\n" },
      ]);
      expect(ptyAdapter.spawnInputs).toHaveLength(1);
      expect(ptyAdapter.spawnInputs[0]?.env.OBSERVER_TEST).toBe("original");
      expect(process.resizeCalls).toEqual([]);
      expect(process.writes).toEqual([]);
      expect(process.killSignals).toEqual([]);
    }),
  );

  it.effect("observes exited terminals without restarting and rejects missing sessions", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter } = yield* createManager();
      const missingEvents: TerminalAttachStreamEvent[] = [];
      const missing = yield* manager
        .observeStream({ threadId: "thread-1", terminalId: DEFAULT_TERMINAL_ID }, (event) =>
          Effect.sync(() => {
            missingEvents.push(event);
          }),
        )
        .pipe(Effect.flip);
      expect(missing._tag).toBe("TerminalSessionLookupError");
      expect(ptyAdapter.spawnInputs).toEqual([]);

      yield* manager.open(openInput());
      const process = ptyAdapter.processes[0]!;
      const exited = yield* Deferred.make<void>();
      const unsubscribeExit = yield* manager.subscribe((event) =>
        event.type === "exited"
          ? Deferred.succeed(exited, undefined).pipe(Effect.asVoid)
          : Effect.void,
      );
      process.emitExit({ exitCode: 7, signal: 0 });
      yield* Deferred.await(exited);
      unsubscribeExit();

      const events: TerminalAttachStreamEvent[] = [];
      const unsubscribe = yield* manager.observeStream(
        { threadId: "thread-1", terminalId: DEFAULT_TERMINAL_ID },
        (event) =>
          Effect.sync(() => {
            events.push(event);
          }),
      );
      unsubscribe();
      expect(events).toMatchObject([
        { type: "snapshot", snapshot: { status: "exited", exitCode: 7, pid: null } },
      ]);
      expect(ptyAdapter.spawnInputs).toHaveLength(1);
      expect(process.resizeCalls).toEqual([]);
      expect(process.writes).toEqual([]);
      expect(process.killSignals).toEqual([]);
      expect(missingEvents).toEqual([]);
    }),
  );

  it.effect("buffers attach output delivered during the initial snapshot callback", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter } = yield* createManager(5, {
        ptyAdapter: new FakePtyAdapter("async"),
      });
      yield* manager.open(openInput());

      const process = ptyAdapter.processes[0];
      expect(process).toBeDefined();
      if (!process) return;

      const attachEvents = yield* Ref.make<ReadonlyArray<TerminalAttachStreamEvent>>([]);
      const unsubscribe = yield* manager.attachStream(openInput(), (event) =>
        Effect.gen(function* () {
          yield* Ref.update(attachEvents, (events) => [...events, event]);
          if (event.type === "snapshot") {
            yield* Effect.sync(() => process.emitData("during snapshot\n"));
            yield* Effect.yieldNow;
          }
        }),
      );
      yield* Effect.addFinalizer(() => Effect.sync(unsubscribe));

      yield* waitFor(
        Effect.map(Ref.get(attachEvents), (events) =>
          events.some((event) => event.type === "output" && event.data === "during snapshot\n"),
        ),
        "1200 millis",
      );

      expect(yield* Ref.get(attachEvents)).toMatchObject([
        { type: "snapshot" },
        { type: "output", data: "during snapshot\n" },
      ]);
    }),
  );

  it.effect("preserves queued PTY output ordering through exit callbacks", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter, getEvents } = yield* createManager(5, {
        ptyAdapter: new FakePtyAdapter("async"),
      });

      yield* manager.open(openInput());
      const process = ptyAdapter.processes[0];
      expect(process).toBeDefined();
      if (!process) return;

      process.emitData("first\n");
      process.emitData("second\n");
      process.emitExit({ exitCode: 0, signal: 0 });

      yield* waitFor(
        Effect.map(getEvents, (events) => {
          const relevant = events.filter(
            (event) => event.type === "output" || event.type === "exited",
          );
          return relevant.length >= 3;
        }),
        "1200 millis",
      );

      const relevant = (yield* getEvents).filter(
        (event) => event.type === "output" || event.type === "exited",
      );
      expect(relevant).toEqual([
        expect.objectContaining({ type: "output", data: "first\n", sequence: 2 }),
        expect.objectContaining({ type: "output", data: "second\n", sequence: 3 }),
        expect.objectContaining({ type: "exited", exitCode: 0, exitSignal: 0, sequence: 4 }),
      ]);

      const attachEvents = yield* Ref.make<ReadonlyArray<TerminalAttachStreamEvent>>([]);
      const unsubscribe = yield* manager.attachStream(
        {
          threadId: "thread-1",
          terminalId: DEFAULT_TERMINAL_ID,
        },
        (event) => Ref.update(attachEvents, (events) => [...events, event]),
      );
      yield* Effect.addFinalizer(() => Effect.sync(unsubscribe));

      const snapshot = (yield* Ref.get(attachEvents)).find((event) => event.type === "snapshot");
      expect(snapshot).toBeDefined();
      if (!snapshot || snapshot.type !== "snapshot") return;
      expect(snapshot.snapshot.sequence).toBe(4);
    }),
  );

  it.effect("scoped runtime shutdown stops active terminals cleanly", () =>
    Effect.gen(function* () {
      const scope = yield* Scope.make("sequential");
      const { manager, ptyAdapter } = yield* createManager(5, {
        processKillGraceMs: 10,
      }).pipe(Effect.provideService(Scope.Scope, scope));
      yield* manager.open(openInput());
      const process = ptyAdapter.processes[0];
      expect(process).toBeDefined();
      if (!process) return;

      const closeScope = yield* Scope.close(scope, Exit.void).pipe(Effect.forkScoped);
      yield* Effect.yieldNow;
      yield* TestClock.adjust("10 millis");
      yield* Fiber.join(closeScope);

      assert.equal(process.killSignals[0], "SIGTERM");
      expect(process.killSignals).toContain("SIGKILL");
    }).pipe(Effect.provide(TestClock.layer())),
  );
});
