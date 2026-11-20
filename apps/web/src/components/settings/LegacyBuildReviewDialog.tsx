import { useAtomValue } from "@effect/atom-react";
import type {
  BuildReviewPreview,
  BuildReviewTarget,
  EnvironmentId,
  ProjectId,
} from "@t3tools/contracts";
import { BUILD_REVIEW_PAGE_SIZE } from "@t3tools/contracts";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { msg, T, useGT, useMessages, Var } from "gt-react";
import { useEffect, useEffectEvent, useReducer, useState } from "react";
import { m, type MessageResolver } from "../../i18n/messages";
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
import { useSearchableSetting } from "./settingsSearch";
import { buildReviewDraftReducer, EMPTY_BUILD_REVIEW_DRAFT } from "./buildReviewDraft";

function eligibility(target: BuildReviewTarget, resolve: MessageResolver = m) {
  if (target.protectedReason) return target.protectedReason;
  if (target.delayDays === null) {
    return resolve(
      msg("Automatic dependency and build cleanup is Off. Approval does not enable it."),
    );
  }
  if (target.archived) {
    return resolve(
      msg(
        "Archived owners are eligible immediately while automatic cleanup is enabled, subject to active-consumer checks.",
      ),
    );
  }
  if (target.eligibleAt !== null) {
    return resolve(
      msg("Eligible after {date}, subject to active-consumer checks.", {
        date: new Date(target.eligibleAt).toLocaleString(),
      }),
    );
  }
  return resolve(
    msg(
      "Without a trusted use date, this build starts the full {days}-day delay. An old folder date does not make it eligible sooner.",
      { days: target.delayDays },
    ),
  );
}

