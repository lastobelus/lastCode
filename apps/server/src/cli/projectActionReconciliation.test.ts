import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import {
  markManagedProjectActionPendingStateApplied,
  prepareManagedProjectActionPendingState,
  reconcileProjectActions,
  resolveManagedProjectActionPendingState,
} from "./projectActionReconciliation.ts";

const waitDeclaration = {
  id: "lc-wait-for-pr",
  name: "Wait for PR",
  command: "mise exec node@24.13.1 -- node scripts/lastcode-wait-for-pr.ts",
  icon: "test" as const,
};

const quickDeclaration = {
  id: "lc-local-ci",
  name: "Run Quick CI",
  command: "mise exec node@24.13.1 -- node scripts/lastcode-local-ci.ts --quick",
  icon: "test" as const,
};

it.effect("rejects a managed declaration without an explicit stable id", () =>
  reconcileProjectActions({
    projectWorkspaceRoot: "/srv/example/lastCode",
    currentScripts: [],
    declarations: [{ name: "Wait for PR", command: waitDeclaration.command }],
  }).pipe(
    Effect.flip,
    Effect.tap((error) => Effect.sync(() => assert.equal(error.reason, "missing_source_id"))),
  ),
);

it.effect("recovers all managed fields and grant provenance around an interrupted update", () =>
  Effect.gen(function* () {
    const initial = yield* reconcileProjectActions({
      projectWorkspaceRoot: "/srv/example/lastCode",
      currentScripts: [],
      declarations: [waitDeclaration],
    });
    const changedDeclaration = {
      ...waitDeclaration,
      name: "Wait for Pull Request",
      command: "node scripts/renamed-wait-command.ts",
      icon: "build" as const,
    };
    const changed = yield* reconcileProjectActions({
      projectWorkspaceRoot: "/srv/example/lastCode",
      currentScripts: initial.scripts,
      declarations: [changedDeclaration],
      previousState: initial.state,
      trustedSourceIds: new Set(["lc-wait-for-pr"]),
    });
    const pending = prepareManagedProjectActionPendingState({
      projectWorkspaceRoot: "/srv/example/lastCode",
      previousState: initial.state,
      nextScripts: changed.scripts,
      nextState: changed.state,
    });

    for (const currentScripts of [initial.scripts, changed.scripts]) {
      const recoveredState = resolveManagedProjectActionPendingState({
        state: pending,
        currentScripts,
      });
      const recovered = yield* reconcileProjectActions({
        projectWorkspaceRoot: "/srv/example/lastCode",
        currentScripts,
        declarations: [changedDeclaration],
        previousState: recoveredState,
        trustedSourceIds: new Set(["lc-wait-for-pr"]),
      });
      assert.deepEqual(recovered.report.diverged, []);
      assert.equal(recovered.scripts[0]?.command, changedDeclaration.command);
      assert.isTrue(recovered.scripts[0]?.allowAgentResume);
      assert.isTrue(recovered.state.actions[0]?.managesResumePermission);
    }
  }),
);

it.effect("preserves a local permission re-granted after a managed revocation", () =>
  Effect.gen(function* () {
    const trusted = yield* reconcileProjectActions({
      projectWorkspaceRoot: "/srv/example/lastCode",
      currentScripts: [],
      declarations: [waitDeclaration],
      trustedSourceIds: new Set(["lc-wait-for-pr"]),
    });
    const revoked = yield* reconcileProjectActions({
      projectWorkspaceRoot: "/srv/example/lastCode",
      currentScripts: trusted.scripts,
      declarations: [waitDeclaration],
      previousState: trusted.state,
    });
    const applied = markManagedProjectActionPendingStateApplied(
      prepareManagedProjectActionPendingState({
        projectWorkspaceRoot: "/srv/example/lastCode",
        previousState: trusted.state,
        nextScripts: revoked.scripts,
        nextState: revoked.state,
      }),
    );
    const locallyRegranted = revoked.scripts.map((script) => ({
      ...script,
      allowAgentResume: true,
    }));
    const recoveredState = resolveManagedProjectActionPendingState({
      state: applied,
      currentScripts: locallyRegranted,
    });
    const recovered = yield* reconcileProjectActions({
      projectWorkspaceRoot: "/srv/example/lastCode",
      currentScripts: locallyRegranted,
      declarations: [waitDeclaration],
      previousState: recoveredState,
    });

    assert.isTrue(recovered.scripts[0]?.allowAgentResume);
    assert.isFalse(recovered.state.actions[0]?.managesResumePermission);
  }),
);

