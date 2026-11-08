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
import { useEffect, useEffectEvent, useState } from "react";
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
  return operation.state === "queued"
    ? `${operation.message} Request ${operation.operationId} was queued. Refresh to inspect the current state.`
    : `${operation.message} Request ${operation.operationId} completed.`;
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
        setError(`Could not load saved workspaces. ${formatEnvironmentQueryError(result.cause)}`);
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
    else setError(`Restore was not completed. ${formatEnvironmentQueryError(result.cause)}`);
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
        `Could not prepare discard confirmation. ${formatEnvironmentQueryError(result.cause)}`,
      );
  };
  const restoreRecovery = async () => {
    if (
      working ||
      !canRestore ||
      recovery === null ||
      recoveryPath.trim() === "" ||
      (!restoresCurrent &&
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
        ...(!restoresCurrent && recoveryProject !== null ? { projectId: recoveryProject } : {}),
        destinationPath: recoveryPath.trim(),
      },
    });
    setWorking(false);
    setRecovery(null);
    if (result._tag === "Success") acceptOperation(result.value);
    else
      setError(`Recovery restore was not completed. ${formatEnvironmentQueryError(result.cause)}`);
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
        `Saved workspace data was not discarded. Review a fresh preview to try again. ${formatEnvironmentQueryError(result.cause)}`,
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
      setError(`Keep workspace was not released. ${formatEnvironmentQueryError(result.cause)}`);
  };

  if (!canList)
    return (
      <p role="status">
        This connection lacks permission to read saved workspaces on this environment.
      </p>
    );

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="outline" size="sm" disabled={loading || working} onClick={refresh}>
          Refresh saved workspaces
        </Button>
        <span className="text-xs text-muted-foreground">
          {entries.length} saved {entries.length === 1 ? "copy" : "copies"} shown
        </span>
      </div>
      <p className="text-xs text-muted-foreground">
        Restore puts the exact saved checkout back and enables Keep workspace for inspection. Saved
        copies stay until you discard them. Their size is storage used, not a measurement of free
        disk space.
      </p>
      {(loading || working) && (
        <p role="status" className="text-sm">
          {working ? "Working on the requested operation…" : "Loading saved workspaces…"}
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
        <p className="text-sm">No saved workspaces for this selection.</p>
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
                {entry.current ? "Current saved copy" : "Historical saved copy"} · {entry.state}
                {entry.orphaned ? " · Kept for recovery after deletion" : ""}
              </p>
              <p>
                {formatBytes(entry.bytes)} saved · {entry.fileCount.toLocaleString()} files · Saved{" "}
                {entry.savedAt}
              </p>
              <p>
                <code>
                  {entry.branch ?? "Detached HEAD"} · {entry.head.slice(0, 12)}
                </code>
              </p>
              <p>
                Checkout: <code>{entry.path}</code>
              </p>
              <p>
                Saved copy: <code>{entry.snapshotId}</code> · {entry.ownerThreadIds.length} thread{" "}
                {entry.ownerThreadIds.length === 1 ? "owner" : "owners"}
              </p>
              {entry.blockedReason && <p role="status">{entry.blockedReason}</p>}
              {orphanUnavailable && (
                <p role="status">
                  Environment maintenance permission is required to restore or discard this orphaned
                  saved copy.
                </p>
              )}
              {entry.keepWorkspace && (
                <p>
                  Keep workspace is on. Releasing it makes already-old resources eligible at the
                  next automatic cleanup.
                </p>
              )}
              {queued && (
                <p role="status">
                  Request queued. Refresh to inspect this checkout’s current state.
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
                      {entry.blockedReason ? "Retry recovery" : "Restore worktree"}
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
                      Restore to another location
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
                  Restore as recovery worktree
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
                Discard saved workspace
              </Button>
              {entry.keepWorkspace && (entry.orphaned || entry.ownerThreadIds.length > 0) && (
                <Button
                  variant="outline"
                  size="sm"
                  disabled={unavailable || !canSetKeep || orphanUnavailable}
                  onClick={() => void releaseKeep(entry)}
                >
                  Release Keep workspace
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
          Load more saved workspaces
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
              {restoresCurrent
                ? "Restore at another location"
                : "Restore a separate recovery worktree"}
            </DialogTitle>
            <DialogDescription>
              {restoresCurrent
                ? "Restore this exact saved copy at an unused managed worktree path for its existing threads. Choose another location when the original path is occupied. Keep workspace starts on."
                : "Create a new recovery thread and checkout from this exact saved copy. Choose an existing project and an unused path inside a managed worktree location. The active checkout stays unchanged. Keep workspace starts on."}
            </DialogDescription>
          </DialogHeader>
          <DialogPanel>
            <p className="text-xs wrap-anywhere select-text">Saved copy: {recovery?.snapshotId}</p>
            {!restoresCurrent && (
              <Select value={recoveryProject} onValueChange={setRecoveryProject} disabled={working}>
                <SelectTrigger aria-label="Recovery project">
                  <SelectValue placeholder="Choose a project">
                    {projects.find((project) => project.id === recoveryProject)?.title ??
                      "Choose a project"}
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
                restoresCurrent ? "Alternate managed worktree path" : "New recovery worktree path"
              }
              autoCapitalize="none"
              spellCheck={false}
              disabled={working || orphanRecoveryUnavailable}
              value={recoveryPath}
              placeholder="Unused managed worktree path"
              onChange={(event) => setRecoveryPath(event.currentTarget.value)}
            />
          </DialogPanel>
          <DialogFooter>
            <Button variant="outline" disabled={working} onClick={() => setRecovery(null)}>
              Cancel
            </Button>
            <Button
              disabled={
                working ||
                !canRestore ||
                orphanRecoveryUnavailable ||
                recoveryPath.trim() === "" ||
                (!restoresCurrent && !projects.some((project) => project.id === recoveryProject))
              }
              onClick={() => void restoreRecovery()}
            >
              {restoresCurrent ? "Restore at alternate location" : "Restore recovery worktree"}
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
            <DialogTitle>Discard saved workspace data?</DialogTitle>
            <DialogDescription>
              This permanently deletes the saved copies listed below, including their uncommitted
              files and local notes. Git branches and ordinary checkpoint history are kept.
              Restoration is not required to discard a saved copy.
            </DialogDescription>
          </DialogHeader>
          <DialogPanel>
            {preview && (
              <>
                <p className="text-sm">{preview.message}</p>
                <p className="text-sm">
                  {preview.snapshots.length} saved{" "}
                  {preview.snapshots.length === 1 ? "copy" : "copies"} ·{" "}
                  {formatBytes(preview.bytes)} of saved data
                </p>
                {preview.retainedCount > 0 && (
                  <p className="text-sm">
                    {preview.retainedCount} shared or retained{" "}
                    {preview.retainedCount === 1 ? "copy stays" : "copies stay"} protected.
                  </p>
                )}
                <ul className="space-y-3 text-xs wrap-anywhere select-text">
                  {preview.snapshots.map((entry) => (
                    <li key={entry.snapshotId}>
                      {entry.title} · {entry.current ? "Current" : "Historical"} ·{" "}
                      {formatBytes(entry.bytes)}
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
              Keep saved data
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
              Discard saved workspace data
            </Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>
    </div>
  );
}

export function SavedWorkspacesSettings() {
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
            <DialogTitle>Saved workspaces</DialogTitle>
            <DialogDescription>
              Choose the environment whose saved data you want to inspect. Project scope filters
              this list to that project.
            </DialogDescription>
          </DialogHeader>
          <DialogPanel>
            <Select value={selected?.key ?? null} onValueChange={setSelection}>
              <SelectTrigger aria-label="Saved workspace environment">
                <SelectValue placeholder="Choose an environment">
                  {selected?.label ?? "Choose an environment"}
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
