import { useAtomValue } from "@effect/atom-react";
import type {
  BuildReviewPreview,
  BuildReviewTarget,
  EnvironmentId,
  ProjectId,
} from "@t3tools/contracts";
import { BUILD_REVIEW_PAGE_SIZE } from "@t3tools/contracts";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { useEffect, useEffectEvent, useReducer, useState } from "react";
import { formatBytes } from "../../lib/formatBytes";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
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
import { useSettingsScope } from "./SettingsScopeContext";
import { settingsScopeEnvironmentLabel } from "./settingsScopeAxis";
import { SettingsRow } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";
import { buildReviewDraftReducer, EMPTY_BUILD_REVIEW_DRAFT } from "./buildReviewDraft";

function eligibility(target: BuildReviewTarget) {
  if (target.protectedReason) return target.protectedReason;
  if (target.delayDays === null)
    return "Automatic dependency and build cleanup is Off. Approval does not enable it.";
  if (target.archived)
    return "Archived owners are eligible immediately while automatic cleanup is enabled, subject to active-consumer checks.";
  if (target.eligibleAt !== null)
    return `Eligible after ${new Date(target.eligibleAt).toLocaleString()}, subject to active-consumer checks.`;
  return `Without a trusted use date, this build starts the full ${target.delayDays}-day delay. An old folder date does not make it eligible sooner.`;
}

