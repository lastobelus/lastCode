import { describe, expect, it } from "vite-plus/test";

import {
  executeSetupCommands,
  isCanonicalUpstreamUrl,
  parseOptions,
  setupCommands,
} from "./lastcode-setup.mjs";

describe("lastcode-setup", () => {
  it("parses the explicit acknowledgement of nightly writes", () => {
    expect(
      parseOptions([
        "--enable-nightly-writes",
        "--checkpoint-interval-seconds",
        "1234",
        "--trusted-project-action",
        "lc-wait-for-pr",
        "--dry-run",
      ]),
    ).toEqual({
      checkpointIntervalSeconds: 1234,
      dryRun: true,
      enableNightlyWrites: true,
      help: false,
      trustedProjectActionIds: ["lc-wait-for-pr"],
    });
    expect(() => parseOptions(["--checkpoint-interval-seconds", "0"])).toThrow("positive integer");
    expect(() => parseOptions(["--surprise"])).toThrow("Unknown argument");
  });

  it("recognizes canonical upstream URL forms", () => {
    expect(isCanonicalUpstreamUrl("git@github.com:pingdotgg/t3code.git")).toBe(true);
    expect(isCanonicalUpstreamUrl("https://github.com/pingdotgg/t3code")).toBe(true);
    expect(isCanonicalUpstreamUrl("ssh://git@github.com/pingdotgg/t3code.git")).toBe(true);
    expect(isCanonicalUpstreamUrl("git@github.com:someone/t3code.git")).toBe(false);
  });

  it("installs dependencies, the service, and all managed commands", () => {
    const commands = setupCommands("/repo", "/node", 1234, {
      home: "/home/example",
      trustedProjectActionIds: ["lc-wait-for-pr"],
    });
    expect(commands.map(({ command, args }) => [command, ...args])).toEqual([
      ["vp", "install", "--frozen-lockfile"],
      [
        "/node",
        "/repo/scripts/lastcode-project-actions.mjs",
        "reconcile",
        "--repo-root",
        "/repo",
        "--base-dir",
        "/home/example/.lastcode",
        "--trusted-source-id",
        "lc-wait-for-pr",
      ],
      [
        "/node",
        "/repo/scripts/lastcode-nightly-service.ts",
        "install",
        "--interval-seconds",
        "1234",
        "--trusted-project-action",
        "lc-wait-for-pr",
      ],
      ["/node", "/repo/scripts/lastcode-checkpoints.mjs", "--install"],
      ["/node", "/repo/scripts/lastcode-build.mjs", "--install"],
      ["/node", "/repo/scripts/lastcode-install.mjs", "--install"],
    ]);
  });

  it("disables a newly installed service when a later helper fails", () => {
    const commands = setupCommands("/repo", "/node", 1234, { home: "/home/example" });
    const executed = [];

    expect(() =>
      executeSetupCommands(
        commands,
        (step) => {
          executed.push(step);
          if (step.kind === "builder") throw new Error("helper conflict");
        },
        false,
      ),
    ).toThrow("helper conflict");

    expect(executed.at(-1)?.args).toEqual([
      "/repo/scripts/lastcode-nightly-service.ts",
      "uninstall",
    ]);
  });

  it("preserves a service that existed before a failed rerun", () => {
    const commands = setupCommands("/repo", "/node", 1234, { home: "/home/example" });
    const executed = [];

    expect(() =>
      executeSetupCommands(
        commands,
        (step) => {
          executed.push(step);
          if (step.kind === "builder") throw new Error("helper conflict");
        },
        true,
      ),
    ).toThrow("helper conflict");

    expect(executed.some((step) => step.args.at(-1) === "uninstall")).toBe(false);
  });
});
