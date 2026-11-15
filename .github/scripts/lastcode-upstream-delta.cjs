// Local use: node .github/scripts/lastcode-upstream-delta.cjs <pr-base> <pr-head> [upstream-ref]
const { execFileSync } = require("node:child_process");
const { appendFileSync } = require("node:fs");

function git(...args) {
  return execFileSync("git", args, {
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function report(baseRef, headRef, upstreamRef = "origin/main") {
  if (!baseRef || !headRef) throw new Error("Pass PR base and head commits.");
  const resolve = (ref) =>
    git("rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`).trim();
  const base = resolve(baseRef);
  const head = resolve(headRef);
  const upstream = git("merge-base", base, resolve(upstreamRef)).trim();
  const owned = new Set(git("ls-tree", "-rz", "--name-only", upstream).split("\0"));
  const count = (from) => {
    let added = 0;
    let deleted = 0;
    // Disable rename detection: moving an upstream path out of the fixed set is a deletion.
    // Filter the NUL-delimited output rather than putting thousands of paths in argv.
    for (const row of git(
      "diff",
      "--no-ext-diff",
      "--no-textconv",
      "--no-renames",
      "--numstat",
      "-z",
      from,
      head,
      "--",
    ).split("\0")) {
      const match = /^(\d+|-)\t(\d+|-)\t([\s\S]*)$/.exec(row);
      if (!match || !owned.has(match[3]) || match[1] === "-") continue;
      added += Number(match[1]);
      deleted += Number(match[2]);
    }
    return `| ${added} | ${deleted} |`;
  };
  return [
    "## Upstream-owned line changes",
    "",
    "| Comparison | Lines added | Lines deleted |",
    "| --- | ---: | ---: |",
    `| This PR ${count(base)}`,
    `| Whole fork ${count(upstream)}`,
    "",
    `Pinned upstream commit: \`${upstream}\` (merge base of PR base and \`${upstreamRef}\`).`,
    `PR base: \`${base}\`; head: \`${head}\`.`,
    "Paths are fixed to those present at the pinned commit. Counts compare endpoints, with renames treated as deletion/addition. Binary files are excluded from line counts. Reporting only; no threshold.",
    "",
  ].join("\n");
}

let output;
try {
  output = report(...process.argv.slice(2));
} catch (error) {
  output =
    "## Upstream-owned line changes unavailable\n\nCould not resolve the comparison. Reporting only; CI is not blocked.\n";
  console.error(error.message);
}
process.stdout.write(output);
if (process.env.GITHUB_STEP_SUMMARY) {
  try {
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, output);
  } catch (error) {
    console.error(`Could not write job summary: ${error.message}`);
  }
}
