// @effect-diagnostics nodeBuiltinImport:off -- Workflow fixture reads use Node directly.
import * as NodeFS from "node:fs";

import { describe, expect, it, vi } from "vite-plus/test";

import type { BuildIntelDependencies } from "./lastcode-build-intel-package.ts";
import {
  buildLatestIntelPackage,
  latestInstallableFromRemoteRefs,
} from "./lastcode-daily-intel-package.ts";

const sha = (character: string) => character.repeat(40);

describe("lastcode-daily-intel-package", () => {
  it("runs daily with only the permissions needed to dispatch the existing builder", () => {
    const workflow = NodeFS.readFileSync(
      new URL("../.github/workflows/lastcode-daily-intel-package.yml", import.meta.url),
      "utf8",
    );
    expect(workflow).toContain('cron: "0 8 * * *"');
    expect(workflow).toContain("workflow_dispatch:");
    expect(workflow).toContain("actions: write");
    expect(workflow).toContain("contents: read");
    expect(workflow).toContain("group: lastcode-daily-intel-package");
    expect(workflow).toContain("cancel-in-progress: false");
    expect(workflow).toContain("node scripts/lastcode-daily-intel-package.ts");
    expect(workflow).not.toMatch(/airy|htulo/u);
  });

  it("selects the newest strict installable and peels annotated tags", () => {
    const checkpoint = "lastcode/checkpoint/v0.0.36-nightly.20260827.1206";
    const revision = "lastcode/revision/v0.0.36-nightly.20260827.1206.2";
    const output = [
      `${sha("a")}\trefs/tags/${checkpoint}`,
      `${sha("b")}\trefs/tags/${revision}`,
      `${sha("c")}\trefs/tags/${revision}^{}`,
      `${sha("d")}\trefs/tags/lastcode/checkpoint/v0.0.36-nightly.20260827.1207.1`,
      `${sha("e")}\trefs/tags/not-lastcode/v9.9.9`,
    ].join("\n");

    expect(latestInstallableFromRemoteRefs(output)).toEqual({
      tag: revision,
      commit: sha("c"),
    });
  });

  it("fails closed on invalid metadata or no installable tag", () => {
    expect(() => latestInstallableFromRemoteRefs("not-a-sha\trefs/tags/example")).toThrow(
      "invalid installable tag metadata",
    );
    expect(() => latestInstallableFromRemoteRefs(`${sha("a")}\trefs/tags/example/v1`)).toThrow(
      "does not advertise an installable",
    );
  });

  it("hands one exact resolved target to the existing builder", async () => {
    const target = {
      tag: "lastcode/revision/v0.0.36-nightly.20260827.1206.2",
      commit: sha("f"),
    };
    const select = vi.fn((_tag, options) => ({
      schemaVersion: 1 as const,
      installableTag: target.tag,
      installableCommit: options.resolveTag().commit,
      requestToken: "intel-12345678-1234-1234-1234-123456789abc",
      selectedAt: "2026-08-27T00:00:00.000Z",
      dispatchAttemptedAt: null,
      workflowRunId: null,
    }));
    const result = {
      tag: target.tag,
      commit: target.commit,
      requestToken: "intel-12345678-1234-1234-1234-123456789abc",
      runId: 123,
      runUrl: "https://example.invalid/runs/123",
      workflowCommit: sha("a"),
      releaseUrl: "https://example.invalid/releases/1206.2",
      assets: ["LastCode-x64.dmg"],
    };
    const run = vi.fn(async (_dependencies?: BuildIntelDependencies) => result);

    await expect(
      buildLatestIntelPackage({ resolveLatest: () => target, select, run }),
    ).resolves.toEqual(result);
    expect(select).toHaveBeenCalledOnce();
    expect(select.mock.calls[0]?.[0]).toBe(target.tag);
    expect(select.mock.calls[0]?.[1]?.withRequestLock?.(() => "selected")).toBe("selected");
    expect(run).toHaveBeenCalledOnce();
    expect(run.mock.calls[0]?.[0]?.withRequestLock(() => "running")).toBe("running");
  });
});
