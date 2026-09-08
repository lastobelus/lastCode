import { ProjectScript, type T3ProjectFileScript } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

const ManagedProjectActionFields = Schema.Struct({
  name: Schema.String,
  command: Schema.String,
  icon: Schema.Literals(["play", "test", "lint", "configure", "build", "debug"]),
  runOnWorktreeCreate: Schema.Boolean,
  previewUrl: Schema.optional(Schema.String),
  autoOpenPreview: Schema.optional(Schema.Boolean),
});
type ManagedProjectActionFields = typeof ManagedProjectActionFields.Type;

const ManagedProjectActionOwnership = Schema.Struct({
  sourceId: Schema.String,
  scriptId: Schema.String,
  lastManaged: ManagedProjectActionFields,
  managesResumePermission: Schema.Boolean,
});

const ManagedProjectActionPendingUpdate = Schema.Struct({
  scripts: Schema.Array(ProjectScript),
  actions: Schema.Array(ManagedProjectActionOwnership),
  applied: Schema.Boolean,
});

export const ManagedProjectActionState = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  projectWorkspaceRoot: Schema.String,
  actions: Schema.Array(ManagedProjectActionOwnership),
  pending: Schema.optional(ManagedProjectActionPendingUpdate),
});
export type ManagedProjectActionState = typeof ManagedProjectActionState.Type;

export class ProjectActionReconciliationError extends Schema.TaggedErrorClass<ProjectActionReconciliationError>()(
  "ProjectActionReconciliationError",
  {
    reason: Schema.Literals([
      "missing_source_id",
      "duplicate_source_id",
      "ambiguous_legacy_import",
      "source_id_ownership_conflict",
      "ownership_workspace_mismatch",
    ]),
    message: Schema.String,
  },
) {}

export interface ProjectActionReconciliationReport {
  readonly created: ReadonlyArray<string>;
  readonly updated: ReadonlyArray<string>;
  readonly removed: ReadonlyArray<string>;
  readonly adopted: ReadonlyArray<string>;
  readonly diverged: ReadonlyArray<string>;
}

export interface ProjectActionReconciliationResult {
  readonly scripts: ReadonlyArray<ProjectScript>;
  readonly state: ManagedProjectActionState;
  readonly report: ProjectActionReconciliationReport;
}

const sameScripts = (
  left: ReadonlyArray<ProjectScript>,
  right: ReadonlyArray<ProjectScript>,
): boolean => JSON.stringify(left) === JSON.stringify(right);

export const prepareManagedProjectActionPendingState = (input: {
  readonly projectWorkspaceRoot: string;
  readonly previousState?: ManagedProjectActionState;
  readonly nextScripts: ReadonlyArray<ProjectScript>;
  readonly nextState: ManagedProjectActionState;
}): ManagedProjectActionState => ({
  schemaVersion: 1,
  projectWorkspaceRoot: input.projectWorkspaceRoot,
  actions: input.previousState?.actions ?? [],
  pending: {
    scripts: Array.from(input.nextScripts),
    actions: Array.from(input.nextState.actions),
    applied: false,
  },
});

export const markManagedProjectActionPendingStateApplied = (
  state: ManagedProjectActionState,
): ManagedProjectActionState => ({
  ...state,
  ...(state.pending === undefined ? {} : { pending: { ...state.pending, applied: true } }),
});

export const resolveManagedProjectActionPendingState = (input: {
  readonly state: ManagedProjectActionState;
  readonly currentScripts: ReadonlyArray<ProjectScript>;
}): ManagedProjectActionState => ({
  schemaVersion: 1,
  projectWorkspaceRoot: input.state.projectWorkspaceRoot,
  actions:
    input.state.pending !== undefined &&
    (input.state.pending.applied || sameScripts(input.currentScripts, input.state.pending.scripts))
      ? input.state.pending.actions
      : input.state.actions,
});

const managedFieldsFromDeclaration = (
  declaration: T3ProjectFileScript,
): ManagedProjectActionFields => ({
  name: declaration.name,
  command: declaration.command,
  icon: declaration.icon ?? "play",
  runOnWorktreeCreate: false,
  ...(declaration.previewUrl === undefined
    ? {}
    : {
        previewUrl: declaration.previewUrl,
        autoOpenPreview: declaration.autoOpenPreview ?? false,
      }),
});

const managedFieldsFromScript = (script: ProjectScript): ManagedProjectActionFields => ({
  name: script.name,
  command: script.command,
  icon: script.icon,
  runOnWorktreeCreate: script.runOnWorktreeCreate,
  ...(script.previewUrl === undefined
    ? {}
    : {
        previewUrl: script.previewUrl,
        autoOpenPreview: script.autoOpenPreview ?? false,
      }),
});

const sameManagedFields = (
  left: ManagedProjectActionFields,
  right: ManagedProjectActionFields,
): boolean => JSON.stringify(left) === JSON.stringify(right);

