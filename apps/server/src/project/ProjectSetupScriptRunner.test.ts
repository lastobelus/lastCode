import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { assert, it, vi } from "@effect/vitest";
import {
  CommandId,
  ProjectId,
  UpdateDrainRequestId,
  UpdateDrainTargetVersion,
} from "@t3tools/contracts";
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
    readonly writeEffect?: Effect.Effect<void>;
    readonly terminalLinkProfileName?: string;
  } = {},
) {
  const open = vi.fn((input: Parameters<TerminalManager.TerminalManager["Service"]["open"]>[0]) =>
    Effect.succeed({
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
  );
  const write = vi.fn(
    (_input: Parameters<TerminalManager.TerminalManager["Service"]["write"]>[0]) =>
      options.writeEffect ?? Effect.void,
  );
  const closeIdle = vi.fn(
    (_input: Parameters<TerminalManager.TerminalManager["Service"]["closeIdle"]>[0]) => Effect.void,
  );
  const listeners: Array<Parameters<TerminalManager.TerminalManager["Service"]["subscribe"]>[0]> =
    [];
  const subscribe: TerminalManager.TerminalManager["Service"]["subscribe"] = (listener) =>
    Effect.sync(() => {
      listeners.push(listener);
      return () => undefined;
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
  );

  return { layer, open, write, listeners, projectId, closeIdle, project };
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
    assert.equal(listeners.length, 0);
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
      assert.equal(listeners.length, 1);
      const close = yield* admission.dispatch(startDrain).pipe(
        Effect.tap(() => append("drain-closed")),
        Effect.forkChild,
      );
      yield* Effect.yieldNow;
      assert.deepEqual(yield* Ref.get(timeline), []);
      yield* Deferred.succeed(releaseWrite, undefined);
      const started = yield* Fiber.join(setup);
      yield* Fiber.join(close);
      assert.deepEqual(yield* Ref.get(timeline), ["command-written", "drain-closed"]);
      assert.equal(started.status, "started");
      if (started.status !== "started") return;
      assert.ok(started.completion);
      yield* listeners[0]!({
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
