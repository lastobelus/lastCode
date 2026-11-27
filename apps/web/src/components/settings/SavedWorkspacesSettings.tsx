import { formatEnvironmentQueryError } from "../../state/query";
import { useAtomValue } from "@effect/atom-react";
import { AuthEnvironmentMaintainScope } from "@t3tools/contracts";
import type {
  EnvironmentId,
  ProjectId,
  SavedWorkspace,
  WorktreeDiscardPreview,
  WorkspaceOperation,
} from "@t3tools/contracts";
import { msg, T, useGT, Var } from "gt-react";
import { useEffect, useEffectEvent, useState } from "react";
import { m } from "../../i18n/messages";
import { formatBytes } from "../../lib/formatBytes";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { useProjects } from "../../state/entities";
import { readEnvironmentScope, useEnvironmentScope } from "../../state/session";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { SavedWorkspacesLaunch } from "./LastCodeStorageSettings";
import { useSettingsScope } from "./SettingsScopeContext";
import { settingsScopeEnvironmentLabel } from "./settingsScopeAxis";

function operationMessage(operation: WorkspaceOperation): string {
  const { message, operationId } = operation;
  return operation.state === "queued"
    ? m(
        msg("{message} Request {operationId} was queued. Refresh to inspect the current state.", {
          message,
          operationId,
        }),
      )
    : m(msg("{message} Request {operationId} completed.", { message, operationId }));
}

function busy(entry: SavedWorkspace): boolean {
  return entry.state === "capturing" || entry.state === "restoring" || entry.state === "discarding";
}