it.effect("creates non-setup Actions without granting agent resume", () =>
  Effect.gen(function* () {
    const result = yield* reconcileProjectActions({
      projectWorkspaceRoot: "/srv/example/lastCode",
      currentScripts: [],
      declarations: [
        {
          name: "Setup Worktree",
          command: "vp install",
          icon: "configure",
          runOnWorktreeCreate: true,
        },
        waitDeclaration,
        quickDeclaration,
      ],
    });

    assert.deepEqual(
      result.scripts.map(({ id, name, allowAgentResume }) => ({ id, name, allowAgentResume })),
      [
        { id: "lc-wait-for-pr", name: "Wait for PR", allowAgentResume: undefined },
        { id: "lc-local-ci", name: "Run Quick CI", allowAgentResume: undefined },
      ],
    );
    assert.deepEqual(result.report.created, ["lc-wait-for-pr", "lc-local-ci"]);
  }),
);

it.effect("is idempotent once saved scripts and ownership state match", () =>
  Effect.gen(function* () {
    const first = yield* reconcileProjectActions({
      projectWorkspaceRoot: "/srv/example/lastCode",
      currentScripts: [],
      declarations: [waitDeclaration, quickDeclaration],
    });
    const second = yield* reconcileProjectActions({
      projectWorkspaceRoot: "/srv/example/lastCode",
      currentScripts: first.scripts,
      declarations: [waitDeclaration, quickDeclaration],
      previousState: first.state,
    });

    assert.deepEqual(second.scripts, first.scripts);
    assert.deepEqual(second.state, first.state);
    assert.deepEqual(second.report, {
      created: [],
      updated: [],
      removed: [],
      adopted: [],
      diverged: [],
    });
  }),
);

it.effect("adopts an exact legacy import and preserves its id and local permission", () =>
  Effect.gen(function* () {
    const result = yield* reconcileProjectActions({
      projectWorkspaceRoot: "/srv/example/lastCode",
      currentScripts: [
        {
          id: "wait-for-pr",
          name: "Wait for PR",
          command: waitDeclaration.command,
          icon: "test",
          runOnWorktreeCreate: false,
          allowAgentResume: true,
        },
      ],
      declarations: [waitDeclaration],
    });

    assert.equal(result.scripts[0]?.id, "wait-for-pr");
    assert.isTrue(result.scripts[0]?.allowAgentResume);
    assert.deepEqual(result.report.adopted, ["lc-wait-for-pr"]);
    assert.equal(result.state.actions[0]?.scriptId, "wait-for-pr");
  }),
);

it.effect("reserves existing ownership before adopting a legacy match", () =>
  Effect.gen(function* () {
    const initial = yield* reconcileProjectActions({
      projectWorkspaceRoot: "/srv/example/lastCode",
      currentScripts: [],
      declarations: [waitDeclaration],
    });
    const duplicateDeclaration = {
      ...waitDeclaration,
      id: "lc-new-duplicate",
    };
    const result = yield* reconcileProjectActions({
      projectWorkspaceRoot: "/srv/example/lastCode",
      currentScripts: initial.scripts,
      declarations: [duplicateDeclaration, waitDeclaration],
      previousState: initial.state,
    });

    assert.deepEqual(
      result.state.actions.map(({ sourceId, scriptId }) => ({ sourceId, scriptId })),
      [
        { sourceId: "lc-new-duplicate", scriptId: "lc-new-duplicate" },
        { sourceId: "lc-wait-for-pr", scriptId: "lc-wait-for-pr" },
      ],
    );
    assert.deepEqual(
      result.scripts.map((script) => script.id),
      ["lc-wait-for-pr", "lc-new-duplicate"],
    );
    assert.deepEqual(result.report.created, ["lc-new-duplicate"]);
    assert.deepEqual(result.report.adopted, []);
  }),
);

