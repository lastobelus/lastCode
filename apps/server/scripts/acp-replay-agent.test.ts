// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import { assert, it } from "@effect/vitest";

it("keeps the published replay status complete while its replacement is being written", () => {
  const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "acp-replay-status-"));
  try {
    const statusPath = NodePath.join(directory, "status.json");
    const observationsPath = NodePath.join(directory, "observations.json");
    NodeFS.writeFileSync(statusPath, JSON.stringify({ cursor: -1, total: 1 }));

    // Observe the published file halfway through each real filesystem write.
    // This forces the race without depending on process scheduling or sleeps.
    const observer = `
      import fs from "node:fs";
      import { syncBuiltinESMExports } from "node:module";
      const observations = [];
      const writeFileSync = fs.writeFileSync;
      fs.writeFileSync = (path, data) => {
        const descriptor = fs.openSync(path, "w");
        try {
          fs.writeSync(descriptor, data.slice(0, 1));
          observations.push(fs.readFileSync(process.env.T3_ACP_REPLAY_STATUS_PATH, "utf8"));
          fs.writeSync(descriptor, data.slice(1));
        } finally {
          fs.closeSync(descriptor);
        }
      };
      syncBuiltinESMExports();
      process.on("exit", () => writeFileSync(${JSON.stringify(observationsPath)}, JSON.stringify(observations)));
    `;
    const transcript = {
      scenario: "atomic-status-publication",
      entries: [
        {
          type: "expect_outbound",
          frame: { kind: "notification", method: "test/complete" },
        },
      ],
    };
    const result = NodeChildProcess.spawnSync(
      process.execPath,
      [
        "--import",
        `data:text/javascript;base64,${Buffer.from(observer).toString("base64")}`,
        "--experimental-strip-types",
        NodeURL.fileURLToPath(new URL("./acp-replay-agent.ts", import.meta.url)),
      ],
      {
        input: `${JSON.stringify({ jsonrpc: "2.0", method: "test/complete" })}\n`,
        encoding: "utf8",
        env: {
          ...process.env,
          T3_ACP_REPLAY_TRANSCRIPT: Buffer.from(JSON.stringify(transcript)).toString("base64"),
          T3_ACP_REPLAY_STATUS_PATH: statusPath,
        },
      },
    );

    assert.isUndefined(result.error);
    assert.strictEqual(result.status, 0, result.stderr);
    const observations: Array<string> = JSON.parse(NodeFS.readFileSync(observationsPath, "utf8"));
    assert.deepStrictEqual(
      observations.map((raw) => JSON.parse(raw).cursor),
      [-1, 0],
    );
    assert.strictEqual(JSON.parse(NodeFS.readFileSync(statusPath, "utf8")).cursor, 1);
  } finally {
    NodeFS.rmSync(directory, { recursive: true, force: true });
  }
});
