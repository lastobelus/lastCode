import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { assert, describe, expect, it, vi } from "@effect/vitest";
import {
  CommandId,
  ProjectId,
  type TerminalEvent,
  type TerminalSessionSnapshot,
  UpdateDrainRequestId,
  UpdateDrainTargetVersion,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import { TestClock } from "effect/testing";

import * as EffectOutbox from "../orchestration-v2/EffectOutbox.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProviderSessionManager from "../orchestration-v2/ProviderSessionManager.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as UpdateDrainRepositoryPersistence from "../persistence/UpdateDrainRepository.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as TerminalManager from "../terminal/Manager.ts";
import * as UpdateDrain from "../updateDrain/UpdateDrain.ts";
import * as UpdateDrainAdmission from "../updateDrain/UpdateDrainAdmission.ts";
import * as ProjectService from "./ProjectService.ts";
import * as ProjectSetupScriptRunner from "./ProjectSetupScriptRunner.ts";

const threadId = "thread-1";
const terminalId = "setup-setup";
const event = { threadId, terminalId, sequence: 1, createdAt: "2026-01-01T00:00:00.000Z" };

const openSnapshot = (history: string): TerminalSessionSnapshot => ({
  threadId,
  terminalId,
  cwd: "/repo/.t3/worktrees/feature",
  worktreePath: null,
  status: "running",
  pid: 123,
  history,
  exitCode: null,
  exitSignal: null,
  label: "zsh",
  updatedAt: "2026-01-01T00:00:00.000Z",
});

const makeHarness = Effect.fn(function* (options: {
  readonly history?: string;
  readonly opening?: Deferred.Deferred<void>;
}) {
  const listeners = new Set<(event: TerminalEvent) => Effect.Effect<void>>();
  const writes = yield* Queue.unbounded<string>();
  const outputLines = yield* Queue.unbounded<string>();
  const terminals = Layer.mock(TerminalManager.TerminalManager)({
    open: () =>
      (options.opening
        ? Deferred.succeed(options.opening, undefined).pipe(Effect.andThen(Effect.never))
        : Effect.void
      ).pipe(Effect.as(openSnapshot(options.history ?? ""))),
    subscribe: (listener) =>
      Effect.sync(() => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      }),
    write: (input) => Queue.offer(writes, input.data).pipe(Effect.asVoid),
    closeIdle: () => Effect.void,
  });
  const runner = yield* ProjectSetupScriptRunner.make.pipe(
    Effect.provide(
      Layer.mergeAll(
        terminals,
        Layer.mock(UpdateDrainAdmission.UpdateDrainAdmission)({
          admit: (_kind, effect) => effect,
        }),
        Layer.mock(ProjectService.ProjectService)({}),
        ServerSettings.layerTest(),
        NodeCrypto.layer,
      ),
    ),
    Effect.provideService(HostProcess.Platform, "darwin"),
    Effect.provideService(HostProcess.Environment, { SHELL: "/bin/zsh" }),
  );
  const start = runner.runForThread({
    threadId,
    worktreePath: "/repo/.t3/worktrees/feature",
    observeCompletion: { onOutputLine: (line) => Queue.offer(outputLines, line) },
    project: {
      id: ProjectId.make("project-1"),
      workspaceRoot: "/repo",
      scripts: [
        {
          id: "setup",
          name: "Setup",
          command: "vp i",
          icon: "configure",
          runOnWorktreeCreate: true,
        },
      ],
    },
  });
  const emit = (terminalEvent: TerminalEvent) =>
    Effect.forEach([...listeners], (listener) => listener(terminalEvent), { discard: true });
  return { start, listeners, writes, outputLines, emit };
});

const setup = Effect.fn(function* (options: { readonly history?: string } = {}) {
  const harness = yield* makeHarness(options);
  const result = yield* harness.start;
  const completion = result.status === "started" ? result.completion : undefined;
  if (!completion) return yield* Effect.die("setup did not start an observed run");
  return { ...harness, result, completion };
});

