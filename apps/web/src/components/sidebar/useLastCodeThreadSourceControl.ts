import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import { resolveThreadCurrentPullRequestLink } from "@t3tools/shared/threadPullRequests";
import { useProject } from "../../state/entities";
import { useEnvironmentQuery } from "../../state/query";
import { vcsEnvironment } from "../../state/vcs";
import { useSupportsMultiplePullRequests } from "../../hooks/useSupportsMultiplePullRequests";
import { prStatusIndicator, useLinkedThreadPullRequest } from "../ThreadStatusIndicators";
import { resolveCheckoutBranchMismatch } from "../BranchToolbar.logic";
import type { SidebarThreadSummary } from "../../types";

/** A linked PR already supplies status; only leased branch rows need the local checkout query. */
function threadGitStatusQuery(thread: SidebarThreadSummary, live: boolean, cwd: string | null) {
  if (!live) return null;
  if (thread.linkedPullRequest != null) return null;
  if (thread.branch == null) return null;
  if (cwd === null) return null;
  return vcsEnvironment.status({
    environmentId: thread.environmentId,
    input: { cwd, includeRemote: false },
  });
}

export function useLastCodeThreadSourceControl(
  thread: SidebarThreadSummary,
  leaseLiveStatus: boolean,
  projectCwdFallback: string | null,
) {
  // For grouped projects, the thread may belong to a different environment
  // than the representative project.  Look up the thread's own project cwd
  // so git status (and thus PR detection) queries the correct path.
  const threadProject = useProject(scopeProjectRef(thread.environmentId, thread.projectId));
  const threadProjectCwd = threadProject?.workspaceRoot ?? null;
  const gitCwd = thread.worktreePath ?? threadProjectCwd ?? projectCwdFallback;
  const gitStatus = useEnvironmentQuery(threadGitStatusQuery(thread, leaseLiveStatus, gitCwd));
  const linkedPullRequestStatus = useLinkedThreadPullRequest(
    thread.environmentId,
    thread.linkedPullRequest,
    leaseLiveStatus,
    thread.pullRequests,
    thread.branchPullRequest,
  );
  const pr = linkedPullRequestStatus?.pr ?? null;
  const supportsMultiplePullRequests = useSupportsMultiplePullRequests(thread.environmentId);
  const currentLinkedPr = supportsMultiplePullRequests
    ? resolveThreadCurrentPullRequestLink(thread.pullRequests)
    : null;
  const prStatus = prStatusIndicator(pr, linkedPullRequestStatus?.sourceControlProvider);
  const branchMismatch = resolveCheckoutBranchMismatch({
    effectiveEnvMode: thread.worktreePath === null ? "local" : "worktree",
    activeWorktreePath: thread.worktreePath,
    activeThreadBranch: thread.branch,
    currentGitBranch: gitStatus.data?.refName ?? null,
  });
  return { gitCwd, threadProject, threadProjectCwd, branchMismatch, pr, prStatus, currentLinkedPr };
}
export type LastCodeThreadSourceControlSnapshot = ReturnType<typeof useLastCodeThreadSourceControl>;
