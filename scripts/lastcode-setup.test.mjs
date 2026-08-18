import { describe, expect, it } from "vitest";

import {
  executeSetupCommands,
  isCanonicalUpstreamUrl,
  parseOptions,
  setupCommands,
} from "./lastcode-setup.mjs";

describe("lastcode-setup", () => {
  it("parses the explicit acknowledgement of nightly writes", () => {
    expect(parseOptions(["--enable-nightly-writes", "--dry-run"])).toEqual({
      dryRun: true,
      enableNightlyWrites: true,
      help: false,
    });
    expect(() => parseOptions(["--surprise"])).toThrow("Unknown argument");
  });

  it("recognizes canonical upstream URL forms", () => {
    expect(isCanonicalUpstreamUrl("git@github.com:pingdotgg/t3code.git")).toBe(true);
    expect(isCanonicalUpstreamUrl("https://github.com/pingdotgg/t3code")).toBe(true);
    expect(isCanonicalUpstreamUrl("ssh://git@github.com/pingdotgg/t3code.git")).toBe(true);
    expect(isCanonicalUpstreamUrl("git@github.com:someone/t3code.git")).toBe(false);
  });

  it("installs dependencies, the service, and all managed commands", () => {
    const commands = setupCommands("/repo", "/node");
    expect(commands.map(({ command, args }) => [command, ...args])).toEqual([
      ["vp", "install", "--frozen-lockfile"],
      ["/node", "/repo/scripts/lastcode-nightly-service.ts", "install"],
      ["/node", "/repo/scripts/lastcode-checkpoints.mjs", "--install"],
      ["/node", "/repo/scripts/lastcode-build.mjs", "--install"],
      ["/node", "/repo/scripts/lastcode-install.mjs", "--install"],
    ]);
  });

  it("disables a newly installed service when a later helper fails", () => {
    const commands = setupCommands("/repo", "/node");
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
    const commands = setupCommands("/repo", "/node");
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
