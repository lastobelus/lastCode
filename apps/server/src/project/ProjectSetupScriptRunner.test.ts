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
import * as WorkspaceAcquisitionTestkit from "../workspace/WorkspaceAcquisition.testkit.ts";
import * as WorkspaceAcquisition from "../workspace/WorkspaceAcquisition.ts";
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
  let busy = false;
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
    hasForegroundSubprocess: () => Effect.sync(() => busy),
  });
  const runner = yield* ProjectSetupScriptRunner.make.pipe(
    Effect.provide(
      Layer.mergeAll(
        terminals,
        WorkspaceAcquisitionTestkit.layer,
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
    Effect.suspend(() => {
      if (terminalEvent.type === "started" || terminalEvent.type === "restarted") busy = false;
      if (terminalEvent.type === "activity") busy = terminalEvent.hasRunningSubprocess;
      return Effect.forEach([...listeners], (listener) => listener(terminalEvent), {
        discard: true,
      });
    });
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
      expect(listeners.size).toBe(1);
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
    readonly manualReadiness?: boolean;
    readonly history?: string;
    readonly opening?: Deferred.Deferred<void>;
    readonly replacementEvents?: ReadonlyArray<TerminalEvent>;
    readonly terminatingPreviousShell?: boolean;
    readonly writeEffect?: Effect.Effect<void>;
    readonly foregroundEffect?: Effect.Effect<boolean>;
    readonly terminalLinkProfileName?: string;
    readonly acquire?: WorkspaceAcquisition.WorkspaceAcquisition["Service"]["acquire"];
  } = {},
) {
  const terminalSnapshot = (
    input: Parameters<TerminalManager.TerminalManager["Service"]["open"]>[0],
  ) => ({
    threadId: input.threadId,
    terminalId: input.terminalId,
    cwd: input.cwd,
    worktreePath: input.worktreePath ?? null,
    ...(input.terminalLinkProfileName
      ? { terminalLinkProfileName: input.terminalLinkProfileName }
      : {}),
    status: "running" as const,
    pid: 123,
    history: options.history ?? "",
    exitCode: null,
    exitSignal: null,
    label: "Shell",
    updatedAt: "2026-06-20T00:00:00.000Z",
  });
  let previousSnapshot: ReturnType<typeof terminalSnapshot> | undefined;
  let busy = false;
  const open = vi.fn((input: Parameters<TerminalManager.TerminalManager["Service"]["open"]>[0]) =>
    Effect.succeed(terminalSnapshot(input)).pipe(
      Effect.tap(() =>
        previousSnapshot
          ? Effect.forEach(options.replacementEvents ?? [], emit, { discard: true })
          : Effect.void,
      ),
      Effect.tap((snapshot) => {
        const changed =
          previousSnapshot?.cwd !== snapshot.cwd ||
          previousSnapshot.worktreePath !== snapshot.worktreePath ||
          previousSnapshot.terminalLinkProfileName !== snapshot.terminalLinkProfileName;
        previousSnapshot = snapshot;
        return changed ? emit({ ...event, type: "started", snapshot }) : Effect.void;
      }),
      Effect.tap(() =>
        options.opening
          ? Deferred.succeed(options.opening, undefined).pipe(Effect.andThen(Effect.never))
          : Effect.void,
      ),
      Effect.tap(() =>
        options.manualReadiness
          ? Effect.void
          : emit({ ...event, type: "output", data: "\x1b[?2004h" }),
      ),
    ),
  );
  const write = vi.fn(
    (_input: Parameters<TerminalManager.TerminalManager["Service"]["write"]>[0]) =>
      options.writeEffect ?? Effect.void,
  );
  const closeIdle = vi.fn(
    (_input: Parameters<TerminalManager.TerminalManager["Service"]["closeIdle"]>[0]) => Effect.void,
  );
  const listeners = new Set<
    Parameters<TerminalManager.TerminalManager["Service"]["subscribe"]>[0]
  >();
  const emit = (value: TerminalEvent) =>
    Effect.suspend(() => {
      if (value.type === "started" || value.type === "restarted") busy = false;
      if (value.type === "activity") busy = value.hasRunningSubprocess;
      return Effect.forEach([...listeners], (listener) => listener(value), { discard: true });
    });
  const subscribe: TerminalManager.TerminalManager["Service"]["subscribe"] = (listener) =>
    Effect.sync(() => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
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
              ...(options.terminalLinkProfileName === undefined
                ? {}
                : { terminalLinkProfileName: options.terminalLinkProfileName }),
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
    Layer.provide(
      options.acquire === undefined
        ? WorkspaceAcquisitionTestkit.layer
        : WorkspaceAcquisitionTestkit.layerWith(options.acquire),
    ),
    Layer.provideMerge(
      UpdateDrainAdmission.layer.pipe(
        Layer.provide(
          Layer.mergeAll(
            UpdateDrain.layer.pipe(
              Layer.provide(UpdateDrainRepositoryPersistence.layer),
              Layer.provide(SqlitePersistence.layerMemory),
            ),
            Layer.mock(EffectOutbox.EffectOutboxV2)({ pendingCleanup: Effect.succeed([]) }),
            Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({
              pendingExecution: Effect.succeed([]),
            }),
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
          getById: () => Effect.succeedSome(project),
        }),
        Layer.mock(TerminalManager.TerminalManager)({
          open,
          write,
          subscribe,
          closeIdle,
          refreshMetadata: Effect.succeed([]),
          hasForegroundSubprocess: () => options.foregroundEffect ?? Effect.sync(() => busy),
          metadata: Effect.sync(() =>
            previousSnapshot
              ? [
                  {
                    ...previousSnapshot,
                    hasRunningSubprocess: options.terminatingPreviousShell || busy,
                  },
                ]
              : [],
          ),
        }),
        ServerSettings.layerTest(),
        NodeCrypto.layer,
        Layer.succeed(HostProcess.Platform, "darwin"),
        Layer.succeed(HostProcess.Environment, { SHELL: "/bin/zsh" }),
      ),
    ),
  );

  return { layer, open, write, listeners, projectId, closeIdle, project, emit, terminalSnapshot };
}

it.effect("uses the restored path when preparing setup command environment", () => {
  const { layer, open, projectId } = makeAdmissionHarness({
    acquire: () =>
      Effect.succeed({ path: "/managed/example/restored", branch: "recovered", restored: true }),
  });
  return Effect.gen(function* () {
    const runner = yield* ProjectSetupScriptRunner.ProjectSetupScriptRunner;
    const result = yield* runner.runForThread({
      threadId: "setup:restored",
      projectId,
      worktreePath: "/managed/example/old",
    });
    assert.equal(result.status, "started");
    assert.equal(open.mock.calls[0]?.[0].cwd, "/managed/example/restored");
    assert.equal(open.mock.calls[0]?.[0].env?.T3CODE_WORKTREE_PATH, "/managed/example/restored");
  }).pipe(Effect.provide(layer));
});

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
      manualReadiness: true,
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
      assert.equal(listeners.size, 1);
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

it.effect("preserves an opted-in setup Action's profile in its own terminal", () => {
  const { layer, open, projectId } = makeAdmissionHarness({
    terminalLinkProfileName: "Work account",
  });
  return Effect.gen(function* () {
    const runner = yield* ProjectSetupScriptRunner.ProjectSetupScriptRunner;
    const result = yield* runner.runForThread({
      threadId: "thread-1",
      projectId,
      worktreePath: "/workspace/example",
      trigger: "setup",
    });
    assert.equal(result.status, "started");
    assert.equal(open.mock.calls[0]?.[0].terminalLinkProfileName, "Work account");
    assert.match(open.mock.calls[0]?.[0].terminalId ?? "", /^setup-/u);
  }).pipe(Effect.provide(layer));
});

it.effect("clears a reused setup terminal's profile after the Action removes its selection", () => {
  const { layer, open, projectId, project } = makeAdmissionHarness({
    terminalLinkProfileName: "Work account",
  });
  return Effect.gen(function* () {
    const runner = yield* ProjectSetupScriptRunner.ProjectSetupScriptRunner;
    const input = {
      threadId: "thread-1",
      projectId,
      worktreePath: "/workspace/example",
      trigger: "setup" as const,
    };
    assert.equal((yield* runner.runForThread(input)).status, "started");
    const script = project.scripts[0]!;
    if ("terminalLinkProfileName" in script) delete script.terminalLinkProfileName;
    assert.equal((yield* runner.runForThread(input)).status, "started");

    const initial = open.mock.calls[0]?.[0];
    const rerun = open.mock.calls[1]?.[0];
    assert.equal(initial?.terminalLinkProfileName, "Work account");
    assert.equal(rerun?.terminalId, initial?.terminalId);
    assert.equal(rerun?.terminalLinkProfileName, null);
  }).pipe(Effect.provide(layer));
});

it.effect("shows a startup prompt and types only once the line editor starts", () =>
  Effect.gen(function* () {
    const writes = yield* Queue.unbounded<string>();
    const outputLines = yield* Queue.unbounded<string>();
    const { layer, projectId, write, closeIdle, emit, listeners } = makeAdmissionHarness({
      manualReadiness: true,
      writeEffect: Queue.offer(writes, "written").pipe(Effect.asVoid),
    });
    yield* Effect.gen(function* () {
      const runner = yield* ProjectSetupScriptRunner.ProjectSetupScriptRunner;
      const result = yield* runner.runForThread({
        ...event,
        projectId,
        worktreePath: "/repo-worktree",
        observeCompletion: { onOutputLine: (line) => Queue.offer(outputLines, line) },
      });
      assert.equal(result.status, "started");
      if (result.status !== "started" || !result.completion)
        return yield* Effect.die("missing completion");
      yield* emit({ ...event, type: "output", data: "Missing Node.\r\nInstall it? [y/N]: " });
      yield* emit({ ...event, type: "activity", hasRunningSubprocess: true, label: "fnm" });
      yield* TestClock.adjust("1 minute");
      assert.equal(write.mock.calls.length, 0);
      assert.deepEqual(yield* Queue.takeAll(outputLines), ["Missing Node.", "Install it? [y/N]:"]);
      yield* emit({ ...event, type: "activity", hasRunningSubprocess: false, label: "zsh" });
      yield* emit({ ...event, type: "output", data: "\r\n% \x1b[?20" });
      assert.equal(write.mock.calls.length, 0);
      yield* emit({ ...event, type: "output", data: "04h" });
      yield* Queue.take(writes);
      assert.equal(write.mock.calls.length, 1);
      const sentinel = /__T3_SETUP_DONE___[a-f0-9]+:/u.exec(write.mock.calls[0]![0].data)?.[0];
      assert.ok(sentinel);
      yield* emit({ ...event, type: "output", data: `\r\n${sentinel}0\r\n% ` });
      assert.equal((yield* result.completion).exitCode, 0);
      assert.equal(closeIdle.mock.calls.length, 1);
      assert.equal(listeners.size, 0);
    }).pipe(Effect.provide(layer));
  }),
);

it.effect("rejects the deferred write when update drain activates during shell startup", () => {
  const { layer, projectId, write, emit, listeners } = makeAdmissionHarness({
    manualReadiness: true,
  });
  return Effect.gen(function* () {
    const runner = yield* ProjectSetupScriptRunner.ProjectSetupScriptRunner;
    const admission = yield* UpdateDrainAdmission.UpdateDrainAdmission;
    const result = yield* runner.runForThread({
      ...event,
      projectId,
      worktreePath: "/repo-worktree",
      observeCompletion: {},
    });
    if (result.status !== "started" || !result.completion)
      return yield* Effect.die("missing completion");
    yield* emit({ ...event, type: "activity", hasRunningSubprocess: true, label: "fnm" });
    yield* TestClock.adjust("1 minute");
    assert.equal(write.mock.calls.length, 0);
    yield* emit({ ...event, type: "activity", hasRunningSubprocess: false, label: "zsh" });
    yield* admission.dispatch(startDrain);
    yield* admission.claimActivation({ requestId: startDrain.requestId });
    yield* emit({ ...event, type: "output", data: "\x1b[?2004h" });
    assert.equal((yield* result.completion).exitCode, null);
    yield* TestClock.adjust("1 minute");
    assert.equal(write.mock.calls.length, 0);
    assert.equal(listeners.size, 0);
  }).pipe(Effect.provide(layer));
});

it.effect("types into a quiet shell without trusting restored line editor history", () =>
  Effect.gen(function* () {
    const written = yield* Deferred.make<void>();
    const { layer, projectId, write } = makeAdmissionHarness({
      manualReadiness: true,
      history: "old run\r\n% \x1b[?2004h",
      writeEffect: Deferred.succeed(written, undefined).pipe(Effect.asVoid),
    });
    yield* Effect.gen(function* () {
      const runner = yield* ProjectSetupScriptRunner.ProjectSetupScriptRunner;
      yield* runner.runForThread({ ...event, projectId, worktreePath: "/repo-worktree" });
      assert.equal(write.mock.calls.length, 0);
      yield* TestClock.adjust("3 seconds");
      yield* Deferred.await(written);
      assert.equal(write.mock.calls.length, 1);
    }).pipe(Effect.provide(layer));
  }),
);

it.effect("accepts foreground readiness while background output arrives during inspection", () =>
  Effect.gen(function* () {
    const inspecting = yield* Deferred.make<void>();
    const foreground = yield* Deferred.make<boolean>();
    const written = yield* Deferred.make<void>();
    const { layer, projectId, write, emit } = makeAdmissionHarness({
      manualReadiness: true,
      foregroundEffect: Deferred.succeed(inspecting, undefined).pipe(
        Effect.andThen(Deferred.await(foreground)),
      ),
      writeEffect: Deferred.succeed(written, undefined).pipe(Effect.asVoid),
    });
    yield* Effect.gen(function* () {
      const runner = yield* ProjectSetupScriptRunner.ProjectSetupScriptRunner;
      yield* runner.runForThread({ ...event, projectId, worktreePath: "/repo-worktree" });
      yield* TestClock.adjust("3 seconds");
      yield* Deferred.await(inspecting);
      yield* emit({ ...event, type: "output", data: "background log\r\n" });
      yield* Deferred.succeed(foreground, false);
      yield* Deferred.await(written);
      assert.equal(write.mock.calls.length, 1);
    }).pipe(Effect.provide(layer));
  }),
);

it.effect.each(["restart", "activity", "editor"] as const)(
  "discards a foreground result invalidated by %s while inspection is pending",
  (change) =>
    Effect.gen(function* () {
      const inspecting = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const written = yield* Deferred.make<void>();
      let first = true;
      const { layer, projectId, write, emit, terminalSnapshot, open } = makeAdmissionHarness({
        manualReadiness: true,
        foregroundEffect: Effect.suspend(() => {
          if (!first) return Effect.succeed(true);
          first = false;
          return Deferred.succeed(inspecting, undefined).pipe(
            Effect.andThen(Deferred.await(release)),
            Effect.as(false),
          );
        }),
        writeEffect: Deferred.succeed(written, undefined).pipe(Effect.asVoid),
      });
      yield* Effect.gen(function* () {
        const runner = yield* ProjectSetupScriptRunner.ProjectSetupScriptRunner;
        yield* runner.runForThread({ ...event, projectId, worktreePath: "/repo-worktree" });
        yield* TestClock.adjust("3 seconds");
        yield* Deferred.await(inspecting);
        yield* emit(
          change === "restart"
            ? { ...event, type: "restarted", snapshot: terminalSnapshot(open.mock.calls[0]![0]) }
            : change === "activity"
              ? { ...event, type: "activity", hasRunningSubprocess: true, label: "fnm" }
              : { ...event, type: "output", data: "\x1b[?2004l" },
        );
        yield* Deferred.succeed(release, undefined);
        yield* TestClock.adjust("3 seconds");
        assert.equal(write.mock.calls.length, 0);
        yield* emit({ ...event, type: "output", data: "\x1b[?2004h" });
        yield* Deferred.await(written);
        assert.equal(write.mock.calls.length, 1);
      }).pipe(Effect.provide(layer));
    }),
);

it.effect("does not type into a shell that exits during startup", () => {
  const { layer, projectId, write, emit, listeners } = makeAdmissionHarness({
    manualReadiness: true,
  });
  return Effect.gen(function* () {
    const runner = yield* ProjectSetupScriptRunner.ProjectSetupScriptRunner;
    const result = yield* runner.runForThread({
      ...event,
      projectId,
      worktreePath: "/repo-worktree",
      observeCompletion: {},
    });
    if (result.status !== "started" || !result.completion)
      return yield* Effect.die("missing completion");
    yield* emit({ ...event, type: "exited", exitCode: 1, exitSignal: null });
    assert.equal((yield* result.completion).exitCode, null);
    yield* TestClock.adjust("1 minute");
    assert.equal(write.mock.calls.length, 0);
    assert.equal(listeners.size, 0);
  }).pipe(Effect.provide(layer));
});

it.effect("drops terminal listeners when cancelled while the terminal opens", () =>
  Effect.gen(function* () {
    const opening = yield* Deferred.make<void>();
    const { layer, projectId, listeners } = makeAdmissionHarness({ opening });
    yield* Effect.gen(function* () {
      const runner = yield* ProjectSetupScriptRunner.ProjectSetupScriptRunner;
      const fiber = yield* runner
        .runForThread({
          ...event,
          projectId,
          worktreePath: "/repo-worktree",
          observeCompletion: {},
        })
        .pipe(Effect.forkChild);
      yield* Deferred.await(opening);
      assert.equal(listeners.size, 1);
      yield* Fiber.interrupt(fiber);
      assert.equal(listeners.size, 0);
    }).pipe(Effect.provide(layer));
  }),
);

it.effect("forgets a busy startup child when the shell restarts", () =>
  Effect.gen(function* () {
    const written = yield* Deferred.make<void>();
    const { layer, projectId, write, emit, open, terminalSnapshot } = makeAdmissionHarness({
      manualReadiness: true,
      history: "old run\r\n% \x1b[?2004h",
      writeEffect: Deferred.succeed(written, undefined).pipe(Effect.asVoid),
    });
    yield* Effect.gen(function* () {
      const runner = yield* ProjectSetupScriptRunner.ProjectSetupScriptRunner;
      yield* runner.runForThread({ ...event, projectId, worktreePath: "/repo-worktree" });
      yield* emit({ ...event, type: "activity", hasRunningSubprocess: true, label: "fnm" });
      yield* TestClock.adjust("1 minute");
      assert.equal(write.mock.calls.length, 0);
      const snapshot = terminalSnapshot(open.mock.calls[0]![0]);
      yield* emit({ ...event, type: "restarted", snapshot });
      yield* TestClock.adjust("6 seconds");
      yield* Deferred.await(written);
      assert.equal(write.mock.calls.length, 1);
    }).pipe(Effect.provide(layer));
  }),
);

it.effect("abandons pending completion and removes listeners when its service stops", () => {
  const { layer, projectId, write, listeners } = makeAdmissionHarness({ manualReadiness: true });
  return Effect.gen(function* () {
    const result = yield* Effect.gen(function* () {
      const runner = yield* ProjectSetupScriptRunner.ProjectSetupScriptRunner;
      return yield* runner.runForThread({
        ...event,
        projectId,
        worktreePath: "/repo-worktree",
        observeCompletion: {},
      });
    }).pipe(Effect.provide(layer));
    if (result.status !== "started" || !result.completion)
      return yield* Effect.die("missing completion");
    assert.equal((yield* result.completion).exitCode, null);
    assert.equal(listeners.size, 0);
    assert.equal(write.mock.calls.length, 0);
  });
});

it.effect("abandons a pending setup when a new run replaces its terminal launch context", () =>
  Effect.gen(function* () {
    const written = yield* Deferred.make<void>();
    const { layer, projectId, write, emit, listeners, project } = makeAdmissionHarness({
      manualReadiness: true,
      terminalLinkProfileName: "First profile",
      writeEffect: Deferred.succeed(written, undefined).pipe(Effect.asVoid),
    });
    yield* Effect.gen(function* () {
      const runner = yield* ProjectSetupScriptRunner.ProjectSetupScriptRunner;
      const first = yield* runner.runForThread({
        ...event,
        projectId,
        worktreePath: "/first-worktree",
        observeCompletion: {},
      });
      const script = project.scripts[0]!;
      if ("terminalLinkProfileName" in script) script.terminalLinkProfileName = "Second profile";
      const second = yield* runner.runForThread({
        ...event,
        projectId,
        worktreePath: "/second-worktree",
        observeCompletion: {},
      });
      if (
        first.status !== "started" ||
        !first.completion ||
        second.status !== "started" ||
        !second.completion
      )
        return yield* Effect.die("missing completion");
      yield* emit({ ...event, type: "output", data: "\x1b[?2004h" });
      yield* Deferred.await(written);
      yield* TestClock.adjust("3 seconds");
      assert.equal(write.mock.calls.length, 1);
      assert.equal((yield* first.completion).exitCode, null);
      const sentinel = /__T3_SETUP_DONE___[a-f0-9]+:/u.exec(write.mock.calls[0]![0].data)?.[0];
      assert.ok(sentinel);
      yield* emit({ ...event, type: "output", data: `\r\n${sentinel}0\r\n% ` });
      assert.equal((yield* second.completion).exitCode, 0);
      assert.equal(listeners.size, 0);
    }).pipe(Effect.provide(layer));
  }),
);

it.effect("keeps a reused terminal busy without requiring another activity transition", () =>
  Effect.gen(function* () {
    const written = yield* Deferred.make<void>();
    const { layer, projectId, write, emit } = makeAdmissionHarness({
      manualReadiness: true,
      writeEffect: Deferred.succeed(written, undefined).pipe(Effect.asVoid),
    });
    yield* Effect.gen(function* () {
      const runner = yield* ProjectSetupScriptRunner.ProjectSetupScriptRunner;
      const input = { ...event, projectId, worktreePath: "/repo-worktree", observeCompletion: {} };
      yield* runner.runForThread(input);
      yield* emit({ ...event, type: "activity", hasRunningSubprocess: true, label: "fnm" });
      yield* TestClock.adjust("1 minute");
      const retry = yield* runner.runForThread(input);
      yield* TestClock.adjust("1 minute");
      assert.equal(write.mock.calls.length, 0);
      yield* emit({ ...event, type: "activity", hasRunningSubprocess: false, label: "zsh" });
      yield* emit({ ...event, type: "output", data: "\x1b[?2004h" });
      yield* Deferred.await(written);
      assert.equal(write.mock.calls.length, 1);
      if (retry.status !== "started" || !retry.completion)
        return yield* Effect.die("missing completion");
      yield* emit({ ...event, type: "closed", deleteHistory: false });
      assert.equal((yield* retry.completion).exitCode, null);
    }).pipe(Effect.provide(layer));
  }),
);

it.effect("discards old readiness and exit signals while opening a replacement shell", () =>
  Effect.gen(function* () {
    const written = yield* Deferred.make<void>();
    const { layer, projectId, write, emit } = makeAdmissionHarness({
      manualReadiness: true,
      replacementEvents: [
        { ...event, type: "output", data: "\x1b[?2004h" },
        { ...event, type: "exited", exitCode: 0, exitSignal: null },
      ],
      writeEffect: Deferred.succeed(written, undefined).pipe(Effect.asVoid),
    });
    yield* Effect.gen(function* () {
      const runner = yield* ProjectSetupScriptRunner.ProjectSetupScriptRunner;
      yield* runner.runForThread({
        ...event,
        projectId,
        worktreePath: "/first-worktree",
        observeCompletion: {},
      });
      const replacement = yield* runner.runForThread({
        ...event,
        projectId,
        worktreePath: "/replacement-worktree",
        observeCompletion: {},
      });
      yield* TestClock.adjust("1 second");
      assert.equal(write.mock.calls.length, 0);
      yield* emit({ ...event, type: "activity", hasRunningSubprocess: true, label: "fnm" });
      yield* TestClock.adjust("1 minute");
      assert.equal(write.mock.calls.length, 0);
      yield* emit({ ...event, type: "activity", hasRunningSubprocess: false, label: "zsh" });
      yield* emit({ ...event, type: "output", data: "\x1b[?2004h" });
      yield* Deferred.await(written);
      assert.equal(write.mock.calls.length, 1);
      if (replacement.status !== "started" || !replacement.completion)
        return yield* Effect.die("missing completion");
      const sentinel = /__T3_SETUP_DONE___[a-f0-9]+:/u.exec(write.mock.calls[0]![0].data)?.[0];
      assert.ok(sentinel);
      yield* emit({ ...event, type: "output", data: `\r\n${sentinel}0\r\n% ` });
      assert.equal((yield* replacement.completion).exitCode, 0);
    }).pipe(Effect.provide(layer));
  }),
);

it.effect("does not let a terminating predecessor keep an idle reused shell waiting", () => {
  const { layer, projectId, write } = makeAdmissionHarness({
    manualReadiness: true,
    terminatingPreviousShell: true,
  });
  return Effect.gen(function* () {
    const runner = yield* ProjectSetupScriptRunner.ProjectSetupScriptRunner;
    const input = { ...event, projectId, worktreePath: "/repo-worktree" };
    yield* runner.runForThread(input);
    yield* runner.runForThread(input);
    yield* TestClock.adjust("3 seconds");
    assert.equal(write.mock.calls.length, 1);
  }).pipe(Effect.provide(layer));
});
