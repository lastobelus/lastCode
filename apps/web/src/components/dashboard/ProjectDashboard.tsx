import { effectiveSnoozed } from "@t3tools/client-runtime/state/thread-settled";
import { useNowMinute } from "../../hooks/useNowMinute";
import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import {
  buildProjectDashboard,
  type DashboardEntry,
} from "@t3tools/client-runtime/state/dashboard";
import {
  threadRuntimeIsActive,
  type EnvironmentThreadShell,
} from "@t3tools/client-runtime/state/shell";
import type { EnvironmentId, ProjectId, ScopedThreadRef } from "@t3tools/contracts";
import { Link } from "@tanstack/react-router";
import { useAtomValue } from "@effect/atom-react";
import * as Option from "effect/Option";
import { Atom } from "effect/reactivity";
import type { EnvironmentShellState } from "@t3tools/client-runtime/state/shell";
import {
  ArrowUpRightIcon,
  CheckCircle2Icon,
  ChevronDownIcon,
  CircleDotIcon,
  Clock3Icon,
  FocusIcon,
  LayoutDashboardIcon,
  MonitorIcon,
  SmartphoneIcon,
  ZapIcon,
} from "lucide-react";
import { useMemo, useState } from "react";

import { isElectron } from "../../env";
import { cn } from "../../lib/utils";
import {
  useAllEnvironmentShellsBootstrapped,
  useProjects,
  useThreadShellsForProjectRefs,
} from "../../state/entities";
import { useEnvironments } from "../../state/environments";
import { environmentShell } from "../../state/shell";
import type { Project } from "../../types";
import { WorkspacePageContainer } from "../WorkspacePageContainer";
import { WorkspacePageHeader } from "../WorkspacePageHeader";
import { Button } from "../ui/button";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { SidebarInset } from "../ui/sidebar";
import { ThreadQuickComposerDialog } from "./ThreadQuickComposerDialog";

const EMPTY_SHELL_ATOM = Atom.make<EnvironmentShellState>({
  snapshot: Option.none(),
  status: "empty",
  error: Option.none(),
});

const FILTERS = [
  { id: "all", label: "All requests", Icon: CircleDotIcon },
  { id: "quick", label: "Quick", Icon: ZapIcon },
  { id: "focused", label: "Focused", Icon: FocusIcon },
  { id: "computer", label: "Computer", Icon: MonitorIcon },
  { id: "phone", label: "On my phone", Icon: SmartphoneIcon },
] as const;
type DashboardFilter = (typeof FILTERS)[number]["id"];

const KIND_LABELS: Record<DashboardEntry["kind"], string> = {
  question: "Question",
  review: "Review",
  qa: "QA",
  metric: "Metric",
  progress: "Progress",
  summary: "Summary",
  approval: "Approval",
  input: "Input",
  failure: "Needs a check",
};

function matchesFilter(entry: DashboardEntry, filter: DashboardFilter) {
  switch (filter) {
    case "quick":
      return entry.effort === "quick";
    case "focused":
      return entry.effort === "focused";
    case "computer":
      return entry.requiresComputer;
    case "phone":
      return !entry.requiresComputer;
    case "all":
      return true;
  }
}

function formatTimestamp(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? "Unknown time"
    : date.toLocaleString(undefined, {
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
      });
}

function SourceThreadLink({ thread }: { readonly thread: EnvironmentThreadShell }) {
  return (
    <Link
      to="/$environmentId/$threadId"
      params={{ environmentId: thread.environmentId, threadId: thread.id }}
      className="inline-flex min-w-0 items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground hover:underline"
    >
      <span className="truncate">{thread.title}</span>
      <ArrowUpRightIcon aria-hidden className="size-3.5 shrink-0" />
    </Link>
  );
}

