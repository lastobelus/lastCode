import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { assert, it, vi } from "@effect/vitest";
import {
  CommandId,
  ProjectId,
  type TerminalEvent,
  UpdateDrainRequestId,
  UpdateDrainTargetVersion,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { TestClock } from "effect/testing";
import * as Queue from "effect/Queue";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";

import * as EffectOutbox from "../orchestration-v2/EffectOutbox.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProviderSessionManager from "../orchestration-v2/ProviderSessionManager.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as UpdateDrainRepositoryPersistence from "../persistence/UpdateDrainRepository.ts";
import * as TerminalManager from "../terminal/Manager.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as UpdateDrain from "../updateDrain/UpdateDrain.ts";
import * as UpdateDrainAdmission from "../updateDrain/UpdateDrainAdmission.ts";
import * as ProjectService from "./ProjectService.ts";
import * as ProjectSetupScriptRunner from "./ProjectSetupScriptRunner.ts";

const startDrain = {
  type: "update-drain.start" as const,
  commandId: CommandId.make("close-setup-admission"),
  requestId: UpdateDrainRequestId.make("setup-update"),
  targetVersion: UpdateDrainTargetVersion.make("1.2.3"),
  createdAt: "2026-06-20T00:00:00.000Z",
};

function makeHarness(
  options: {
    readonly setupScript?: boolean;
    readonly manualReadiness?: boolean;
    readonly history?: string;
    readonly opening?: Deferred.Deferred<void>;
    readonly replacementEvents?: ReadonlyArray<TerminalEvent>;
    readonly terminatingPreviousShell?: boolean;
    readonly writeEffect?: Effect.Effect<void>;
    readonly terminalLinkProfileName?: string;
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
          getById: () => Effect.succeed(Option.some(project)),
        }),
        Layer.mock(TerminalManager.TerminalManager)({
          open,
          write,
          subscribe,
          closeIdle,
          refreshMetadata: Effect.succeed([]),
          hasForegroundSubprocess: () => Effect.sync(() => busy),
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

it.effect("rejects setup before opening a terminal while update admission is closed", () => {
  const { layer, open, write, listeners, projectId } = makeHarness();
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
  const { layer, open, write, projectId } = makeHarness({ setupScript: false });
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
    const timeline = yield* Ref.make<ReadonlyArray<string>>([]);
    const append = (entry: string) => Ref.update(timeline, (entries) => [...entries, entry]);
    const { layer, listeners, projectId } = makeHarness({
      writeEffect: Deferred.succeed(writing, undefined).pipe(
        Effect.andThen(Deferred.await(releaseWrite)),
        Effect.andThen(append("command-written")),
      ),
    });
    yield* Effect.gen(function* () {
      const runner = yield* ProjectSetupScriptRunner.ProjectSetupScriptRunner;
      const admission = yield* UpdateDrainAdmission.UpdateDrainAdmission;
      const setup = yield* runner
        .runForThread({
          threadId: "thread-1",
          projectId,
          worktreePath: "/repo-worktree",
          observeCompletion: {},
        })
        .pipe(Effect.forkChild);
      yield* Deferred.await(writing);
      assert.equal(listeners.size, 1);
      const close = yield* admission.dispatch(startDrain).pipe(
        Effect.tap(() => append("drain-closed")),
        Effect.forkChild,
      );
      assert.deepEqual(yield* Ref.get(timeline), []);
      yield* Deferred.succeed(releaseWrite, undefined);
      const started = yield* Fiber.join(setup);
      yield* Fiber.join(close);
      assert.deepEqual(yield* Ref.get(timeline), ["command-written", "drain-closed"]);
      assert.equal(started.status, "started");
      if (started.status !== "started") return;
      assert.ok(started.completion);
      yield* [...listeners][0]!({
        type: "closed",
        threadId: "thread-1",
        terminalId: "setup-setup",
        deleteHistory: false,
      });
      assert.equal((yield* started.completion).exitCode, null);
    }).pipe(Effect.provide(layer));
  }),
);

it.effect("preserves an opted-in setup Action's profile in its own terminal", () => {
  const { layer, open, projectId } = makeHarness({ terminalLinkProfileName: "Work account" });
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
  const { layer, open, projectId, project } = makeHarness({
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

const event = {
  threadId: "thread-1",
  terminalId: "setup-setup",
  sequence: 1,
  createdAt: "2026-01-01T00:00:00.000Z",
};

it.effect("shows a startup prompt and types only once the line editor starts", () =>
  Effect.gen(function* () {
    const writes = yield* Queue.unbounded<string>();
    const outputLines = yield* Queue.unbounded<string>();
    const { layer, projectId, write, closeIdle, emit, listeners } = makeHarness({
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
  const { layer, projectId, write, emit, listeners } = makeHarness({ manualReadiness: true });
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
    const { layer, projectId, write } = makeHarness({
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

it.effect("does not type into a shell that exits during startup", () => {
  const { layer, projectId, write, emit, listeners } = makeHarness({ manualReadiness: true });
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
    const { layer, projectId, listeners } = makeHarness({ opening });
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
    const { layer, projectId, write, emit, open, terminalSnapshot } = makeHarness({
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
  const { layer, projectId, write, listeners } = makeHarness({ manualReadiness: true });
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
    const { layer, projectId, write, emit, listeners, project } = makeHarness({
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
    const { layer, projectId, write, emit } = makeHarness({
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
    const { layer, projectId, write, emit } = makeHarness({
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
  const { layer, projectId, write } = makeHarness({
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