it.effect("rejects a deterministic id already owned by another declaration", () =>
  Effect.gen(function* () {
    const initial = yield* reconcileProjectActions({
      projectWorkspaceRoot: "/srv/example/lastCode",
      currentScripts: [
        { ...waitDeclaration, id: "lc-new-declaration", runOnWorktreeCreate: false },
      ],
      declarations: [waitDeclaration],
    });

    const error = yield* reconcileProjectActions({
      projectWorkspaceRoot: "/srv/example/lastCode",
      currentScripts: initial.scripts,
      declarations: [{ ...waitDeclaration, id: "lc-new-declaration" }, waitDeclaration],
      previousState: initial.state,
    }).pipe(Effect.flip);

    assert.equal(error.reason, "source_id_ownership_conflict");
  }),
);

it.effect("rejects recreation with an id reserved by a missing managed Action", () =>
  Effect.gen(function* () {
    const initial = yield* reconcileProjectActions({
      projectWorkspaceRoot: "/srv/example/lastCode",
      currentScripts: [{ ...waitDeclaration, id: "lc-reserved", runOnWorktreeCreate: false }],
      declarations: [waitDeclaration],
    });

    const error = yield* reconcileProjectActions({
      projectWorkspaceRoot: "/srv/example/lastCode",
      currentScripts: [],
      declarations: [{ ...waitDeclaration, id: "lc-reserved" }, waitDeclaration],
      previousState: initial.state,
    }).pipe(Effect.flip);

    assert.equal(error.reason, "source_id_ownership_conflict");
  }),
);

it.effect("updates managed fields while preserving local-only state", () =>
  Effect.gen(function* () {
    const first = yield* reconcileProjectActions({
      projectWorkspaceRoot: "/srv/example/lastCode",
      currentScripts: [
        {
          id: "legacy-action-id",
          name: "Wait for PR",
          command: waitDeclaration.command,
          icon: "test",
          runOnWorktreeCreate: false,
          allowAgentResume: true,
        },
      ],
      declarations: [waitDeclaration],
    });
    const second = yield* reconcileProjectActions({
      projectWorkspaceRoot: "/srv/example/lastCode",
      currentScripts: first.scripts,
      declarations: [
        {
          ...waitDeclaration,
          name: "Wait for Pull Request",
          command: `${waitDeclaration.command} --verbose`,
          icon: "build",
        },
      ],
      previousState: first.state,
    });

    assert.deepEqual(second.scripts, [
      {
        id: "legacy-action-id",
        name: "Wait for Pull Request",
        command: `${waitDeclaration.command} --verbose`,
        icon: "build",
        runOnWorktreeCreate: false,
        allowAgentResume: true,
      },
    ]);
    assert.deepEqual(second.report.updated, ["lc-wait-for-pr"]);
  }),
);

it.effect("retains locally diverged and removed Actions", () =>
  Effect.gen(function* () {
    const first = yield* reconcileProjectActions({
      projectWorkspaceRoot: "/srv/example/lastCode",
      currentScripts: [],
      declarations: [waitDeclaration],
    });
    const diverged = first.scripts.map((script) => ({ ...script, command: "local command" }));
    const second = yield* reconcileProjectActions({
      projectWorkspaceRoot: "/srv/example/lastCode",
      currentScripts: diverged,
      declarations: [],
      previousState: first.state,
    });

    assert.deepEqual(second.scripts, diverged);
    assert.deepEqual(second.report.diverged, ["lc-wait-for-pr"]);
    assert.equal(second.state.actions.length, 1);
  }),
);