function DashboardItem({
  entry,
  onMessage,
}: {
  readonly entry: DashboardEntry;
  readonly onMessage: (target: ScopedThreadRef) => void;
}) {
  return (
    <details className="group rounded-xl border border-border/70 bg-card/30 open:bg-card/50">
      <summary className="flex cursor-pointer list-none items-start gap-3 p-4 outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset [&::-webkit-details-marker]:hidden">
        <span
          className={cn(
            "mt-1 size-2 shrink-0 rounded-full",
            entry.priority === "high" ? "bg-warning" : "bg-primary/70",
          )}
        />
        <div className="min-w-0 flex-1">
          <div className="mb-1.5 flex flex-wrap items-center gap-2 text-2xs text-muted-foreground">
            <span className="font-medium uppercase tracking-wider">{KIND_LABELS[entry.kind]}</span>
            {entry.priority === "high" ? (
              <span className="text-warning-foreground">High priority</span>
            ) : null}
            {entry.effort === "quick" ? (
              <span className="inline-flex items-center gap-1">
                <ZapIcon className="size-3" />
                Quick
              </span>
            ) : null}
            {entry.effort === "focused" ? (
              <span className="inline-flex items-center gap-1">
                <FocusIcon className="size-3" />
                Focused
              </span>
            ) : null}
            {entry.requiresComputer ? (
              <span className="inline-flex items-center gap-1">
                <MonitorIcon className="size-3" />
                Computer
              </span>
            ) : null}
          </div>
          <h3 className="text-sm font-medium text-foreground">{entry.title}</h3>
          <p className="mt-1 truncate text-xs text-muted-foreground">{entry.thread.title}</p>
        </div>
        <ChevronDownIcon
          aria-hidden
          className="mt-1 size-4 shrink-0 text-muted-foreground group-open:rotate-180"
        />
      </summary>
      <div className="flex flex-col gap-4 border-t border-border/50 px-4 py-4 sm:pl-9">
        {entry.body ? (
          <p className="whitespace-pre-wrap wrap-break-word text-sm leading-6 text-foreground/85">
            {entry.body}
          </p>
        ) : null}
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="min-w-0">
            <SourceThreadLink thread={entry.thread} />
            <p className="mt-1 text-xs text-muted-foreground">
              Raised <time dateTime={entry.raisedAt}>{formatTimestamp(entry.raisedAt)}</time>
              {entry.updatedAt !== entry.raisedAt ? (
                <>
                  {" "}
                  · Updated{" "}
                  <time dateTime={entry.updatedAt}>{formatTimestamp(entry.updatedAt)}</time>
                </>
              ) : null}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              onClick={() =>
                onMessage({ environmentId: entry.thread.environmentId, threadId: entry.thread.id })
              }
            >
              Message
            </Button>
            <Button
              size="sm"
              variant="outline"
              render={
                <Link
                  to="/$environmentId/$threadId"
                  params={{ environmentId: entry.thread.environmentId, threadId: entry.thread.id }}
                />
              }
            >
              Open thread <ArrowUpRightIcon />
            </Button>
          </div>
        </div>
      </div>
    </details>
  );
}