const withManagedFields = (
  scriptId: string,
  managed: ManagedProjectActionFields,
  allowAgentResume: boolean,
): ProjectScript => ({
  id: scriptId,
  ...managed,
  ...(allowAgentResume ? { allowAgentResume: true } : {}),
});

const withResumePermission = (script: ProjectScript, allowAgentResume: boolean): ProjectScript => {
  const { allowAgentResume: _currentPermission, ...rest } = script;
  return {
    ...rest,
    ...(allowAgentResume ? { allowAgentResume: true } : {}),
  };
};

const reconcileResumePermission = (input: {
  readonly currentPermission: boolean;
  readonly managedPermission: boolean;
  readonly trusted: boolean;
  readonly mayAddManagedGrant: boolean;
}) => {
  if (!input.trusted) {
    return {
      allowAgentResume: input.managedPermission ? false : input.currentPermission,
      managesResumePermission: false,
    };
  }
  if (input.managedPermission) {
    return { allowAgentResume: true, managesResumePermission: true };
  }
  if (input.currentPermission) {
    return { allowAgentResume: true, managesResumePermission: false };
  }
  return input.mayAddManagedGrant
    ? { allowAgentResume: true, managesResumePermission: true }
    : { allowAgentResume: false, managesResumePermission: false };
};

const sameScript = (left: ProjectScript, right: ProjectScript): boolean =>
  JSON.stringify(left) === JSON.stringify(right);

