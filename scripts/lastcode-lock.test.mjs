import * as NodeChildProcess from "node:child_process";
import * as NodeEvents from "node:events";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import { afterEach, describe, expect, it } from "vite-plus/test";

import { acquirePortableLock } from "./lastcode-lock.mjs";

const temporaryDirectories = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    NodeFS.rmSync(directory, { force: true, recursive: true });
  }
});

function temporaryDirectory() {
  const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "lastcode-lock-test-"));
  temporaryDirectories.push(directory);
  return directory;
}

function spawnLockHolder(root) {
  const moduleUrl = new NodeURL.URL("./lastcode-lock.mjs", import.meta.url).href;
  const source = [
    `import { acquirePortableLock } from ${JSON.stringify(moduleUrl)};`,
    `acquirePortableLock(${JSON.stringify(root)}, "update.lock", "test");`,
    'process.stdout.write("locked\\n");',
    "setInterval(() => {}, 1_000);",
  ].join("\n");
  return NodeChildProcess.spawn(process.execPath, ["--input-type=module", "--eval", source], {
    stdio: ["ignore", "pipe", "pipe"],
  });
}

describe("LastCode portable update lock", () => {
  it("rejects a concurrent owner and recovers when that owner dies", async () => {
    const root = temporaryDirectory();
    const holder = spawnLockHolder(root);
    await NodeEvents.once(holder.stdout, "data");

    expect(() => acquirePortableLock(root, "update.lock", "test")).toThrow(
      `Another LastCode test is already running (PID ${holder.pid}`,
    );

    // This is the exact child spawned above, not a process located by pattern.
    holder.kill();
    await NodeEvents.once(holder, "exit");

    const release = acquirePortableLock(root, "update.lock", "test");
    release();
  });
});