export function ProjectDashboard({
  environmentId,
  projectId,
  onSelectProject,
}: {
  readonly environmentId?: EnvironmentId | undefined;
  readonly projectId?: ProjectId | undefined;
  readonly onSelectProject: (project: Project) => void;
}) {
  const now = useNowMinute();
  const projects = useProjects();
  const { environments } = useEnvironments();
  const bootstrapped = useAllEnvironmentShellsBootstrapped();
  const [filter, setFilter] = useState<DashboardFilter>("all");
  const [messageTarget, setMessageTarget] = useState<ScopedThreadRef | null>(null);
  const project =
    projects.find(
      (candidate) => candidate.id === projectId && candidate.environmentId === environmentId,
    ) ?? null;
  const refs = useMemo(
    () => (project ? [scopeProjectRef(project.environmentId, project.id)] : []),
    [project],
  );
  const threads = useThreadShellsForProjectRefs(refs);
  const dashboard = useMemo(
    () => buildProjectDashboard(threads, refs[0], now),
    [threads, refs, now],
  );
  const requests = dashboard.entries.filter((entry) => entry.actionable);
  const visibleRequests = requests.filter((entry) => matchesFilter(entry, filter));
  const updates = dashboard.entries.filter((entry) => !entry.actionable);
  const environment = environments.find(
    (candidate) => candidate.environmentId === project?.environmentId,
  );
  const shellState = useAtomValue(
    project ? environmentShell.stateValueAtom(project.environmentId) : EMPTY_SHELL_ATOM,
  );
  const connected = environment?.connection.phase === "connected" && shellState.status === "live";
  const connectionLabel = connected
    ? `Live · ${environment.label}`
    : environment?.connection.phase === "connected" || shellState.status === "synchronizing"
      ? "Synchronizing · showing last known state"
      : environment?.connection.phase === "connecting" ||
          environment?.connection.phase === "reconnecting"
        ? "Connecting · showing last known state"
        : "Disconnected · showing last known state";
  const latestUpdate = threads.reduce(
    (latest, thread) => (thread.updatedAt > latest ? thread.updatedAt : latest),
    "",
  );
  const currentWork = threads.filter(
    (thread) =>
      thread.deletedAt === null &&
      thread.archivedAt === null &&
      (thread.lineage.relationshipToParent !== "subagent" || thread.lineage.independent === true) &&
      (threadRuntimeIsActive(thread.runtime) || thread.pendingBackgroundTasks.length > 0),
  );
  const projectOptions = projects.map((candidate) => ({
    value: `${candidate.environmentId}:${candidate.id}`,
    label: `${candidate.title} · ${environments.find((item) => item.environmentId === candidate.environmentId)?.label ?? "Environment"}`,
    project: candidate,
  }));
  const filterCounts: Record<DashboardFilter, number> = {
    all: dashboard.counts.needsAttention,
    quick: dashboard.counts.quick,
    focused: dashboard.counts.focused,
    computer: dashboard.counts.computer,
    phone: requests.filter((entry) => !entry.requiresComputer).length,
  };

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden">
      <WorkspacePageHeader electron={isElectron} className="border-b border-border">
        <LayoutDashboardIcon className="size-4 text-muted-foreground" />
        <span className="text-sm font-medium">Dashboard</span>
        <span className="truncate text-sm text-muted-foreground">{project?.title}</span>
      </WorkspacePageHeader>
      <main className="min-h-0 flex-1 overflow-y-auto">
        <WorkspacePageContainer width="wide">
          <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-start">
            <div>
              <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
                Project dashboard
              </p>
              <h1 className="mt-1 text-2xl font-semibold tracking-tight">
                {project?.title ?? "Choose a project"}
              </h1>
              <p className="mt-2 text-sm text-muted-foreground">
                What’s moving, what needs you, and what you’ve parked.
              </p>
            </div>
            {projects.length > 0 ? (
              <div className="w-full sm:w-64">
                <Select
                  items={projectOptions}
                  value={project ? `${project.environmentId}:${project.id}` : null}
                  onValueChange={(value) => {
                    const selected = projectOptions.find((option) => option.value === value);
                    if (selected) {
                      setFilter("all");
                      onSelectProject(selected.project);
                    }
                  }}
                >
                  <SelectTrigger aria-label="Dashboard project">
                    <SelectValue placeholder="Choose a project" />
                  </SelectTrigger>
                  <SelectPopup>
                    {projectOptions.map((option) => (
                      <SelectItem key={option.value} value={option.value}>
                        {option.label}
                      </SelectItem>
                    ))}
                  </SelectPopup>
                </Select>
              </div>
            ) : null}
          </div>

          {!project ? (
            <div className="rounded-xl border border-dashed border-border px-6 py-12 text-center">
              <LayoutDashboardIcon className="mx-auto mb-3 size-6 text-muted-foreground" />
              <h2 className="text-base font-medium">
                {!bootstrapped
                  ? "Loading projects…"
                  : projectId
                    ? "Project unavailable"
                    : projects.length
                      ? "Your project at a glance"
                      : "No projects yet"}
              </h2>
              <p className="mt-2 text-sm text-muted-foreground">
                {projectId
                  ? "This project is no longer available in the selected environment. Choose another project or check Connections."
                  : "Choose a project to see its live activity and outstanding requests."}
              </p>
              {projectId ? (
                <div className="mt-4">
                  <Button size="sm" variant="outline" render={<Link to="/settings/connections" />}>
                    Open Connections
                  </Button>
                </div>
              ) : null}
            </div>
          ) : (
            <>
              <div
                className={cn(
                  "flex flex-wrap items-center gap-x-3 gap-y-1 text-xs",
                  connected ? "text-muted-foreground" : "text-warning-foreground",
                )}
                role="status"
              >
                <span
                  className={cn("size-1.5 rounded-full", connected ? "bg-success" : "bg-warning")}
                />
                <span>{connectionLabel}</span>
                {latestUpdate ? (
                  <span>
                    Latest thread update{" "}
                    <time dateTime={latestUpdate}>{formatTimestamp(latestUpdate)}</time>
                  </span>
                ) : null}
              </div>
              <div className="grid grid-cols-3 gap-3">
                {[
                  { label: "Active threads", count: dashboard.counts.active, Icon: CircleDotIcon },
                  { label: "Waiting threads", count: dashboard.counts.waiting, Icon: Clock3Icon },
                  { label: "Need you", count: dashboard.counts.needsAttention, Icon: FocusIcon },
                ].map(({ label, count, Icon }) => (
                  <div key={label} className="rounded-xl border border-border/70 bg-card/25 p-4">
                    <Icon aria-hidden className="mb-3 size-4 text-muted-foreground" />
                    <p className="text-2xl font-semibold tabular-nums">{count}</p>
                    <p className="mt-1 text-xs text-muted-foreground">{label}</p>
                  </div>
                ))}
              </div>

              <section
                aria-labelledby="dashboard-attention-heading"
                className="flex flex-col gap-3"
              >
                <div className="flex items-baseline justify-between gap-3">
                  <h2 id="dashboard-attention-heading" className="text-base font-medium">
                    Needs your attention
                  </h2>
                  <span className="text-xs text-muted-foreground">
                    {requests.length} requests · {dashboard.counts.total} threads
                  </span>
                </div>
                <div className="flex flex-wrap gap-1.5" aria-label="Filter requests">
                  {FILTERS.map(({ id, label, Icon }) => (
                    <Button
                      key={id}
                      size="sm"
                      variant={filter === id ? "secondary" : "ghost-muted"}
                      aria-pressed={filter === id}
                      onClick={() => setFilter(id)}
                    >
                      <Icon />
                      {label}
                      <span className="tabular-nums">{filterCounts[id]}</span>
                    </Button>
                  ))}
                </div>
                <p className="text-xs text-muted-foreground">
                  Effort and computer requirements overlap. Opening a request leaves it open.
                </p>
                {visibleRequests.length > 0 ? (
                  visibleRequests.map((entry) => (
                    <DashboardItem key={entry.id} entry={entry} onMessage={setMessageTarget} />
                  ))
                ) : (
                  <div className="rounded-xl border border-dashed border-border px-5 py-8 text-center">
                    <CheckCircle2Icon className="mx-auto mb-2 size-5 text-muted-foreground" />
                    <p className="text-sm font-medium">
                      {requests.length === 0
                        ? connected
                          ? "Nothing needs your attention"
                          : "No requests in the last known state"
                        : "No requests match this filter"}
                    </p>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {requests.length === 0
                        ? "Questions, reviews, and QA reported by your threads appear here."
                        : "Try All requests to see the rest of the project."}
                    </p>
                  </div>
                )}
              </section>

              {currentWork.length > 0 ? (
                <section aria-labelledby="dashboard-work-heading">
                  <h2 id="dashboard-work-heading" className="mb-3 text-base font-medium">
                    Work in motion
                  </h2>
                  <div className="divide-y divide-border/60 rounded-xl border border-border/70">
                    {currentWork.map((thread) => (
                      <div
                        key={`${thread.environmentId}:${thread.id}`}
                        className="flex items-center justify-between gap-3 px-4 py-3"
                      >
                        <SourceThreadLink thread={thread} />
                        <span className="shrink-0 text-xs text-muted-foreground">
                          {thread.runtime?.status === "waiting"
                            ? "Waiting"
                            : threadRuntimeIsActive(thread.runtime)
                              ? "Active"
                              : "Background work"}
                        </span>
                      </div>
                    ))}
                  </div>
                </section>
              ) : null}
              {updates.length > 0 ? (
                <section
                  aria-labelledby="dashboard-updates-heading"
                  className="flex flex-col gap-3"
                >
                  <h2 id="dashboard-updates-heading" className="text-base font-medium">
                    Progress & updates
                  </h2>
                  {updates.map((entry) => (
                    <DashboardItem key={entry.id} entry={entry} onMessage={setMessageTarget} />
                  ))}
                </section>
              ) : null}
              {dashboard.parked.length > 0 ? (
                <details className="group rounded-xl border border-border/70">
                  <summary className="flex cursor-pointer list-none items-center justify-between gap-3 p-4 text-sm font-medium [&::-webkit-details-marker]:hidden">
                    <span>
                      Parked contexts{" "}
                      <span className="ml-2 text-muted-foreground">{dashboard.parked.length}</span>
                    </span>
                    <ChevronDownIcon className="size-4 text-muted-foreground group-open:rotate-180" />
                  </summary>
                  <div className="border-t border-border/60 px-4 py-3">
                    <p className="mb-3 text-xs text-muted-foreground">
                      Settled and snoozed threads remain available. Their open requests stay in the
                      attention list.
                    </p>
                    <div className="flex flex-col gap-3">
                      {dashboard.parked.map((thread) => (
                        <div key={thread.id} className="flex items-center justify-between gap-3">
                          <SourceThreadLink thread={thread} />
                          <span className="text-xs text-muted-foreground">
                            {effectiveSnoozed(thread, { now }) ? "Snoozed" : "Settled"}
                          </span>
                        </div>
                      ))}
                    </div>
                  </div>
                </details>
              ) : null}
            </>
          )}
        </WorkspacePageContainer>
      </main>
      <ThreadQuickComposerDialog
        target={messageTarget}
        onOpenChange={(open) => {
          if (!open) setMessageTarget(null);
        }}
      />
    </SidebarInset>
  );
}
