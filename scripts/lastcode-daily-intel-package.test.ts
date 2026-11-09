// @effect-diagnostics nodeBuiltinImport:off -- Workflow fixture reads use Node directly.
import * as NodeFS from "node:fs";
import * as NodeChildProcess from "node:child_process";

import { describe, expect, it, vi } from "vite-plus/test";

import {
  type BuildIntelDependencies,
  parseRemoteInstallableRefs,
} from "./lastcode-build-intel-package.ts";
import {
  buildLatestIntelPackage,
  latestInstallableFromRemoteRefs,
} from "./lastcode-daily-intel-package.ts";

const sha = (character: string) => character.repeat(40);

describe("lastcode-daily-intel-package", () => {
  it("registers every tracked gitlink so checkout credential cleanup can traverse it", () => {
    const cwd = new URL("../", import.meta.url);
    const git = (...args: string[]) =>
      NodeChildProcess.execFileSync("git", args, {
        cwd,
        encoding: "utf8",
        maxBuffer: 16 * 1024 * 1024,
      });
    const paths = git("ls-files", "--stage", "-z")
      .split("\0")
      .filter((entry) => entry.startsWith("160000 "))
      .map((entry) => entry.slice(entry.indexOf("\t") + 1));
    const modules = git(
      "config",
      "--file",
      ".gitmodules",
      "--get-regexp",
      "^submodule\\..*\\.path$",
    );
    for (const path of paths) {
      expect(modules.split("\n").some((line) => line.endsWith(` ${path}`))).toBe(true);
      expect(
        git("config", "--file", ".gitmodules", "--get", `submodule.${path}.url`).trim(),
      ).not.toBe("");
      expect(
        git("config", "--file", ".gitmodules", "--get", `submodule.${path}.update`).trim(),
      ).toBe("none");
    }
    expect(() => git("submodule", "foreach", "--recursive", "true")).not.toThrow();
  });

  it("runs daily with only the permissions needed to dispatch the existing builder", () => {
    const workflow = NodeFS.readFileSync(
      new URL("../.github/workflows/lastcode-daily-intel-package.yml", import.meta.url),
      "utf8",
    );
    expect(workflow).toContain('cron: "0 8 * * *"');
    expect(workflow).toContain("workflow_dispatch:");
    expect(workflow).toContain("installable_tag:");
    expect(workflow).toContain("installable_commit:");
    expect(workflow).toContain("inputs.installable_tag");
    expect(workflow).toContain("inputs.installable_commit");
    expect(workflow).toContain('"lastcode/checkpoint/v*"');
    expect(workflow).toContain('"lastcode/revision/v*"');
    expect(workflow).toContain("github.event_name != 'push' || !github.event.deleted");
    expect(workflow).toContain("LASTCODE_INSTALLABLE_TAG:");
    expect(workflow).toContain("github.ref_name");
    expect(workflow).toContain("LASTCODE_INSTALLABLE_COMMIT:");
    expect(workflow).toContain("github.sha");
    expect(workflow).toContain("ref: lastcode/main");
    expect(workflow).toContain("actions: write");
    expect(workflow).toContain("contents: read");
    expect(workflow).toContain("group: lastcode-daily-intel-package");
    expect(workflow).toContain("cancel-in-progress: false");
    expect(workflow).toContain("node scripts/lastcode-daily-intel-package.ts");
    expect(workflow).toMatch(/sparse-checkout: \|\s+\/\*\s+!\/\.repos\//u);
    expect(workflow).toContain("sparse-checkout-cone-mode: false");
  });

  it("installs the scripts workspace and its dependencies before starting the dispatcher", () => {
    const workflow = NodeFS.readFileSync(
      new URL("../.github/workflows/lastcode-daily-intel-package.yml", import.meta.url),
      "utf8",
    );
    const setup = workflow.indexOf("uses: voidzero-dev/setup-vp@v1");
    const dispatch = workflow.indexOf("run: node scripts/lastcode-daily-intel-package.ts");

    expect(setup).toBeGreaterThanOrEqual(0);
    expect(dispatch).toBeGreaterThan(setup);
    expect(workflow.slice(setup, dispatch)).toMatch(
      /run-install: \|\s+args:\s+- --filter=@t3tools\/scripts\.\.\./u,
    );
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

  it.each([false, true])(
    "hands one exact target to the builder (tag event: %s)",
    async (tagEvent) => {
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
      const resolveLatest = vi.fn(() => ({
        tag: "lastcode/checkpoint/v0.0.36-nightly.20260828.1207",
        commit: sha("b"),
      }));
      const resolveExact = vi.fn((tag) =>
        parseRemoteInstallableRefs(
          tag,
          "origin",
          `${target.commit}\trefs/tags/${target.tag}\n${sha("b")}\trefs/tags/lastcode/checkpoint/v0.0.36-nightly.20260828.1207`,
        ),
      );

      await expect(
        buildLatestIntelPackage({
          ...(tagEvent
            ? { tag: target.tag, commit: target.commit, resolveLatest, resolveExact }
            : { resolveLatest: () => target }),
          select,
          run,
        }),
      ).resolves.toEqual(result);
      expect(select).toHaveBeenCalledOnce();
      expect(select.mock.calls[0]?.[0]).toBe(target.tag);
      expect(select.mock.calls[0]?.[1]?.withRequestLock?.(() => "selected")).toBe("selected");
      expect(run).toHaveBeenCalledOnce();
      expect(run.mock.calls[0]?.[0]?.withRequestLock(() => "running")).toBe("running");
      if (tagEvent) {
        expect(resolveLatest).not.toHaveBeenCalled();
        expect(resolveExact).toHaveBeenCalledExactlyOnceWith(target.tag);
      }
    },
  );

  it.each([
    { tag: "lastcode/build/v0.0.36-nightly.20260827.1206.1", commit: sha("a") },
    { tag: "lastcode/checkpoint/v0.0.36-nightly.20260827.1206.1", commit: sha("a") },
    { tag: "lastcode/revision/v0.0.36-nightly.20260827.1206.0", commit: sha("a") },
    { tag: "lastcode/checkpoint/v0.0.36-nightly.20260827.1206\n", commit: sha("a") },
    { tag: "lastcode/checkpoint/v0.0.36-nightly.20260827.1206" },
    { commit: sha("a") },
    { tag: "", commit: sha("a") },
  ])("rejects malformed or incomplete event targets before dispatch: %j", async (target) => {
    const resolveExact = vi.fn();
    const select = vi.fn();
    const run = vi.fn();
    await expect(buildLatestIntelPackage({ ...target, resolveExact, select, run })).rejects.toThrow(
      "exact installable tag and full event commit",
    );
    expect(resolveExact).not.toHaveBeenCalled();
    expect(select).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
  });

  it.each(["unpublished", "moved"])("rejects a %s event target before dispatch", async (kind) => {
    const target = { tag: "lastcode/checkpoint/v0.0.36-nightly.20260827.1206", commit: sha("a") };
    const select = vi.fn();
    const run = vi.fn();
    await expect(
      buildLatestIntelPackage({
        ...target,
        resolveExact: (tag) =>
          parseRemoteInstallableRefs(
            tag,
            "origin",
            kind === "unpublished" ? "" : `${sha("b")}\trefs/tags/${tag}`,
          ),
        select,
        run,
      }),
    ).rejects.toThrow(
      kind === "unpublished" ? "does not advertise" : "does not match event commit",
    );
    expect(select).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
  });
});
