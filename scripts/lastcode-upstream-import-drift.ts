const MANIFEST = "scripts/lastcode-upstream-imports.json";
const REPOSITORY = /^[\w.-]+\/[\w.-]+$/u;
const HEAD = /^[0-9a-f]{40}$/u;

interface UpstreamImport {
  readonly upstreamRepo: string;
  readonly pullRequest: number;
  readonly pinnedHead: string;
  readonly trackingRepo: string;
  readonly trackingIssue: number;
}

type Command = (args: ReadonlyArray<string>) => string;

function checkImport(entry: UpstreamImport, api: Command): string {
  const key = `${entry.upstreamRepo}/${entry.pullRequest}`;
  const { head, state } = JSON.parse(
    api([
      `repos/${entry.upstreamRepo}/pulls/${entry.pullRequest}`,
      "--jq",
      '{head: .head.sha, state: (if .merged then "merged" else .state end)}',
    ]),
  ) as { head: string; state: string };
  if (!HEAD.test(head) || !["open", "closed", "merged"].includes(state)) {
    throw new Error("GitHub returned an invalid PR head or state.");
  }

  const marker = `<!-- lastcode-upstream-import: ${key} -->`;
  const comments = `repos/${entry.trackingRepo}/issues/${entry.trackingIssue}/comments`;
  const latest = api([
    `${comments}?per_page=100`,
    "--paginate",
    "--jq",
    `.[] | (.body // "") | select(startswith(${JSON.stringify(`${marker}\n`)})) | @json`,
  ])
    .split("\n")
    .at(-1);
  const drift = head !== entry.pinnedHead || state !== "open";
  if (!drift && !latest) return `${key} matches the pinned head.`;

  const summary = drift ? "Upstream import drift" : "Upstream import returned to the pinned head";
  const body = [
    marker,
    `### ${summary}`,
    "",
    `[Upstream PR](https://redirect.github.com/${entry.upstreamRepo}/pull/${entry.pullRequest}) is ${state}.`,
    "",
    `- Pinned head: \`${entry.pinnedHead}\``,
    `- Observed head: \`${head}\``,
  ].join("\n");
  if (latest && JSON.parse(latest) === body) return `${key} observation already reported.`;
  api([comments, "--method", "POST", "-f", `body=${body}`]);
  return `${key} observation reported on ${entry.trackingRepo}/issues/${entry.trackingIssue}.`;
}

export function reportUpstreamImportDrift(input: {
  readonly sourceCommit: string;
  readonly git: Command;
  readonly api: Command;
  readonly log: (message: string) => void;
  readonly warn: (message: string) => void;
}): void {
  let imports: unknown;
  try {
    if (!input.git(["ls-tree", "--name-only", input.sourceCommit, "--", MANIFEST])) return;
    imports = JSON.parse(input.git(["show", `${input.sourceCommit}:${MANIFEST}`]));
    if (!Array.isArray(imports)) throw new Error("Expected an array of imports.");
  } catch (error) {
    input.warn(`Cannot read upstream import pins: ${String(error)}`);
    return;
  }

  for (const entry of imports as UpstreamImport[]) {
    if (
      !entry ||
      !REPOSITORY.test(entry.upstreamRepo) ||
      !REPOSITORY.test(entry.trackingRepo) ||
      !HEAD.test(entry.pinnedHead) ||
      !Number.isSafeInteger(entry.pullRequest) ||
      entry.pullRequest < 1 ||
      !Number.isSafeInteger(entry.trackingIssue) ||
      entry.trackingIssue < 1
    ) {
      input.warn("Invalid upstream import pin in the checkpoint source.");
      continue;
    }
    try {
      input.log(checkImport(entry, input.api));
    } catch (error) {
      input.warn(`Cannot report ${entry.upstreamRepo}/${entry.pullRequest}: ${String(error)}`);
    }
  }
}