it.effect("removes an undeclared Action only while it still matches managed state", () =>
  Effect.gen(function* () {
    const first = yield* reconcileProjectActions({
      projectWorkspaceRoot: "/srv/example/lastCode",
      currentScripts: [],
      declarations: [waitDeclaration],
    });
    const second = yield* reconcileProjectActions({
      projectWorkspaceRoot: "/srv/example/lastCode",
      currentScripts: first.scripts,
      declarations: [],
      previousState: first.state,
    });

    assert.deepEqual(second.scripts, []);
    assert.deepEqual(second.report.removed, ["lc-wait-for-pr"]);
    assert.equal(second.state.actions.length, 0);
  }),
);

it.effect("applies and revokes only environment-managed trust grants", () =>
  Effect.gen(function* () {
    const trusted = yield* reconcileProjectActions({
      projectWorkspaceRoot: "/srv/example/lastCode",
      currentScripts: [],
      declarations: [waitDeclaration],
      trustedSourceIds: new Set(["lc-wait-for-pr"]),
    });
    assert.isTrue(trusted.scripts[0]?.allowAgentResume);
    assert.isTrue(trusted.state.actions[0]?.managesResumePermission);

    const revoked = yield* reconcileProjectActions({
      projectWorkspaceRoot: "/srv/example/lastCode",
      currentScripts: trusted.scripts,
      declarations: [waitDeclaration],
      previousState: trusted.state,
    });
    assert.isUndefined(revoked.scripts[0]?.allowAgentResume);
    assert.isFalse(revoked.state.actions[0]?.managesResumePermission);

    const locallyTrusted = yield* reconcileProjectActions({
      projectWorkspaceRoot: "/srv/example/lastCode",
      currentScripts: revoked.scripts.map((script) => ({ ...script, allowAgentResume: true })),
      declarations: [waitDeclaration],
      previousState: revoked.state,
    });
    assert.isTrue(locallyTrusted.scripts[0]?.allowAgentResume);
    assert.isFalse(locallyTrusted.state.actions[0]?.managesResumePermission);
  }),
);

it.effect("does not claim a pre-existing local trust grant", () =>
  Effect.gen(function* () {
    const local = yield* reconcileProjectActions({
      projectWorkspaceRoot: "/srv/example/lastCode",
      currentScripts: [
        {
          id: "wait-for-pr",
          name: "Wait for PR",
          command: waitDeclaration.command,
          icon: "test",
          runOnWorktreeCreate: false,
          allowAgentResume: true,
        },
      ],
      declarations: [waitDeclaration],
      trustedSourceIds: new Set(["lc-wait-for-pr"]),
    });
    assert.isTrue(local.scripts[0]?.allowAgentResume);
    assert.isFalse(local.state.actions[0]?.managesResumePermission);

    const allowlistRemoved = yield* reconcileProjectActions({
      projectWorkspaceRoot: "/srv/example/lastCode",
      currentScripts: local.scripts,
      declarations: [waitDeclaration],
      previousState: local.state,
    });
    assert.isTrue(allowlistRemoved.scripts[0]?.allowAgentResume);
  }),
);

it.effect("revokes a managed trust grant from divergent fields even while allowlisted", () =>
  Effect.gen(function* () {
    const trusted = yield* reconcileProjectActions({
      projectWorkspaceRoot: "/srv/example/lastCode",
      currentScripts: [],
      declarations: [waitDeclaration],
      trustedSourceIds: new Set(["lc-wait-for-pr"]),
    });
    const divergent = trusted.scripts.map((script) => ({
      ...script,
      command: "local command",
    }));

    const reconciled = yield* reconcileProjectActions({
      projectWorkspaceRoot: "/srv/example/lastCode",
      currentScripts: divergent,
      declarations: [waitDeclaration],
      previousState: trusted.state,
      trustedSourceIds: new Set(["lc-wait-for-pr"]),
    });

    assert.equal(reconciled.scripts[0]?.command, "local command");
    assert.isUndefined(reconciled.scripts[0]?.allowAgentResume);
    assert.isFalse(reconciled.state.actions[0]?.managesResumePermission);
    assert.deepEqual(reconciled.report.diverged, ["lc-wait-for-pr"]);
    assert.deepEqual(reconciled.report.updated, ["lc-wait-for-pr"]);
  }),
);
