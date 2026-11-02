/* oxlint-disable t3code/no-global-process-runtime -- Vite loads task definitions before an Effect runtime exists. */
// @effect-diagnostics nodeBuiltinImport:off - Vite loads this before dependency installation and service initialization.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { acquirePortableLock } from "../lastcode-lock.mjs";

interface CachedTestTask {
  command: string;
  cwd?: string;
  dependsOn?: Array<string>;
  cache:
    | false
    | {
        input: Array<string | { auto: true }>;
        env?: Array<string>;
        output: Array<string>;
      };
}

export function cacheSummaryPaths(cacheRoot: string) {
  return NodeFS.existsSync(cacheRoot)
    ? NodeFS.readdirSync(cacheRoot, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => NodePath.join(cacheRoot, entry.name, "last-summary.json"))
        .filter((file) => NodeFS.existsSync(file))
    : [];
}

export function isolateAdvisoryCache(cacheRoot: string) {
  // This namespace belongs only to serial advisory invocations, including hit audits.
  const release = acquirePortableLock(cacheRoot, "advisory.lock", "advisory cache");
  try {
    for (const file of cacheSummaryPaths(cacheRoot)) NodeFS.unlinkSync(file);
  } catch (error) {
    release();
    throw error;
  }
  return release;
}

export function advisoryRuntimeIdentity(versions = process.versions) {
  return NodeCrypto.createHash("sha256")
    .update(JSON.stringify([process.platform, process.arch, process.execPath, versions]))
    .digest("hex");
}

export function matchesTestPath(file: string, filters: Array<string>) {
  return (
    filters.length === 0 ||
    filters.some((filter) => filter === "" || file === filter || file.startsWith(`${filter}/`))
  );
}

export function cachedTestTasks(
  raw: string | undefined,
  root = NodePath.resolve(import.meta.dirname, "../.."),
): Record<string, CachedTestTask> {
  if (!raw) return {};
  const request: unknown = JSON.parse(raw);
  if (
    typeof request !== "object" ||
    request === null ||
    !("files" in request) ||
    !Array.isArray(request.files) ||
    !("groupSize" in request) ||
    typeof request.groupSize !== "number" ||
    !Number.isSafeInteger(request.groupSize) ||
    request.groupSize < 1
  ) {
    throw new Error("Invalid cached test request");
  }
  const advisoryRuntime = "advisoryRuntime" in request ? request.advisoryRuntime : undefined;
  if (
    advisoryRuntime !== undefined &&
    (typeof advisoryRuntime !== "string" || !/^[a-f0-9]{64}$/.test(advisoryRuntime))
  ) {
    throw new Error("Invalid advisory runtime identity");
  }
  const uncached = "uncached" in request ? request.uncached : [];
  if (!Array.isArray(uncached) || !uncached.every((file) => typeof file === "string")) {
    throw new Error("Invalid uncached test files");
  }
  const files: Array<string> = [];
  for (const file of request.files) {
    if (
      typeof file !== "string" ||
      NodePath.isAbsolute(file) ||
      file.split(/[\\/]/).includes("..") ||
      !/\.(?:test|spec)\.[cm]?[jt]sx?$/.test(file)
    ) {
      throw new Error("Cached tests must be test files inside the checkout");
    }
    files.push(file);
  }
  const tasks: Record<string, CachedTestTask> = {};
  const sorted = [...new Set(files)].sort();
  const packages = new Map<string, Array<string>>();
  for (const file of sorted) {
    let directory = NodePath.dirname(NodePath.join(root, file));
    while (directory !== root && !NodeFS.existsSync(NodePath.join(directory, "package.json"))) {
      directory = NodePath.dirname(directory);
    }
    const entries = packages.get(directory) ?? [];
    entries.push(file);
    packages.set(directory, entries);
  }
  for (const [directory, entries] of packages) {
    const manifest: unknown = JSON.parse(
      NodeFS.readFileSync(NodePath.join(directory, "package.json"), "utf8"),
    );
    const command =
      directory !== root &&
      typeof manifest === "object" &&
      manifest !== null &&
      "scripts" in manifest &&
      typeof manifest.scripts === "object" &&
      manifest.scripts !== null &&
      "test" in manifest.scripts &&
      typeof manifest.scripts.test === "string"
        ? manifest.scripts.test
        : "vp test run";
    if (!command.startsWith("vp test run")) {
      throw new Error(`Unsupported test command in ${directory}`);
    }
    const cacheable = entries.filter((file) => !uncached.includes(file));
    const groups: Array<Array<string>> = [];
    for (let index = 0; index < cacheable.length; index += request.groupSize) {
      groups.push(cacheable.slice(index, index + request.groupSize));
    }
    groups.push(...entries.filter((file) => uncached.includes(file)).map((file) => [file]));
    for (const group of groups) {
      const key = NodeCrypto.createHash("sha256").update(group.join("\0")).digest("hex");
      tasks[`test-cache:${key}`] = {
        command: `${advisoryRuntime ? `env T3_ADVISORY_RUNTIME=${advisoryRuntime} ` : ""}${command} ${group.map((file) => `'${NodePath.relative(directory, NodePath.join(root, file)).replaceAll("'", "'\"'\"'")}'`).join(" ")}`,
        ...(directory === root ? {} : { cwd: NodePath.relative(root, directory) }),
        cache: uncached.includes(group[0]!)
          ? false
          : {
              ...(advisoryRuntime ? { env: ["*", "!T3_CACHED_TESTS"] } : {}),
              // Vitest reads and rewrites these caches while running otherwise unchanged tests.
              input: [
                { auto: true },
                "!**/node_modules/.vite/**",
                "!**/node_modules/.vitest-cache/**",
              ],
              output: [],
            },
      };
    }
  }
  return {
    ...tasks,
    "test-cache": { command: 'node -e ""', dependsOn: Object.keys(tasks), cache: false },
  };
}