function RootReview({
  environmentId,
  target,
}: {
  environmentId: EnvironmentId;
  target: BuildReviewTarget;
}) {
  const gt = useGT();
  const resolve = useMessages();
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
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- owns the server build-preview request for the mounted review and ignores its result after cleanup
  useEffect(() => {
    let cancelled = false;
    void load(environmentId, target.id, request.offset).then((result) => {
      if (cancelled) return;
      setLoading(false);
      if (result._tag === "Success") acceptPreview(result.value);
      else
        dispatch({
          type: "reset",
          notice: msg("Could not load this build. Reload to review again. {error}", {
            error: String(squashAtomCommandFailure(result)),
          }),
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
        msg("{message} {count} files approved. Saving does not delete files.", {
          message: result.value.message,
          count: result.value.selectedCount,
        }),
      );
      reload();
    } else {
      dispatch({
        type: "reset",
        notice: msg("Approval was not saved. Reload this root and select files again. {error}", {
          error: String(squashAtomCommandFailure(result)),
        }),
      });
    }
  };
  return (
    <div className="space-y-4">
      <div className="space-y-1 text-xs wrap-anywhere select-text">
        <p>
          {target.projectName} · {target.branch ?? gt("No branch", { $context: "no Git branch" })}
        </p>
        <p>
          <T>
            Worktree:{" "}
            <code>
              <Var>{target.worktreePath}</Var>
            </code>
          </T>
        </p>
        <p>
          <T>
            Build root:{" "}
            <code>
              <Var>{target.root}</Var>
            </code>
          </T>
        </p>
        <p>{eligibility(preview?.target ?? target, resolve)}</p>
      </div>
      <p className="text-xs text-muted-foreground">
        <T>
          Review is limited to 1,000 files and 512 MiB per root, in pages of 200. Only unchanged
          files you explicitly select can be reclaimed by the current automatic dependency and build
          cleanup policy. Source and other files remain protected.
        </T>
      </p>
      {message && (
        <p role="status" className="text-sm">
          {resolve(message)}
        </p>
      )}
      {draft.notice && (
        <p role="alert" className="text-sm text-destructive">
          {resolve(draft.notice)}
        </p>
      )}
      {loading && (
        <p role="status" className="text-sm">
          <T>Loading build files…</T>
        </p>
      )}
      {!loading && !preview && (
        <Button variant="outline" size="sm" onClick={reload}>
          <T>Reload root</T>
        </Button>
      )}
      {preview && (
        <>
          <p className="text-xs text-muted-foreground">
            {gt(
              "{files} files · {logical} logical · {allocated} allocated estimate. Previously approved: {previous}. This review: {selected} selected.",
              {
                files: preview.totalFiles.toLocaleString(),
                logical: formatBytes(preview.totalSize),
                allocated: formatBytes(preview.totalBytes),
                previous: preview.selectedPaths.length,
                selected: draft.paths.length,
              },
            )}
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
              <T>Select this page</T>
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
              <T>Clear this page</T>
            </Button>
            <Button variant="ghost" size="sm" disabled={loading || saving} onClick={reload}>
              <T>Reload root</T>
            </Button>
          </div>
          <ul className="divide-y rounded-md border">
            {preview.files.map((file) => (
              <li key={file.path} className="flex items-start gap-3 p-3">
                <Checkbox
                  aria-label={gt("Approve {path}", { path: file.path })}
                  checked={draft.paths.includes(file.path)}
                  disabled={!file.selectable || loading || saving || !allowed}
                  onCheckedChange={(checked) =>
                    dispatch({ type: "select", paths: [file.path], checked })
                  }
                />
                <div className="min-w-0 flex-1 text-xs wrap-anywhere select-text">
                  <code>{file.path}</code>
                  <p className="text-muted-foreground">
                    <T>
                      <Var>{formatBytes(file.size)}</Var> logical ·{" "}
                      <Var>{formatBytes(file.bytes)}</Var> allocated
                    </T>
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
              <T>Previous page</T>
            </Button>
            <span className="text-xs">
              {preview.totalFiles === 0
                ? gt("No files")
                : gt("{first}–{last} of {total}", {
                    first: preview.offset + 1,
                    last: preview.offset + preview.files.length,
                    total: preview.totalFiles,
                  })}
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
              <T>Next page</T>
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">
            <T>
              Saving replaces the previous approval for this root. An empty selection clears
              approval and keeps the root protected. New, changed and unselected files stay
              protected. A later build or actual use can invalidate approval.
            </T>
          </p>
          {!allowed && (
            <p className="text-xs">
              <T>Settings write permission is required on this environment.</T>
            </p>
          )}
          <Button
            variant="outline"
            size="sm"
            disabled={loading || saving || !allowed}
            onClick={() => void save()}
          >
            {saving
              ? gt("Saving…")
              : draft.paths.length === 0
                ? gt("Clear approval and keep protected")
                : gt("Approve {count} selected files", { count: draft.paths.length })}
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
  const gt = useGT();
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
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- owns the server build-target discovery requests for the mounted settings view and ignores results after cleanup
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
        <p>
          <T>Settings write permission is required on this environment.</T>
        </p>
      ) : loading ? (
        <p role="status">
          <T>Finding build roots…</T>
        </p>
      ) : error ? (
        <div className="space-y-2">
          <p role="alert">
            <T>
              Could not load build roots: <Var>{error}</Var>
            </T>
          </p>
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              setLoading(true);
              setError(null);
              setRequest((value) => ({ ...value, revision: value.revision + 1 }));
            }}
          >
            <T>Reload targets</T>
          </Button>
        </div>
      ) : targets.length === 0 ? (
        <p>
          <T>No reviewable older build roots in this scope.</T>
        </p>
      ) : (
        <Select value={targetId} onValueChange={setTargetId}>
          <SelectTrigger aria-label={gt("Project, worktree and build root")}>
            <SelectValue placeholder={gt("Choose a project, worktree and build root")}>
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
  const gt = useGT();
  const setting = useSearchableSetting();
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
        {...setting("storage-review-older-builds")}
        description={gt(
          "Choose exact files from older builds to approve for the existing automatic cleanup policy. Reviewing and saving do not delete files.",
        )}
        control={
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              setEnvironmentId(null);
              setOpen(true);
            }}
          >
            <T>Review older builds</T>
          </Button>
        }
      />
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogPopup>
          <DialogHeader>
            <DialogTitle>
              <T>Review older builds</T>
            </DialogTitle>
            <DialogDescription>
              <T>
                Choose a connected environment and build root, then explicitly select files to
                approve.
              </T>
            </DialogDescription>
          </DialogHeader>
          <DialogPanel>
            {open && (
              <div className="space-y-4">
                <Select value={environment?.environmentId ?? null} onValueChange={setEnvironmentId}>
                  <SelectTrigger aria-label={gt("Build review environment")}>
                    <SelectValue placeholder={gt("Choose an environment")}>
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
              <T context="verb, closes the older build review dialog">Close</T>
            </Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>
    </>
  );
}
