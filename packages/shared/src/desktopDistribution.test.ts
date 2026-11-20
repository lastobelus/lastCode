// @effect-diagnostics nodeBuiltinImport:off - Checks shell expansion without invoking an installed app.
import * as NodeChildProcess from "node:child_process";

import { expect, it } from "vite-plus/test";

import { LASTCODE_TRIAGE_CLI_COMMAND } from "./desktopDistribution.ts";

it("uses the terminal's custom LastCode home and keeps spaces and quotes in one argument", () => {
  for (const home of ["/home/user/Custom LastCode", "/home/user/It's LastCode"]) {
    const result = NodeChildProcess.spawnSync(
      "/bin/sh",
      ["-c", `printf '%s\\n' ${LASTCODE_TRIAGE_CLI_COMMAND}`],
      {
        env: { ...process.env, T3CODE_HOME: home },
        encoding: "utf8",
      },
    );
    expect(result.status).toBe(0);
    expect(result.stdout.trimEnd().split("\n")).toEqual([`${home}/bin/t3`, "triage"]);
  }
});