export function SavedWorkspacesManager({
  environmentId,
  projectId,
}: {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId | null;
}) {
  const gt = useGT();
  const list = useAtomCommand(serverEnvironment.listSavedWorkspaces, { reportFailure: false });
  const restore = useAtomCommand(serverEnvironment.restoreWorktree, { reportFailure: false });
  const previewDiscard = useAtomCommand(serverEnvironment.previewWorktreeDiscard, {
    reportFailure: false,
  });
  const discard = useAtomCommand(serverEnvironment.discardWorktreeSnapshots, {
    reportFailure: false,
  });
  const setKeep = useAtomCommand(serverEnvironment.setKeepWorkspace, { reportFailure: false });
  const canList = useAtomValue(serverEnvironment.listSavedWorkspaces.permissionAtom(environmentId));
  const canRestore = useAtomValue(serverEnvironment.restoreWorktree.permissionAtom(environmentId));
  const canPreviewDiscard = useAtomValue(
    serverEnvironment.previewWorktreeDiscard.permissionAtom(environmentId),
  );
  const canDiscard = useAtomValue(
    serverEnvironment.discardWorktreeSnapshots.permissionAtom(environmentId),
  );
  const canSetKeep = useAtomValue(serverEnvironment.setKeepWorkspace.permissionAtom(environmentId));
  const canMaintainEnvironment = useEnvironmentScope(environmentId, AuthEnvironmentMaintainScope);
  const projects = useProjects().filter((project) => project.environmentId === environmentId);
  const [entries, setEntries] = useState<readonly SavedWorkspace[]>([]);
  const [nextCursor, setNextCursor] = useState<number | null>(null);
  const [request, setRequest] = useState({ cursor: 0, revision: 0 });
  const [loading, setLoading] = useState(true);
  const [working, setWorking] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<WorktreeDiscardPreview | null>(null);
  const [recovery, setRecovery] = useState<SavedWorkspace | null>(null);
  const [recoveryProject, setRecoveryProject] = useState<ProjectId | null>(projectId);
  const [recoveryPath, setRecoveryPath] = useState("");
  const [queuedCheckouts, setQueuedCheckouts] = useState<readonly string[]>([]);
  const restoresCurrent = recovery?.current === true && !recovery.orphaned;
  const needsRecoveryPath = restoresCurrent || recovery?.kind !== "scratch";
  const orphanRecoveryUnavailable = recovery?.orphaned === true && !canMaintainEnvironment;
  const orphanDiscardUnavailable =
    preview?.snapshots.some((entry) => entry.orphaned) === true && !canMaintainEnvironment;
  const load = useEffectEvent(
    (destination: EnvironmentId, project: ProjectId | null, cursor: number) =>
      list({
        environmentId: destination,
        input: {
          ...(project === null ? {} : { projectId: project }),
          ...(cursor === 0 ? {} : { cursor }),
        },
      }),
  );
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- owns the server saved-workspace page request for this mounted view and ignores its result after cleanup
  useEffect(() => {
    if (!canList) return;
    let cancelled = false;
    void load(environmentId, projectId, request.cursor).then((result) => {
      if (cancelled) return;
      setLoading(false);
      if (result._tag === "Success") {
        setEntries((previous) =>
          request.cursor === 0 ? result.value.entries : [...previous, ...result.value.entries],
        );
        setNextCursor(result.value.nextCursor);
        setError(null);
        if (request.cursor === 0) setQueuedCheckouts([]);
      } else {
        setError(
          m(
            msg("Could not load saved workspaces. {error}", {
              error: formatEnvironmentQueryError(result.cause),
            }),
          ),
        );
      }
    });
    return () => {
      cancelled = true;
    };
  }, [environmentId, projectId, canList, request]);
  const refresh = () => {
    setLoading(true);
    setPreview(null);
    setRequest((previous) => ({ cursor: 0, revision: previous.revision + 1 }));
  };
  const acceptOperation = (operation: WorkspaceOperation) => {
    setMessage(operationMessage(operation));
    if (operation.state === "queued") {
      setQueuedCheckouts((previous) => [...previous, operation.checkoutId]);
    }
  };
  const restoreEntry = async (entry: SavedWorkspace) => {
    if (
      working ||
      !canRestore ||
      !entry.current ||
      entry.orphaned ||
      (entry.state !== "suspended" && entry.blockedReason === undefined)
    )
      return;
    setWorking(true);
    setError(null);
    const result = await restore({
      environmentId,
      input: { checkoutId: entry.checkoutId, snapshotId: entry.snapshotId },
    });
    setWorking(false);
    if (result._tag === "Success") acceptOperation(result.value);
    else
      setError(
        m(
          msg("Restore was not completed. {error}", {
            error: formatEnvironmentQueryError(result.cause),
          }),
        ),
      );
  };
  const reviewDiscard = async (entry: SavedWorkspace) => {
    if (
      working ||
      !canPreviewDiscard ||
      !canDiscard ||
      entry.blockedReason !== undefined ||
      (entry.orphaned && !readEnvironmentScope(environmentId, AuthEnvironmentMaintainScope))
    )
      return;
    setWorking(true);
    setError(null);
    const result = await previewDiscard({
      environmentId,
      input: { checkoutId: entry.checkoutId, snapshotIds: [entry.snapshotId] },
    });
    setWorking(false);
    if (result._tag === "Success") setPreview(result.value);
    else
      setError(
        m(
          msg("Could not prepare discard confirmation. {error}", {
            error: formatEnvironmentQueryError(result.cause),
          }),
        ),
      );
  };
  const restoreRecovery = async () => {
    if (
      working ||
      !canRestore ||
      recovery === null ||
      (needsRecoveryPath && recoveryPath.trim() === "") ||
      (!restoresCurrent &&
        recovery.kind !== "scratch" &&
        (recoveryProject === null ||
          !projects.some((project) => project.id === recoveryProject))) ||
      (recovery.orphaned && !readEnvironmentScope(environmentId, AuthEnvironmentMaintainScope))
    )
      return;
    setWorking(true);
    setError(null);
    const result = await restore({
      environmentId,
      input: {
        checkoutId: recovery.checkoutId,
        snapshotId: recovery.snapshotId,
        ...(!restoresCurrent && recovery.kind !== "scratch" && recoveryProject !== null
          ? { projectId: recoveryProject }
          : {}),
        ...(recoveryPath.trim() === "" ? {} : { destinationPath: recoveryPath.trim() }),
      },
    });
    setWorking(false);
    setRecovery(null);
    if (result._tag === "Success") acceptOperation(result.value);
    else
      setError(
        m(
          msg("Recovery restore was not completed. {error}", {
            error: formatEnvironmentQueryError(result.cause),
          }),
        ),
      );
  };
  const confirmDiscard = async () => {
    if (
      working ||
      !canDiscard ||
      preview === null ||
      preview.snapshots.length === 0 ||
      (preview.snapshots.some((entry) => entry.orphaned) &&
        !readEnvironmentScope(environmentId, AuthEnvironmentMaintainScope))
    )
      return;
    setWorking(true);
    setError(null);
    const result = await discard({ environmentId, input: { previewToken: preview.token } });
    setWorking(false);
    setPreview(null);
    if (result._tag === "Success") acceptOperation(result.value);
    else
      setError(
        m(
          msg(
            "Saved workspace data was not discarded. Review a fresh preview to try again. {error}",
            { error: formatEnvironmentQueryError(result.cause) },
          ),
        ),
      );
  };
  const releaseKeep = async (entry: SavedWorkspace) => {
    const threadId = entry.ownerThreadIds[0];
    if (
      working ||
      !canSetKeep ||
      (entry.orphaned
        ? !readEnvironmentScope(environmentId, AuthEnvironmentMaintainScope)
        : threadId === undefined)
    )
      return;
    setWorking(true);
    setError(null);
    const result = await setKeep({
      environmentId,
      input:
        entry.orphaned || threadId === undefined
          ? { checkoutId: entry.checkoutId, keep: false }
          : { threadId, keep: false },
    });
    setWorking(false);
    if (result._tag === "Success") {
      acceptOperation(result.value);
      refresh();
    } else
      setError(
        m(
          msg("{keepWorkspace} was not released. {error}", {
            keepWorkspace: "Keep workspace",
            error: formatEnvironmentQueryError(result.cause),
          }),
        ),
      );
  };

  if (!canList)
    return (
      <p role="status">
        <T>This connection lacks permission to read saved workspaces on this environment.</T>
      </p>
    );

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="outline" size="sm" disabled={loading || working} onClick={refresh}>
          <T>Refresh saved workspaces</T>
        </Button>
        <span className="text-xs text-muted-foreground">
          {gt(
            "{count, plural, one {{count} saved copy shown} other {{count} saved copies shown}}",
            {
              count: entries.length,
            },
          )}
        </span>
      </div>
      <p className="text-xs text-muted-foreground">
        {gt(
          "Restore puts the exact saved checkout back and enables {keepWorkspace} for inspection. Saved copies stay until you discard them. Their size is storage used, not a measurement of free disk space.",
          { keepWorkspace: "Keep workspace" },
        )}
      </p>
      {(loading || working) && (
        <p role="status" className="text-sm">
          {working ? gt("Working on the requested operation…") : gt("Loading saved workspaces…")}
        </p>
      )}
      {message && (
        <p role="status" className="text-sm">
          {message}
        </p>
      )}
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      {!loading && entries.length === 0 && !error && (
        <p className="text-sm">
          <T>No saved workspaces for this selection.</T>
        </p>
      )}
      {entries.map((entry) => {
        const queued = queuedCheckouts.includes(entry.checkoutId);
        const orphanUnavailable = entry.orphaned && !canMaintainEnvironment;
        const unavailable = loading || working || busy(entry) || queued;
        const recoveryUnavailable =
          loading || working || queued || (busy(entry) && entry.blockedReason === undefined);
        return (
          <article
            key={`${entry.checkoutId}:${entry.snapshotId}`}
            className="space-y-3 rounded-lg border border-border p-3"
          >
            <div className="space-y-1 text-xs wrap-anywhere select-text">
              <h3 className="text-sm font-medium">{entry.title}</h3>
              <p>
                {entry.current
                  ? gt("Current saved copy · {state}", { state: entry.state })
                  : gt("Historical saved copy · {state}", { state: entry.state })}
                {entry.orphaned ? ` · ${gt("Kept for recovery after deletion")}` : ""}
              </p>
              <p>
                {gt("{bytes} saved · {fileCount} files · Saved {savedAt}", {
                  bytes: formatBytes(entry.bytes),
                  fileCount: entry.fileCount.toLocaleString(),
                  savedAt: entry.savedAt,
                })}
              </p>
              <p>
                <code>
                  {entry.kind === "scratch" ? (
                    "Scratch workspace"
                  ) : (
                    <>
                      {entry.branch ?? "Detached HEAD"} · {entry.head?.slice(0, 12) ?? "Unverified"}
                    </>
                  )}
                </code>
              </p>
              <p>
                <T>
                  Checkout:{" "}
                  <code>
                    <Var>{entry.path}</Var>
                  </code>
                </T>
              </p>
              <p>
                <T>
                  Saved copy:{" "}
                  <code>
                    <Var>{entry.snapshotId}</Var>
                  </code>{" "}
                  ·{" "}
                  <Var>
                    {gt(
                      "{count, plural, one {{count} thread owner} other {{count} thread owners}}",
                      { count: entry.ownerThreadIds.length },
                    )}
                  </Var>
                </T>
              </p>
              {entry.blockedReason && <p role="status">{entry.blockedReason}</p>}
              {orphanUnavailable && (
                <p role="status">
                  <T>
                    Environment maintenance permission is required to restore or discard this
                    orphaned saved copy.
                  </T>
                </p>
              )}
              {entry.keepWorkspace && (
                <p>
                  {gt(
                    "{keepWorkspace} is on. Releasing it makes already-old resources eligible at the next automatic cleanup.",
                    { keepWorkspace: "Keep workspace" },
                  )}
                </p>
              )}
              {queued && (
                <p role="status">
                  <T>Request queued. Refresh to inspect this checkout’s current state.</T>
                </p>
              )}
            </div>
            <div className="flex flex-wrap gap-2">
              {entry.current &&
                !entry.orphaned &&
                (entry.state === "suspended" || entry.blockedReason !== undefined) && (
                  <>
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={recoveryUnavailable || !canRestore}
                      onClick={() => void restoreEntry(entry)}
                    >
                      {entry.blockedReason ? gt("Retry recovery") : gt("Restore worktree")}
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={recoveryUnavailable || !canRestore}
                      onClick={() => {
                        setRecovery(entry);
                        setRecoveryPath("");
                        setRecoveryProject(null);
                      }}
                    >
                      <T>Restore to another location</T>
                    </Button>
                  </>
                )}
              {(!entry.current || entry.orphaned) && (
                <Button
                  variant="outline"
                  size="sm"
                  disabled={recoveryUnavailable || !canRestore || orphanUnavailable}
                  onClick={() => {
                    setRecovery(entry);
                    setRecoveryPath("");
                    setRecoveryProject(projectId);
                  }}
                >
                  <T>Restore as recovery worktree</T>
                </Button>
              )}
              <Button
                variant="destructive-outline"
                size="sm"
                disabled={
                  unavailable ||
                  !canPreviewDiscard ||
                  !canDiscard ||
                  orphanUnavailable ||
                  entry.state === "blocked" ||
                  entry.blockedReason !== undefined
                }
                onClick={() => void reviewDiscard(entry)}
              >
                <T>Discard saved workspace</T>
              </Button>
              {entry.keepWorkspace && (entry.orphaned || entry.ownerThreadIds.length > 0) && (
                <Button
                  variant="outline"
                  size="sm"
                  disabled={unavailable || !canSetKeep || orphanUnavailable}
                  onClick={() => void releaseKeep(entry)}
                >
                  {gt("Release {keepWorkspace}", { keepWorkspace: "Keep workspace" })}
                </Button>
              )}
            </div>
          </article>
        );
      })}
      {nextCursor !== null && (
        <Button
          variant="outline"
          size="sm"
          disabled={loading || working}
          onClick={() => {
            setLoading(true);
            setRequest((previous) => ({ cursor: nextCursor, revision: previous.revision + 1 }));
          }}
        >
          <T>Load more saved workspaces</T>
        </Button>
      )}
      <Dialog
        open={recovery !== null}
        onOpenChange={(open) => {
          if (!open && !working) setRecovery(null);
        }}
      >
        <DialogPopup>
          <DialogHeader>
            <DialogTitle>
              {recovery?.kind === "scratch"
                ? gt("Restore scratch workspace")
                : restoresCurrent
                  ? gt("Restore at another location")
                  : gt("Restore a separate recovery worktree")}
            </DialogTitle>
            <DialogDescription>
              {recovery?.kind === "scratch"
                ? restoresCurrent
                  ? gt(
                      "Restore the saved files for this workspace's existing threads. Choose an unused folder directly inside the managed scratch location.",
                    )
                  : gt(
                      "Restore the saved files into a new {noProject} thread. Enter an unused folder directly inside the managed scratch location, or leave the path empty to choose one automatically.",
                      { noProject: "No project" },
                    )
                : restoresCurrent
                  ? gt(
                      "Restore this exact saved copy at an unused managed worktree path for its existing threads. Choose another location when the original path is occupied. {keepWorkspace} starts on.",
                      { keepWorkspace: "Keep workspace" },
                    )
                  : gt(
                      "Create a new recovery thread and checkout from this exact saved copy. Choose an existing project and an unused path inside a managed worktree location. The active checkout stays unchanged. {keepWorkspace} starts on.",
                      { keepWorkspace: "Keep workspace" },
                    )}
            </DialogDescription>
          </DialogHeader>
          <DialogPanel>
            <p className="text-xs wrap-anywhere select-text">
              {gt("Saved copy: {snapshotId}", { snapshotId: recovery?.snapshotId ?? "" })}
            </p>
            {!restoresCurrent && recovery?.kind !== "scratch" && (
              <Select value={recoveryProject} onValueChange={setRecoveryProject} disabled={working}>
                <SelectTrigger aria-label={gt("Recovery project")}>
                  <SelectValue placeholder={gt("Choose a project")}>
                    {projects.find((project) => project.id === recoveryProject)?.title ??
                      gt("Choose a project")}
                  </SelectValue>
                </SelectTrigger>
                <SelectPopup>
                  {projects.map((project) => (
                    <SelectItem key={project.id} value={project.id}>
                      {project.title}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            )}
            <Input
              aria-label={
                restoresCurrent
                  ? gt("Alternate managed worktree path")
                  : gt("New recovery worktree path")
              }
              autoCapitalize="none"
              spellCheck={false}
              disabled={working || orphanRecoveryUnavailable}
              value={recoveryPath}
              placeholder={
                recovery?.kind === "scratch"
                  ? gt("Unused managed scratch path")
                  : gt("Unused managed worktree path")
              }
              onChange={(event) => setRecoveryPath(event.currentTarget.value)}
            />
          </DialogPanel>
          <DialogFooter>
            <Button variant="outline" disabled={working} onClick={() => setRecovery(null)}>
              <T>Cancel</T>
            </Button>
            <Button
              disabled={
                working ||
                !canRestore ||
                orphanRecoveryUnavailable ||
                (needsRecoveryPath && recoveryPath.trim() === "") ||
                (!restoresCurrent &&
                  recovery?.kind !== "scratch" &&
                  !projects.some((project) => project.id === recoveryProject))
              }
              onClick={() => void restoreRecovery()}
            >
              {restoresCurrent
                ? gt("Restore at alternate location")
                : gt("Restore recovery worktree")}
            </Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>
      <Dialog
        open={preview !== null}
        onOpenChange={(open) => {
          if (!open && !working) setPreview(null);
        }}
      >
        <DialogPopup>
          <DialogHeader>
            <DialogTitle>
              <T>Discard saved workspace data?</T>
            </DialogTitle>
            <DialogDescription>
              <T>
                This permanently deletes the saved copies listed below, including their uncommitted
                files and local notes. <Var>{"Git"}</Var> branches and ordinary checkpoint history
                are kept. Restoration is not required to discard a saved copy.
              </T>
            </DialogDescription>
          </DialogHeader>
          <DialogPanel>
            {preview && (
              <>
                <p className="text-sm">{preview.message}</p>
                <p className="text-sm">
                  {gt(
                    "{count, plural, one {{count} saved copy} other {{count} saved copies}} · {bytes} of saved data",
                    { count: preview.snapshots.length, bytes: formatBytes(preview.bytes) },
                  )}
                </p>
                {preview.retainedCount > 0 && (
                  <p className="text-sm">
                    {gt(
                      "{count, plural, one {{count} shared or retained copy stays protected.} other {{count} shared or retained copies stay protected.}}",
                      { count: preview.retainedCount },
                    )}
                  </p>
                )}
                <ul className="space-y-3 text-xs wrap-anywhere select-text">
                  {preview.snapshots.map((entry) => (
                    <li key={entry.snapshotId}>
                      {entry.title} ·{" "}
                      {entry.current
                        ? gt("Current", { $context: "saved workspace copy" })
                        : gt("Historical", { $context: "saved workspace copy" })}{" "}
                      · {formatBytes(entry.bytes)}
                      <br />
                      <code>{entry.snapshotId}</code>
                      <br />
                      <code>{entry.path}</code>
                    </li>
                  ))}
                </ul>
              </>
            )}
          </DialogPanel>
          <DialogFooter>
            <Button variant="outline" disabled={working} onClick={() => setPreview(null)}>
              <T>Keep saved data</T>
            </Button>
            <Button
              variant="destructive"
              disabled={
                working ||
                !canDiscard ||
                orphanDiscardUnavailable ||
                preview === null ||
                preview.snapshots.length === 0
              }
              onClick={() => void confirmDiscard()}
            >
              <T>Discard saved workspace data</T>
            </Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>
    </div>
  );
}

export function SavedWorkspacesSettings() {
  const gt = useGT();
  const { connectedEnvironments, targets } = useSettingsScope();
  const [open, setOpen] = useState(false);
  const [selection, setSelection] = useState<string | null>(null);
  const choices = targets.flatMap((target) => {
    const environment = connectedEnvironments.find(
      (entry) =>
        entry.environmentId === target.environmentId &&
        entry.serverConfig?.environment.capabilities.worktreeSuspension === true,
    );
    if (!environment) return [];
    const repeatedEnvironment =
      targets.filter((entry) => entry.environmentId === target.environmentId).length > 1;
    return [
      {
        key: JSON.stringify([target.environmentId, target.projectId]),
        target,
        label: `${settingsScopeEnvironmentLabel(environment, connectedEnvironments)}${repeatedEnvironment && target.projectId !== null ? ` · ${target.projectId}` : ""}`,
      },
    ];
  });
  const selected = choices.find((choice) => choice.key === selection);
  return (
    <>
      <SavedWorkspacesLaunch
        disabled={choices.length === 0}
        onOpen={() => {
          setSelection(null);
          setOpen(true);
        }}
      />
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogPopup>
          <DialogHeader>
            <DialogTitle>
              <T>Saved workspaces</T>
            </DialogTitle>
            <DialogDescription>
              <T>
                Choose the environment whose saved data you want to inspect. Project scope filters
                this list to that project.
              </T>
            </DialogDescription>
          </DialogHeader>
          <DialogPanel>
            <Select value={selected?.key ?? null} onValueChange={setSelection}>
              <SelectTrigger aria-label={gt("Saved workspace environment")}>
                <SelectValue placeholder={gt("Choose an environment")}>
                  {selected?.label ?? gt("Choose an environment")}
                </SelectValue>
              </SelectTrigger>
              <SelectPopup>
                {choices.map((choice) => (
                  <SelectItem key={choice.key} value={choice.key}>
                    {choice.label}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
            {selected && (
              <SavedWorkspacesManager
                key={selected.key}
                environmentId={selected.target.environmentId}
                projectId={selected.target.projectId}
              />
            )}
          </DialogPanel>
        </DialogPopup>
      </Dialog>
    </>
  );
}
