import { describe, expect, it } from "vitest";

import { isCanonicalUpstreamUrl, parseOptions, setupCommands } from "./lastcode-setup.mjs";

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
});