export const reconcileProjectActions = Effect.fn("reconcileProjectActions")(function* (input: {
  readonly projectWorkspaceRoot: string;
  readonly currentScripts: ReadonlyArray<ProjectScript>;
  readonly declarations: ReadonlyArray<T3ProjectFileScript>;
  readonly previousState?: ManagedProjectActionState;
  readonly trustedSourceIds?: ReadonlySet<string>;
}) {
  if (
    input.previousState !== undefined &&
    input.previousState.projectWorkspaceRoot !== input.projectWorkspaceRoot
  ) {
    return yield* new ProjectActionReconciliationError({
      reason: "ownership_workspace_mismatch",
      message: "Managed Project Action ownership belongs to a different workspace.",
    });
  }

  const declarations = input.declarations.filter(
    (declaration) => declaration.runOnWorktreeCreate !== true,
  );
  const missingId = declarations.find((declaration) => declaration.id === undefined);
  if (missingId !== undefined) {
    return yield* new ProjectActionReconciliationError({
      reason: "missing_source_id",
      message: `Checked-in Action '${missingId.name}' needs a stable id before it can be reconciled.`,
    });
  }
  const desired = declarations.map((declaration) => ({
    sourceId: declaration.id!,
    managed: managedFieldsFromDeclaration(declaration),
  }));
  const seenSourceIds = new Set<string>();
  for (const entry of desired) {
    if (seenSourceIds.has(entry.sourceId)) {
      return yield* new ProjectActionReconciliationError({
        reason: "duplicate_source_id",
        message: `Multiple checked-in Actions resolve to '${entry.sourceId}'.`,
      });
    }
    seenSourceIds.add(entry.sourceId);
  }

  const trustedSourceIds = input.trustedSourceIds ?? new Set<string>();
  const previousRecords = new Map(
    (input.previousState?.actions ?? []).map((record) => [record.sourceId, record]),
  );
  const scripts = [...input.currentScripts];
  const claimedScriptIds = new Set(
    Array.from(previousRecords.values(), (record) => record.scriptId),
  );
  const nextRecords: ManagedProjectActionState["actions"][number][] = [];
  const report = {
    created: [] as string[],
    updated: [] as string[],
    removed: [] as string[],
    adopted: [] as string[],
    diverged: [] as string[],
  };

  const replaceScript = (scriptId: string, next: ProjectScript) => {
    const index = scripts.findIndex((script) => script.id === scriptId);
    if (index === -1) scripts.push(next);
    else scripts[index] = next;
  };

  for (const entry of desired) {
    const previous = previousRecords.get(entry.sourceId);
    const trusted = trustedSourceIds.has(entry.sourceId);

    if (previous !== undefined) {
      const current = scripts.find((script) => script.id === previous.scriptId);
      if (
        current !== undefined &&
        !sameManagedFields(managedFieldsFromScript(current), previous.lastManaged)
      ) {
        const permission = reconcileResumePermission({
          currentPermission: current.allowAgentResume === true,
          managedPermission: previous.managesResumePermission,
          trusted: false,
          mayAddManagedGrant: false,
        });
        const next = withResumePermission(current, permission.allowAgentResume);
        if (!sameScript(current, next)) {
          replaceScript(previous.scriptId, next);
          report.updated.push(entry.sourceId);
        }
        report.diverged.push(entry.sourceId);
        nextRecords.push({
          ...previous,
          managesResumePermission: permission.managesResumePermission,
        });
        continue;
      }

      const permission = reconcileResumePermission({
        currentPermission: current?.allowAgentResume === true,
        managedPermission: previous.managesResumePermission,
        trusted,
        mayAddManagedGrant: true,
      });
      const next = withManagedFields(previous.scriptId, entry.managed, permission.allowAgentResume);
      if (current === undefined) report.created.push(entry.sourceId);
      else if (!sameScript(current, next)) report.updated.push(entry.sourceId);
      replaceScript(previous.scriptId, next);
      nextRecords.push({
        sourceId: entry.sourceId,
        scriptId: previous.scriptId,
        lastManaged: entry.managed,
        managesResumePermission: permission.managesResumePermission,
      });
      continue;
    }

    const deterministic = scripts.find((script) => script.id === entry.sourceId);
    if (deterministic !== undefined) {
      if (claimedScriptIds.has(deterministic.id)) {
        return yield* new ProjectActionReconciliationError({
          reason: "source_id_ownership_conflict",
          message: `Checked-in Action '${entry.sourceId}' conflicts with existing managed ownership.`,
        });
      }
      claimedScriptIds.add(deterministic.id);
      if (!sameManagedFields(managedFieldsFromScript(deterministic), entry.managed)) {
        report.diverged.push(entry.sourceId);
        continue;
      }
      const permission = reconcileResumePermission({
        currentPermission: deterministic.allowAgentResume === true,
        managedPermission: false,
        trusted,
        mayAddManagedGrant: true,
      });
      const next = withManagedFields(deterministic.id, entry.managed, permission.allowAgentResume);
      if (!sameScript(deterministic, next)) {
        replaceScript(deterministic.id, next);
        report.updated.push(entry.sourceId);
      }
      report.adopted.push(entry.sourceId);
      nextRecords.push({
        sourceId: entry.sourceId,
        scriptId: deterministic.id,
        lastManaged: entry.managed,
        managesResumePermission: permission.managesResumePermission,
      });
      continue;
    }

    const legacyMatches = scripts.filter(
      (script) =>
        !claimedScriptIds.has(script.id) &&
        sameManagedFields(managedFieldsFromScript(script), entry.managed),
    );
    if (legacyMatches.length > 1) {
      return yield* new ProjectActionReconciliationError({
        reason: "ambiguous_legacy_import",
        message: `Multiple saved Actions exactly match '${entry.sourceId}'.`,
      });
    }
    const legacy = legacyMatches[0];
    if (legacy !== undefined) {
      claimedScriptIds.add(legacy.id);
      const permission = reconcileResumePermission({
        currentPermission: legacy.allowAgentResume === true,
        managedPermission: false,
        trusted,
        mayAddManagedGrant: true,
      });
      const next = withManagedFields(legacy.id, entry.managed, permission.allowAgentResume);
      if (!sameScript(legacy, next)) {
        replaceScript(legacy.id, next);
        report.updated.push(entry.sourceId);
      }
      report.adopted.push(entry.sourceId);
      nextRecords.push({
        sourceId: entry.sourceId,
        scriptId: legacy.id,
        lastManaged: entry.managed,
        managesResumePermission: permission.managesResumePermission,
      });
      continue;
    }

    const permission = reconcileResumePermission({
      currentPermission: false,
      managedPermission: false,
      trusted,
      mayAddManagedGrant: true,
    });
    if (claimedScriptIds.has(entry.sourceId)) {
      return yield* new ProjectActionReconciliationError({
        reason: "source_id_ownership_conflict",
        message: `Checked-in Action '${entry.sourceId}' conflicts with existing managed ownership.`,
      });
    }
    const next = withManagedFields(entry.sourceId, entry.managed, permission.allowAgentResume);
    scripts.push(next);
    claimedScriptIds.add(next.id);
    report.created.push(entry.sourceId);
    nextRecords.push({
      sourceId: entry.sourceId,
      scriptId: next.id,
      lastManaged: entry.managed,
      managesResumePermission: permission.managesResumePermission,
    });
  }

  for (const previous of previousRecords.values()) {
    if (seenSourceIds.has(previous.sourceId)) continue;
    const current = scripts.find((script) => script.id === previous.scriptId);
    if (current === undefined) continue;
    if (!sameManagedFields(managedFieldsFromScript(current), previous.lastManaged)) {
      const permission = reconcileResumePermission({
        currentPermission: current.allowAgentResume === true,
        managedPermission: previous.managesResumePermission,
        trusted: false,
        mayAddManagedGrant: false,
      });
      const next = withResumePermission(current, permission.allowAgentResume);
      if (!sameScript(current, next)) {
        replaceScript(previous.scriptId, next);
        report.updated.push(previous.sourceId);
      }
      report.diverged.push(previous.sourceId);
      nextRecords.push({
        ...previous,
        managesResumePermission: permission.managesResumePermission,
      });
      continue;
    }
    const index = scripts.findIndex((script) => script.id === previous.scriptId);
    scripts.splice(index, 1);
    report.removed.push(previous.sourceId);
  }

  return {
    scripts,
    state: {
      schemaVersion: 1,
      projectWorkspaceRoot: input.projectWorkspaceRoot,
      actions: nextRecords,
    },
    report,
  } satisfies ProjectActionReconciliationResult;
});