describe("ProjectSetupScriptRunner", () => {
  it.effect("shows a startup prompt and types only once the line editor starts", () =>
    Effect.gen(function* () {
      const { result, writes, outputLines, emit } = yield* setup();
      expect(result).toMatchObject({ status: "started", terminalId });

      yield* emit({ ...event, type: "output", data: "Missing Node.\r\nInstall it? [y/N]: " });
      yield* emit({ ...event, type: "activity", hasRunningSubprocess: true, label: "fnm" });
      yield* TestClock.adjust("1 minute");
      expect(yield* Queue.size(writes)).toBe(0);
      expect(yield* Queue.takeAll(outputLines)).toEqual(["Missing Node.", "Install it? [y/N]:"]);

      yield* emit({ ...event, type: "activity", hasRunningSubprocess: false, label: "zsh" });
      yield* emit({ ...event, type: "output", data: "\r\n% \x1b[?2004h" });
      expect(yield* Queue.take(writes)).toMatch(/^ \( vp i\r\);/);
    }),
  );

  it.effect("types into a quiet shell that has no line editor", () =>
    Effect.gen(function* () {
      const { writes } = yield* setup();
      yield* TestClock.adjust("3 seconds");
      expect(yield* Queue.take(writes)).toMatch(/^ \( vp i\r\);/);
    }),
  );

  it.effect("ignores line editor state restored from an earlier shell", () =>
    Effect.gen(function* () {
      const { writes, emit } = yield* setup({ history: "old run\r\n% \x1b[?2004h" });
      yield* emit({ ...event, type: "activity", hasRunningSubprocess: true, label: "fnm" });
      yield* TestClock.adjust("1 minute");
      expect(yield* Queue.size(writes)).toBe(0);
    }),
  );

  it.effect("forgets a busy startup child when the shell restarts", () =>
    Effect.gen(function* () {
      const { writes, emit } = yield* setup();
      yield* emit({ ...event, type: "activity", hasRunningSubprocess: true, label: "fnm" });
      yield* TestClock.adjust("1 minute");
      expect(yield* Queue.size(writes)).toBe(0);
      yield* emit({ ...event, type: "restarted", snapshot: openSnapshot("") });
      // The restart lands inside a quiet window, so the next full window decides.
      yield* TestClock.adjust("6 seconds");
      expect(yield* Queue.take(writes)).toMatch(/^ \( vp i\r\);/);
    }),
  );

  it.effect("drops its terminal listeners when cancelled while the terminal opens", () =>
    Effect.gen(function* () {
      const opening = yield* Deferred.make<void>();
      const { start, listeners } = yield* makeHarness({ opening });
      const fiber = yield* Effect.forkChild(start);
      yield* Deferred.await(opening);
      expect(listeners.size).toBe(2);
      yield* Fiber.interrupt(fiber);
      expect(listeners.size).toBe(0);
    }),
  );

  it.effect("does not type into a shell that exits during startup", () =>
    Effect.gen(function* () {
      const { completion, writes, emit } = yield* setup();
      yield* emit({ ...event, type: "exited", exitCode: 1, exitSignal: null });
      expect(yield* completion).toMatchObject({ exitCode: null });
      yield* TestClock.adjust("1 minute");
      expect(yield* Queue.size(writes)).toBe(0);
    }),
  );
});

const startDrain = {
  type: "update-drain.start" as const,
  commandId: CommandId.make("close-setup-admission"),
  requestId: UpdateDrainRequestId.make("setup-update"),
  targetVersion: UpdateDrainTargetVersion.make("1.2.3"),
  createdAt: "2026-06-20T00:00:00.000Z",
};

function makeAdmissionHarness(
  options: {
    readonly setupScript?: boolean;
    readonly writeEffect?: Effect.Effect<void>;
  } = {},
) {
  const open = vi.fn((input: Parameters<TerminalManager.TerminalManager["Service"]["open"]>[0]) =>
    Effect.void.pipe(
      Effect.as({
        threadId: input.threadId,
        terminalId: input.terminalId,
        cwd: input.cwd,
        worktreePath: input.worktreePath ?? null,
        status: "running" as const,
        pid: 123,
        history: "",
        exitCode: null,
        exitSignal: null,
        label: "Shell",
        updatedAt: "2026-06-20T00:00:00.000Z",
      }),
    ),
  );
  const write = vi.fn(
    (_input: Parameters<TerminalManager.TerminalManager["Service"]["write"]>[0]) =>
      options.writeEffect ?? Effect.void,
  );
  const closeIdle = vi.fn(
    (_input: Parameters<TerminalManager.TerminalManager["Service"]["closeIdle"]>[0]) => Effect.void,
  );
  const listeners = new Set<Parameters<TerminalManager.TerminalManager["Service"]["subscribe"]>[0]>();
  const subscribe: TerminalManager.TerminalManager["Service"]["subscribe"] = (listener) =>
    Effect.sync(() => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    });
  const projectId = ProjectId.make("project:setup-runner-v2");
  const project = {
    id: projectId,
    title: "Project",
    workspaceRoot: "/repo",
    repositoryIdentity: null,
    faviconPath: null,
    defaultModelSelection: null,
    scripts:
      options.setupScript === false
        ? []
        : [
            {
              id: "setup",
              name: "Setup",
              command: "vp install",
              icon: "configure" as const,
              runOnWorktreeCreate: true,
            },
            {
              id: "clean",
              name: "Clean",
              command: "cargo clean",
              icon: "build" as const,
              runOnWorktreeCreate: false,
              runOnSettle: true,
            },
          ],
    createdAt: "2026-06-20T00:00:00.000Z",
    updatedAt: "2026-06-20T00:00:00.000Z",
    deletedAt: null,
  };
  const layer = ProjectSetupScriptRunner.layer.pipe(
    Layer.provideMerge(
      UpdateDrainAdmission.layer.pipe(
        Layer.provide(
          Layer.mergeAll(
            UpdateDrain.layer.pipe(
              Layer.provide(UpdateDrainRepositoryPersistence.layer),
              Layer.provide(SqlitePersistence.layerMemory),
            ),
            Layer.mock(EffectOutbox.EffectOutboxV2)({ pendingCleanup: Effect.succeed([]) }),
            Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({}),
            Layer.mock(ProjectionStore.ProjectionStoreV2)({
              getShellSnapshot: () =>
                Effect.succeed({
                  schemaVersion: 2,
                  snapshotSequence: 0,
                  threads: [],
                  archivedThreads: [],
                }),
            }),
          ),
        ),
      ),
    ),
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(ProjectService.ProjectService)({
          getById: () => Effect.succeed(Option.some(project)),
        }),
        Layer.mock(TerminalManager.TerminalManager)({
          open,
          write,
          subscribe,
          closeIdle,
          refreshMetadata: Effect.succeed([]),
        }),
        ServerSettings.layerTest(),
        NodeCrypto.layer,
      ),
    ),
    Layer.provide(Layer.succeed(HostProcess.Platform, "darwin")),
    Layer.provide(Layer.succeed(HostProcess.Environment, { SHELL: "/bin/zsh" })),
  );

  const emit = (terminalEvent: TerminalEvent) =>
    Effect.forEach([...listeners], (listener) => listener(terminalEvent), { discard: true });
  return { layer, open, write, listeners, projectId, emit };
}