function RootReview({
  environmentId,
  target,
}: {
  environmentId: EnvironmentId;
  target: BuildReviewTarget;
}) {
  const previewCommand = useAtomCommand(serverEnvironment.previewBuildReview, {
    reportFailure: false,
  });
  const saveCommand = useAtomCommand(serverEnvironment.selectBuildReview, { reportFailure: false });
  const allowed = useAtomValue(serverEnvironment.selectBuildReview.permissionAtom(environmentId));
  const [draft, dispatch] = useReducer(buildReviewDraftReducer, EMPTY_BUILD_REVIEW_DRAFT);
  const [request, setRequest] = useState({ offset: 0, revision: 0 });
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const load = useEffectEvent((destination: EnvironmentId, targetId: string, page: number) =>
    previewCommand({ environmentId: destination, input: { targetId, offset: page } }),
  );
  const acceptPreview = useEffectEvent((next: BuildReviewPreview) => {
    const changed = draft.token !== null && draft.token !== next.token;
    dispatch({ type: "preview", preview: next });
    if (changed) {
      setLoading(true);
      setRequest((value) => ({ offset: 0, revision: value.revision + 1 }));
    }
  });
  useEffect(() => {
    let cancelled = false;
    void load(environmentId, target.id, request.offset).then((result) => {
      if (cancelled) return;
      setLoading(false);
      if (result._tag === "Success") acceptPreview(result.value);
      else
        dispatch({
          type: "reset",
          notice: `Could not load this build. Reload to review again. ${String(squashAtomCommandFailure(result))}`,
        });
    });
    return () => {
      cancelled = true;
    };
  }, [environmentId, target.id, request]);
  const preview = draft.preview;
  const reload = () => {
    dispatch({ type: "reset" });
    setLoading(true);
    setRequest((value) => ({ offset: 0, revision: value.revision + 1 }));
  };
  const save = async () => {
    if (!preview || loading || saving || !allowed) return;
    setSaving(true);
    setMessage(null);
    const result = await saveCommand({
      environmentId,
      input: { targetId: target.id, previewToken: preview.token, paths: [...draft.paths] },
    });
    setSaving(false);
    if (result._tag === "Success") {
      setMessage(
        `${result.value.message} ${result.value.selectedCount} files approved. Saving does not delete files.`,
      );
      reload();
    } else {
      dispatch({
        type: "reset",
        notice: `Approval was not saved. Reload this root and select files again. ${String(squashAtomCommandFailure(result))}`,
      });
    }
  };
  return (
    <div className="space-y-4">
      <div className="space-y-1 text-xs wrap-anywhere select-text">
        <p>
          {target.projectName} · {target.branch ?? "No branch"}
        </p>
        <p>
          Worktree: <code>{target.worktreePath}</code>
        </p>
        <p>
          Build root: <code>{target.root}</code>
        </p>
        <p>{eligibility(preview?.target ?? target)}</p>
      </div>
      <p className="text-xs text-muted-foreground">
        Review is limited to 1,000 files and 512 MiB per root, in pages of 200. Only unchanged files
        you explicitly select can be reclaimed by the current automatic dependency and build cleanup
        policy. Source and other files remain protected.
      </p>
      {message && (
        <p role="status" className="text-sm">
          {message}
        </p>
      )}
      {draft.notice && (
        <p role="alert" className="text-sm text-destructive">
          {draft.notice}
        </p>
      )}
      {loading && (
        <p role="status" className="text-sm">
          Loading build files…
        </p>
      )}
      {!loading && !preview && (
        <Button variant="outline" size="sm" onClick={reload}>
          Reload root
        </Button>
      )}
      {preview && (
        <>
          <p className="text-xs text-muted-foreground">
            {preview.totalFiles.toLocaleString()} files · {formatBytes(preview.totalSize)} logical ·{" "}
            {formatBytes(preview.totalBytes)} allocated estimate. Previously approved:{" "}
            {preview.selectedPaths.length}. This review: {draft.paths.length} selected.
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              disabled={loading || saving || !allowed}
              onClick={() =>
                dispatch({
                  type: "select",
                  paths: preview.files.map((file) => file.path),
                  checked: true,
                })
              }
            >
              Select this page
            </Button>
            <Button
              variant="ghost"
              size="sm"
              disabled={loading || saving || !allowed}
              onClick={() =>
                dispatch({
                  type: "select",
                  paths: preview.files.map((file) => file.path),
                  checked: false,
                })
              }
            >
              Clear this page
            </Button>
            <Button variant="ghost" size="sm" disabled={loading || saving} onClick={reload}>
              Reload root
            </Button>
          </div>
          <ul className="divide-y rounded-md border">
            {preview.files.map((file) => (
              <li key={file.path} className="flex items-start gap-3 p-3">
                <Checkbox
                  aria-label={`Approve ${file.path}`}
                  checked={draft.paths.includes(file.path)}
                  disabled={!file.selectable || loading || saving || !allowed}
                  onCheckedChange={(checked) =>
                    dispatch({ type: "select", paths: [file.path], checked })
                  }
                />
                <div className="min-w-0 flex-1 text-xs wrap-anywhere select-text">
                  <code>{file.path}</code>
                  <p className="text-muted-foreground">
                    {formatBytes(file.size)} logical · {formatBytes(file.bytes)} allocated
                    {file.reason ? ` · ${file.reason}` : ""}
                  </p>
                </div>
              </li>
            ))}
          </ul>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <Button
              variant="outline"
              size="sm"
              disabled={loading || saving || preview.offset === 0}
              onClick={() => {
                setLoading(true);
                setRequest((value) => ({
                  ...value,
                  offset: Math.max(0, preview.offset - BUILD_REVIEW_PAGE_SIZE),
                }));
              }}
            >
              Previous page
            </Button>
            <span className="text-xs">
              {preview.totalFiles === 0
                ? "No files"
                : `${preview.offset + 1}–${preview.offset + preview.files.length} of ${preview.totalFiles}`}
            </span>
            <Button
              variant="outline"
              size="sm"
              disabled={
                loading || saving || preview.offset + preview.files.length >= preview.totalFiles
              }
              onClick={() => {
                setLoading(true);
                setRequest((value) => ({
                  ...value,
                  offset: preview.offset + BUILD_REVIEW_PAGE_SIZE,
                }));
              }}
            >
              Next page
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">
            Saving replaces the previous approval for this root. An empty selection clears approval
            and keeps the root protected. New, changed and unselected files stay protected. A later
            build or actual use can invalidate approval.
          </p>
          {!allowed && (
            <p className="text-xs">Settings write permission is required on this environment.</p>
          )}
          <Button
            variant="outline"
            size="sm"
            disabled={loading || saving || !allowed}
            onClick={() => void save()}
          >
            {saving
              ? "Saving…"
              : draft.paths.length === 0
                ? "Clear approval and keep protected"
                : `Approve ${draft.paths.length} selected files`}
          </Button>
        </>
      )}
    </div>
  );
}

