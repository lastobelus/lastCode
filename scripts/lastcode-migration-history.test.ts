// @effect-diagnostics nodeBuiltinImport:off -- Tests reconstruct disposable Git histories.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { assert, describe, it } from "@effect/vitest";

import { assertMigrationHistory, readMigrationIdentities } from "./lastcode-migration-history.ts";

const ROOT = "apps/server/src/persistence/";
const legacyHistories = (name = "Annotation", extra = "") =>
  `export const legacyMigrationHistories = [
    { source: "lastcode/build/released", entries: [[42, "${name}"]], },
    ${extra}
  ] as const;`;
const registry = (names: ReadonlyArray<string>, downstream = false) =>
  names.map((name, i) => `import Migration${i} from "./Migrations/${name}.ts";`).join("\n") +
  `\nexport const ${downstream ? "lastcodeMigrationEntries" : "migrationEntries"} = [\n` +
  names.map((name, i) => `  [${i + 1}, "${name}", Migration${i}],`).join("\n") +
  "\n] as const;\n";

function fixture(
  run: (
    repo: string,
    git: (...args: Array<string>) => string,
    write: (path: string, source: string) => void,
  ) => void,
) {
  const repo = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "migration-history-"));
  const git = (...args: Array<string>) =>
    NodeChildProcess.execFileSync("git", args, {
      cwd: repo,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  const write = (path: string, source: string) => {
    NodeFS.mkdirSync(NodePath.dirname(NodePath.join(repo, path)), { recursive: true });
    NodeFS.writeFileSync(NodePath.join(repo, path), source);
  };
  try {
    git("init", "-q");
    git("config", "user.name", "Migration Test");
    git("config", "user.email", "migration@example.com");
    git("config", "commit.gpgsign", "false");
    run(repo, git, write);
  } finally {
    NodeFS.rmSync(repo, { recursive: true, force: true });
  }
}

describe("checkpoint migration history", () => {
  it("rejects duplicate slots, duplicate names, and computed registries", () => {
    const source = registry(["First", "Second"], true);
    assert.throws(
      () =>
        readMigrationIdentities(
          source.replace('[2, "Second"', '[1, "Second"'),
          "lastcodeMigrationEntries",
        ),
      /Duplicate or unordered/,
    );
    assert.throws(
      () =>
        readMigrationIdentities(
          source.replace('[2, "Second"', '[2, "First"'),
          "lastcodeMigrationEntries",
        ),
      /Duplicate or unordered/,
    );
    assert.throws(
      () =>
        readMigrationIdentities(
          source.replace('[2, "Second", Migration1]', "...otherMigrations"),
          "lastcodeMigrationEntries",
        ),
      /Unsupported entry/,
    );
  });

  it("reconstructs successive upstream checkpoints without renumbering LastCode migrations", () =>
    fixture((repo, git, write) => {
      const commit = (name: string) => {
        git("add", ".");
        git("commit", "-qm", name);
        return git("rev-parse", "HEAD");
      };
      const upstream = (names: ReadonlyArray<string>) => {
        write(`${ROOT}Migrations.ts`, registry(names));
        for (const name of names)
          write(`${ROOT}Migrations/${name}.ts`, `export default "${name}";\n`);
      };
      const downstream = (names = ["Annotation"]) => {
        write(`${ROOT}LastCodeMigrations.ts`, registry(names, true));
        for (const name of names)
          write(`${ROOT}Migrations/${name}.ts`, `export default "${name}";\n`);
        write(`${ROOT}LegacyMigrationHistories.ts`, legacyHistories());
        write(`${ROOT}DatabaseMigrations.ts`, "// legacy conversion and separate runners\n");
        write(`${ROOT}DatabaseMigrations.test.ts`, "// historical upgrade fixtures\n");
      };
      upstream(["Initial"]);
      const firstUpstream = commit("upstream A");
      downstream();
      const firstRelease = commit("patchset A");
      assertMigrationHistory({
        repoRoot: repo,
        candidateRef: firstRelease,
        upstreamRef: firstUpstream,
        previousRef: firstUpstream,
      });
      git("checkout", "--detach", firstUpstream);
      upstream(["Initial", "BranchPullRequest"]);
      const secondUpstream = commit("upstream B adds a migration");
      downstream();
      const secondRelease = commit("reconstruct patchsets B");
      assertMigrationHistory({
        repoRoot: repo,
        candidateRef: secondRelease,
        upstreamRef: secondUpstream,
        previousRef: firstRelease,
      });
      git("checkout", "--detach", secondUpstream);
      upstream(["Initial", "BranchPullRequest", "ActiveOrder"]);
      const thirdUpstream = commit("upstream C adds another migration");
      downstream(["Annotation", "Attention"]);
      const thirdRelease = commit("reconstruct patchsets C with new LastCode migration");
      assertMigrationHistory({
        repoRoot: repo,
        candidateRef: thirdRelease,
        upstreamRef: thirdUpstream,
        previousRef: secondRelease,
      });

      const check = () =>
        assertMigrationHistory({
          repoRoot: repo,
          candidateRef: "HEAD",
          upstreamRef: thirdUpstream,
          previousRef: secondRelease,
        });
      write(`${ROOT}LegacyMigrationHistories.ts`, legacyHistories("Changed"));
      commit("bad replay changes a recognized historical identity");
      assert.throws(check, /Legacy migration history .* removed or changed/);
      git("reset", "--hard", thirdRelease);
      write(
        `${ROOT}LegacyMigrationHistories.ts`,
        legacyHistories().replace("lastcode/build/released", "lastcode/build/other"),
      );
      commit("bad replay drops a recognized historical release");
      assert.throws(check, /Legacy migration history .* removed or changed/);
      git("reset", "--hard", thirdRelease);
      write(
        `${ROOT}LegacyMigrationHistories.ts`,
        legacyHistories(
          "Annotation",
          '{ source: "lastcode/build/additional", entries: [[43, "Attention"]] },',
        ),
      );
      commit("retain histories while recognizing another release");
      assert.doesNotThrow(check);
      git("reset", "--hard", thirdRelease);
      git("rm", `${ROOT}LegacyMigrationHistories.ts`);
      commit("bad replay drops historical registry");
      assert.throws(check);
      git("reset", "--hard", thirdRelease);
      write(`${ROOT}LastCodeMigrations.ts`, registry(["Attention"], true));
      commit("bad replay replaces a released identity");
      assert.throws(check, /removed, reordered, or reassigned/);
      git("reset", "--hard", thirdRelease);
      write(`${ROOT}Migrations/Annotation.ts`, "export default 'changed after shipping';\n");
      commit("bad replay changes a released migration");
      assert.throws(check, /changed after release/);
      git("reset", "--hard", thirdRelease);
      write(
        `${ROOT}Migrations.ts`,
        registry(["Initial", "BranchPullRequest", "ActiveOrder", "Annotation"]),
      );
      commit("bad replay mixes upstream and downstream numbering");
      assert.throws(check, /changed the upstream migration registry/);
      git("reset", "--hard", thirdRelease);
      write(`${ROOT}Migrations/BranchPullRequest.ts`, "export default 'skipped';\n");
      commit("bad replay replaces upstream implementation");
      assert.throws(check, /changed upstream migration/);
      git("reset", "--hard", thirdRelease);
      git("rm", `${ROOT}LastCodeMigrations.ts`);
      commit("bad replay drops separate LastCode registry");
      assert.throws(check);
      git("reset", "--hard", thirdRelease);
      git("rm", `${ROOT}DatabaseMigrations.test.ts`);
      commit("bad replay drops historical upgrade fixtures");
      assert.throws(check, /lost required migration conversion or upgrade tests/);
    }));
});
