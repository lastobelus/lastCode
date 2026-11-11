import { isAbsolutePath } from "@t3tools/shared/path";
import {
  needsWorkspaceBasenameLookup,
  pickWorkspaceBasenameMatch,
  pickStrippedWorkspaceMatch,
  stripRepeatedWorkspacePrefix,
  type WorkspaceEntryCandidate,
} from "@t3tools/shared/workspaceBasenameLookup";

// All callers open one panel; the newest click must win across callers.
let latestLookupSequence = 0;

export function claimWorkspaceBasenameLookup(): () => boolean {
  latestLookupSequence += 1;
  const claimed = latestLookupSequence;
  return () => claimed === latestLookupSequence;
}

/**
 * The project search query that may find a chat file link's real file, or null when the link
 * names its file exactly. Agents often cite paths relative to a package (`cloud/http.ts`).
 */
export function workspaceLinkLookupQuery(relativePath: string, cwd: string): string | null {
  const trimmed = relativePath.trim();
  if (isAbsolutePath(trimmed) || /^(?:\.{1,2}|~)[\\/]/.test(trimmed) || /[\\/]$/.test(trimmed)) {
    return null;
  }
  if (needsWorkspaceBasenameLookup(trimmed)) return trimmed;
  return stripRepeatedWorkspacePrefix(trimmed, cwd) ?? trimmed;
}

/** The one file a chat link names: its basename, its path past a repeated prefix, or its suffix. */
export function pickWorkspaceLinkMatch(
  relativePath: string,
  cwd: string,
  entries: ReadonlyArray<WorkspaceEntryCandidate>,
): string | null {
  const trimmed = relativePath.trim();
  if (needsWorkspaceBasenameLookup(trimmed)) return pickWorkspaceBasenameMatch(trimmed, entries);
  const stripped = stripRepeatedWorkspacePrefix(trimmed, cwd);
  const strippedMatch =
    stripped === null ? null : pickStrippedWorkspaceMatch(stripped, cwd, entries);
  if (strippedMatch !== null) return strippedMatch;
  const suffix = trimmed.replaceAll("\\", "/");
  const matches = entries.filter(
    (entry) =>
      entry.kind === "file" &&
      (entry.path.replaceAll("\\", "/") === suffix ||
        entry.path.replaceAll("\\", "/").endsWith(`/${suffix}`)),
  );
  return matches.length === 1 ? (matches[0]?.path ?? null) : null;
}