it.effect("rejects setup before opening a terminal while update admission is closed", () => {
  const { layer, open, write, listeners, projectId } = makeAdmissionHarness();
  return Effect.gen(function* () {
    const admission = yield* UpdateDrainAdmission.UpdateDrainAdmission;
    yield* admission.dispatch(startDrain);
    const runner = yield* ProjectSetupScriptRunner.ProjectSetupScriptRunner;
    const failure = yield* runner
      .runForThread({
        threadId: "thread-1",
        projectId,
        worktreePath: "/repo-worktree",
        observeCompletion: {},
      })
      .pipe(Effect.flip);
    assert.equal(failure._tag, "ProjectSetupScriptOperationError");
    if (failure._tag !== "ProjectSetupScriptOperationError") return;
    assert.equal(failure.operation, "admitSetupScript");
    assert.equal(open.mock.calls.length, 0);
    assert.equal(write.mock.calls.length, 0);
    assert.equal(listeners.size, 0);
  }).pipe(Effect.provide(layer));
});

it.effect("returns no-script during update drain without starting a terminal", () => {
  const { layer, open, write, projectId } = makeAdmissionHarness({ setupScript: false });
  return Effect.gen(function* () {
    const admission = yield* UpdateDrainAdmission.UpdateDrainAdmission;
    yield* admission.dispatch(startDrain);
    const runner = yield* ProjectSetupScriptRunner.ProjectSetupScriptRunner;
    assert.deepEqual(
      yield* runner.runForThread({
        threadId: "thread-1",
        projectId,
        worktreePath: "/repo-worktree",
      }),
      { status: "no-script" },
    );
    assert.equal(open.mock.calls.length, 0);
    assert.equal(write.mock.calls.length, 0);
  }).pipe(Effect.provide(layer));
});

it.effect("holds admission through command write and releases it before setup completion", () =>
  Effect.gen(function* () {
    const writing = yield* Deferred.make<void>();
    const releaseWrite = yield* Deferred.make<void>();
    const closing = yield* Deferred.make<void>();
    const timeline = yield* Ref.make<ReadonlyArray<string>>([]);
    const append = (entry: string) => Ref.update(timeline, (entries) => [...entries, entry]);
    const { layer, listeners, projectId, write, emit } = makeAdmissionHarness({
      writeEffect: Deferred.succeed(writing, undefined).pipe(
        Effect.andThen(Deferred.await(releaseWrite)),
        Effect.andThen(append("command-written")),
      ),
    });
    yield* Effect.gen(function* () {
      const runner = yield* ProjectSetupScriptRunner.ProjectSetupScriptRunner;
      const admission = yield* UpdateDrainAdmission.UpdateDrainAdmission;
      const started = yield* runner.runForThread({
        threadId,
        projectId,
        worktreePath: "/repo-worktree",
        observeCompletion: {},
      });
      assert.equal(started.status, "started");
      if (started.status !== "started") return;
      assert.ok(started.completion);
      assert.equal(listeners.size, 2);
      assert.equal(write.mock.calls.length, 0);
      yield* emit({ ...event, type: "output", data: "% \x1b[?2004h" });
      yield* Deferred.await(writing);
      const close = yield* Deferred.succeed(closing, undefined).pipe(
        Effect.andThen(admission.dispatch(startDrain)),
        Effect.tap(() => append("drain-closed")),
        Effect.forkChild,
      );
      yield* Deferred.await(closing);
      assert.deepEqual(yield* Ref.get(timeline), []);
      yield* Deferred.succeed(releaseWrite, undefined);
      yield* Fiber.join(close);
      assert.deepEqual(yield* Ref.get(timeline), ["command-written", "drain-closed"]);
      yield* emit({ type: "closed", threadId, terminalId, deleteHistory: false });
      assert.equal((yield* started.completion).exitCode, null);
    }).pipe(Effect.provide(layer));
  }),
);
