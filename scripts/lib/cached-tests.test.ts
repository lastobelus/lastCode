// @effect-diagnostics nodeBuiltinImport:off - verifies native task caching in isolated subprocesses.
import { describe, expect, it } from "vite-plus/test";
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import {
  advisoryRuntimeIdentity,
  cacheSummaryPaths,
  cachedTestTasks,
  isolateAdvisoryCache,
  matchesTestPath,
} from "./cached-tests.ts";

describe("cachedTestTasks", () => {
  it("selects every test for a checkout-root path", () => {
    const root = NodePath.resolve(import.meta.dirname, "../..");
    for (const path of [".", root]) {
      expect(
        matchesTestPath("apps/server/src/auth/utils.test.ts", [
          NodePath.relative(root, NodePath.resolve(root, path)),
        ]),
      ).toBe(true);
    }
    expect(matchesTestPath("apps/server/src/auth/utils.test.ts", ["apps/server"])).toBe(true);
    expect(matchesTestPath("apps/server-other/a.test.ts", ["apps/server"])).toBe(false);
  });
  it("keeps a file's cache task stable when unrelated tests are added", () => {
    const first = cachedTestTasks(JSON.stringify({ files: ["src/b.test.ts"], groupSize: 1 }));
    const second = cachedTestTasks(
      JSON.stringify({ files: ["src/a.test.ts", "src/b.test.ts"], groupSize: 1 }),
    );
    const key = Object.keys(first).find((key) => key !== "test-cache")!;
    expect(second[key]).toEqual(first[key]);
  });

  it("keeps shell metacharacters in filenames out of the command", () => {
    const tasks = cachedTestTasks(
      JSON.stringify({ files: ["src/a'$(touch injected).test.ts"], groupSize: 1 }),
    );
    const task = Object.entries(tasks).find(([key]) => key !== "test-cache")![1];
    expect(task.command).toBe("vp test run 'src/a'\"'\"'$(touch injected).test.ts'");
  });

  it("rejects paths outside the checkout and empty groups", () => {
    for (const request of [
      { files: ["../elsewhere.test.ts"], groupSize: 1 },
      { files: ["/absolute.test.ts"], groupSize: 1 },
      { files: ["src/a.test.ts"], groupSize: 0 },
    ]) {
      expect(() => cachedTestTasks(JSON.stringify(request))).toThrow();
    }
  });

  it("accepts spec files discovered by Vitest", () => {
    const tasks = cachedTestTasks(JSON.stringify({ files: ["src/example.spec.ts"], groupSize: 1 }));
    expect(
      Object.values(tasks).some((task) => task.command === "vp test run 'src/example.spec.ts'"),
    ).toBe(true);
  });

  it("does not add tasks without an explicit request", () => {
    expect(cachedTestTasks(undefined)).toEqual({});
  });

  it("isolates advisory summaries and refuses overlapping ownership", async () => {
    const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "advisory-summary-"));
    try {
      const shared = NodePath.join(directory, "shared/v18");
      const isolated = NodePath.join(directory, "advisory");
      await NodeFSP.mkdir(shared, { recursive: true });
      await NodeFSP.mkdir(NodePath.join(isolated, "v18"), { recursive: true });
      await NodeFSP.writeFile(NodePath.join(shared, "last-summary.json"), "unrelated");
      await NodeFSP.writeFile(NodePath.join(isolated, "v18/last-summary.json"), "stale");
      const release = isolateAdvisoryCache(isolated);
      try {
        expect(cacheSummaryPaths(isolated)).toEqual([]);
        expect(() => isolateAdvisoryCache(isolated)).toThrow();
        const receipt = NodePath.join(isolated, "v18/last-summary.json");
        await NodeFSP.writeFile(receipt, "current");
        expect(cacheSummaryPaths(isolated)).toEqual([receipt]);
        expect(await NodeFSP.readFile(NodePath.join(shared, "last-summary.json"), "utf8")).toBe(
          "unrelated",
        );
      } finally {
        release();
      }
      isolateAdvisoryCache(isolated)();
      for (const signal of ["SIGTERM", "SIGKILL"] as const) {
        const interrupted = NodeChildProcess.spawnSync(
          process.execPath,
          [
            "--input-type=module",
            "-e",
            `import { isolateAdvisoryCache } from ${JSON.stringify(NodeURL.pathToFileURL(NodePath.join(import.meta.dirname, "cached-tests.ts")).href)};
const release = isolateAdvisoryCache(${JSON.stringify(isolated)});
process.on("exit", release);
process.kill(process.pid, ${JSON.stringify(signal)});`,
          ],
          { encoding: "utf8", env: { ...process.env, NODE_OPTIONS: "" } },
        );
        expect(interrupted.error).toBeUndefined();
        expect(interrupted.signal).toBe(signal);
        isolateAdvisoryCache(isolated)();
      }
    } finally {
      await NodeFSP.rm(directory, { recursive: true, force: true });
    }
  });

  it("reuses individual results, invalidates filesystem inputs, and never caches failures", async () => {
    const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "cached-tests-"));
    const root = NodePath.resolve(import.meta.dirname, "../..");
    const run = (
      files = ["a.test.ts", "b.test.ts"],
      uncached: Array<string> = [],
      environment = "first",
      runtime = advisoryRuntimeIdentity(),
    ) =>
      new Promise<number | null>((resolve, reject) => {
        const child = NodeChildProcess.spawn(
          process.execPath,
          [NodePath.join(root, "node_modules/vite-plus/dist/bin.js"), "run", "test-cache"],
          {
            cwd: directory,
            env: {
              ...process.env,
              NODE_OPTIONS: "",
              VP_REMOTE_CACHE: "off",
              CACHE_PILOT_ENV: environment,
              T3_CACHED_TESTS: JSON.stringify({
                files,
                groupSize: 1,
                uncached,
                advisoryRuntime: runtime,
              }),
              VITE_CACHE_PATH: NodePath.join(directory, "cache"),
              PATH: `${NodePath.join(root, "node_modules/.bin")}${NodePath.delimiter}${process.env.PATH}`,
            },
            stdio: "ignore",
          },
        );
        child.once("error", reject);
        child.once("close", resolve);
      });
    const summary = async () => {
      const value: { tasks: Array<{ result: Record<string, unknown> }> } = JSON.parse(
        await NodeFSP.readFile(NodePath.join(directory, "cache/v18/last-summary.json"), "utf8"),
      );
      return value.tasks.filter((task) => "CacheHit" in task.result).length;
    };
    try {
      await NodeFSP.mkdir(NodePath.join(directory, "node_modules"));
      await NodeFSP.symlink(
        NodePath.join(root, "node_modules/vite-plus"),
        NodePath.join(directory, "node_modules/vite-plus"),
        "dir",
      );
      await NodeFSP.writeFile(NodePath.join(directory, "package.json"), '{"type":"module"}');
      await NodeFSP.writeFile(
        NodePath.join(directory, "vite.config.ts"),
        `import {cachedTestTasks} from ${JSON.stringify(NodeURL.pathToFileURL(NodePath.join(root, "scripts/lib/cached-tests.ts")).href)}; export default {run:{tasks:cachedTestTasks(process.env.T3_CACHED_TESTS, import.meta.dirname)},test:{include:["*.test.ts"]}};`,
      );
      await NodeFSP.writeFile(
        NodePath.join(directory, "a.test.ts"),
        'import {test,expect} from "vite-plus/test"; import {readFileSync} from "node:fs"; import {value} from "./source.ts"; test("fixture",()=>{expect(value).toBe(1);expect(process.env.CACHE_PILOT_ENV).toMatch(/first|second/);expect(readFileSync(readFileSync("selector.txt","utf8"),"utf8")).toMatch(/^hello/)});',
      );
      // Model a discovery probe so adding a sibling input invalidates b on every platform.
      await NodeFSP.writeFile(
        NodePath.join(directory, "b.test.ts"),
        'import {test,expect} from "vite-plus/test"; import {existsSync} from "node:fs"; existsSync("other.txt"); test("independent",()=>expect(1).toBe(1));',
      );
      await NodeFSP.writeFile(NodePath.join(directory, "fixture.txt"), "hello");
      await NodeFSP.writeFile(NodePath.join(directory, "source.ts"), "export const value = 1;");
      // Create every fixture before warming the cache; later checks change only their contents.
      await NodeFSP.writeFile(NodePath.join(directory, "other.txt"), "broken");
      await NodeFSP.writeFile(NodePath.join(directory, "selector.txt"), "fixture.txt");
      expect(await run()).toBe(0);
      expect(await run()).toBe(0);
      expect(await summary()).toBe(2);
      expect(await run(["b.test.ts"])).toBe(0);
      expect(await summary()).toBe(1);
      expect(await run()).toBe(0);
      expect(await summary()).toBe(2);
      expect(await run(undefined, [], "second")).toBe(0);
      expect(await summary()).toBe(0);
      expect(
        await run(
          undefined,
          [],
          "first",
          advisoryRuntimeIdentity({ ...process.versions, node: "changed" }),
        ),
      ).toBe(0);
      expect(await summary()).toBe(0);
      expect(await run()).toBe(0);
      expect(await run()).toBe(0);
      expect(await summary()).toBe(2);
      // Keep b's warm entry across the failing source and dynamic-input selections.
      await NodeFSP.writeFile(NodePath.join(directory, "source.ts"), "export const value = 2;");
      expect(await run(["a.test.ts"])).toBe(1);
      await NodeFSP.writeFile(NodePath.join(directory, "source.ts"), "export const value = 1;");
      await NodeFSP.writeFile(NodePath.join(directory, "selector.txt"), "other.txt");
      expect(await run(["a.test.ts"])).toBe(1);
      await NodeFSP.writeFile(NodePath.join(directory, "selector.txt"), "fixture.txt");
      await NodeFSP.writeFile(NodePath.join(directory, "fixture.txt"), "hello changed");
      expect(await run()).toBe(0);
      expect(await summary()).toBe(1);
      await NodeFSP.writeFile(NodePath.join(directory, "fixture.txt"), "broken");
      expect(await run()).toBe(1);
      expect(await run()).toBe(1);
      expect(await summary()).toBe(1);
      await NodeFSP.writeFile(NodePath.join(directory, "fixture.txt"), "hello again");
      await NodeFSP.writeFile(
        NodePath.join(directory, "b.test.ts"),
        'import {test} from "vite-plus/test";import {writeFileSync} from "node:fs";test("report",()=>writeFileSync("report.json","{}"));',
      );
      expect(await run(undefined, ["b.test.ts"])).toBe(0);
      await NodeFSP.unlink(NodePath.join(directory, "report.json"));
      expect(await run(undefined, ["b.test.ts"])).toBe(0);
      expect(await NodeFSP.readFile(NodePath.join(directory, "report.json"), "utf8")).toBe("{}");
    } finally {
      await NodeFSP.rm(directory, { recursive: true, force: true });
    }
  });
});