function EnvironmentReview({
  environmentId,
  projectIds,
}: {
  environmentId: EnvironmentId;
  projectIds: readonly ProjectId[];
}) {
  const run = useAtomCommand(serverEnvironment.buildReviewTargets, { reportFailure: false });
  const allowed = useAtomValue(serverEnvironment.buildReviewTargets.permissionAtom(environmentId));
  const [targets, setTargets] = useState<readonly BuildReviewTarget[]>([]);
  const [targetId, setTargetId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [request, setRequest] = useState({ projectIds, revision: 0 });
  const load = useEffectEvent((destination: EnvironmentId, projects: readonly ProjectId[]) =>
    Promise.all(
      (projects.length ? projects : [null]).map((projectId) =>
        run({ environmentId: destination, input: projectId === null ? {} : { projectId } }),
      ),
    ),
  );
  useEffect(() => {
    if (!allowed) return;
    let cancelled = false;
    void load(environmentId, request.projectIds).then((results) => {
      if (cancelled) return;
      setLoading(false);
      const failure = results.find((result) => result._tag !== "Success");
      if (failure) setError(String(squashAtomCommandFailure(failure)));
      else setTargets(results.flatMap((result) => (result._tag === "Success" ? result.value : [])));
    });
    return () => {
      cancelled = true;
    };
  }, [environmentId, allowed, request]);
  const target = targets.find((entry) => entry.id === targetId);
  return (
    <div className="space-y-4">
      {!allowed ? (
        <p>Settings write permission is required on this environment.</p>
      ) : loading ? (
        <p role="status">Finding build roots…</p>
      ) : error ? (
        <div className="space-y-2">
          <p role="alert">Could not load build roots: {error}</p>
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              setLoading(true);
              setError(null);
              setRequest((value) => ({ ...value, revision: value.revision + 1 }));
            }}
          >
            Reload targets
          </Button>
        </div>
      ) : targets.length === 0 ? (
        <p>No reviewable older build roots in this scope.</p>
      ) : (
        <Select value={targetId} onValueChange={setTargetId}>
          <SelectTrigger aria-label="Project, worktree and build root">
            <SelectValue placeholder="Choose a project, worktree and build root">
              {target ? `${target.projectName} · ${target.label}` : null}
            </SelectValue>
          </SelectTrigger>
          <SelectPopup>
            {targets.map((entry) => (
              <SelectItem key={entry.id} value={entry.id}>
                {entry.projectName} · {entry.label}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
      )}
      {allowed && target && (
        <RootReview key={target.id} environmentId={environmentId} target={target} />
      )}
    </div>
  );
}

export function LegacyBuildReviewRow() {
  const { connectedEnvironments, targets } = useSettingsScope();
  const [open, setOpen] = useState(false);
  const [environmentId, setEnvironmentId] = useState<EnvironmentId | null>(null);
  const supported = connectedEnvironments.filter(
    (environment) =>
      environment.serverConfig?.environment.capabilities.worktreeBuildReview === true &&
      targets.some((target) => target.environmentId === environment.environmentId),
  );
  const environment = supported.find((entry) => entry.environmentId === environmentId);
  const projectIds = targets
    .filter((entry) => entry.environmentId === environmentId && entry.projectId !== null)
    .map((entry) => entry.projectId!);
  if (supported.length === 0) return null;
  return (
    <>
      <SettingsRow
        {...searchableSetting("storage-review-older-builds")}
        description="Choose exact files from older builds to approve for the existing automatic cleanup policy. Reviewing and saving do not delete files."
        control={
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              setEnvironmentId(null);
              setOpen(true);
            }}
          >
            Review older builds
          </Button>
        }
      />
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogPopup>
          <DialogHeader>
            <DialogTitle>Review older builds</DialogTitle>
            <DialogDescription>
              Choose a connected environment and build root, then explicitly select files to
              approve.
            </DialogDescription>
          </DialogHeader>
          <DialogPanel>
            {open && (
              <div className="space-y-4">
                <Select value={environment?.environmentId ?? null} onValueChange={setEnvironmentId}>
                  <SelectTrigger aria-label="Build review environment">
                    <SelectValue placeholder="Choose an environment">
                      {environment
                        ? settingsScopeEnvironmentLabel(environment, connectedEnvironments)
                        : null}
                    </SelectValue>
                  </SelectTrigger>
                  <SelectPopup>
                    {supported.map((entry) => (
                      <SelectItem key={entry.environmentId} value={entry.environmentId}>
                        {settingsScopeEnvironmentLabel(entry, connectedEnvironments)}
                      </SelectItem>
                    ))}
                  </SelectPopup>
                </Select>
                {environment && (
                  <EnvironmentReview
                    key={JSON.stringify([environmentId, projectIds])}
                    environmentId={environment.environmentId}
                    projectIds={projectIds}
                  />
                )}
              </div>
            )}
          </DialogPanel>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>
              Close
            </Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>
    </>
  );
}
