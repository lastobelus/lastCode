import { expect } from "e2e";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { APP_DIR, T3_HOME } from "../e2e.config.ts";
import { runPromise, test, WEB } from "./t3.ts";
import { run } from "./shell.ts";

test(
  "a worktree fetch retries its first timeout before showing an error",
  WEB,
  async ({ t3, app, screen }) => {
    const fs = await runPromise(FileSystem.FileSystem);
    const path = await runPromise(Path.Path);
    const fixture = await runPromise(
      fs.makeTempDirectory({ directory: "/tmp", prefix: "fetch-retry-fixture-" }),
    );
    const repo = path.join(fixture, "repo");
    await runPromise(fs.makeDirectory(repo));
    const remote = path.join(fixture, "remote.git");
    const helper = path.join(fixture, "upload-pack.cjs");
    const counter = path.join(fixture, "fetch-count");
    const git = (...args: string[]) => runPromise(run("git", args, { cwd: repo }));
    await git("init", "--quiet", "--initial-branch=main");
    await runPromise(fs.writeFileString(path.join(repo, "README.md"), "Fetch retry fixture\n"));
    await git("add", "README.md");
    await git(
      "-c",
      "user.name=Scenario",
      "-c",
      "user.email=scenario@example.invalid",
      "commit",
      "--quiet",
      "-m",
      "Initial fixture",
    );
    await git("clone", "--bare", repo, remote);
    await runPromise(
      fs.writeFileString(
        helper,
        `#!/usr/bin/env node
const NodeFS = require("node:fs");
const { spawn } = require("node:child_process");
const counter = ${JSON.stringify(counter)};
const count = NodeFS.existsSync(counter) ? Number(NodeFS.readFileSync(counter, "utf8")) : 0;
NodeFS.writeFileSync(counter, String(count + 1));
if (count === 0) {
  setTimeout(() => process.exit(1), 120000);
} else {
  const child = spawn("git-upload-pack", [${JSON.stringify(remote)}], { stdio: "inherit" });
  child.on("exit", (code) => process.exit(code ?? 1));
}
`,
      ),
    );
    await runPromise(fs.chmod(helper, 0o755));
    await git("config", "protocol.ext.allow", "always");
    await git("remote", "add", "fixture", `ext::${helper}`);
    await git("update-ref", "refs/remotes/fixture/main", "HEAD");
    const client = `
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as References from "effect/References";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as ServerConfig from "./src/config.ts";
import * as Auth from "./src/auth/EnvironmentAuth.ts";
import { mcpToolSession } from "./src/mcp/AcpMcpStdioBridge.ts";
const home = process.env.FETCH_RETRY_HOME;
const { origin } = JSON.parse(NodeFS.readFileSync(NodePath.join(home,"userdata/server-runtime.json"),"utf8"));
const payload = (result) => result.structuredContent ?? JSON.parse(result.content.find((item) => item.type === "text").text);
const layer = Auth.layerRuntime.pipe(
  Layer.provide(ServerConfig.layerTest(process.cwd(), home)),
  Layer.provide(Layer.succeed(References.MinimumLogLevel,"Error")),
  Layer.provide(Layer.mergeAll(NodeServices.layer,NodeCrypto.layer)),
);
await Effect.runPromise(Effect.gen(function* () {
  const auth = yield* Auth.EnvironmentAuth;
  const session = yield* Effect.acquireRelease(
    auth.issueMcpClientSession({label:"Fetch retry scenario",access:"full-access",peerLink:false,client:{deviceType:"bot"}}),
    (session) => auth.revokeSession(session.sessionId),
  );
  const tools = yield* mcpToolSession({endpoint:new URL("/mcp",origin).href,authorization:"Bearer "+session.token,clientName:"fetch-retry-scenario"});
  const project = payload(yield* tools.call("t3_project_create",{title:"Fetch retry fixture",workspaceRoot:process.env.FETCH_RETRY_REPO}));
  if (!project.id) throw Error("Fixture project not registered");
  const result = payload(yield* tools.call("t3_thread_launch",{
    projectId:project.id,title:"Fetch retry",clientRequestId:"fetch-retry-scenario",
    modelSelection:{instanceId:"devReplay",model:"showcase"},message:"Run the fixture",
    workspaceStrategy:{type:"worktree",baseRef:"fixture/main",startFromOrigin:true},
  }));
  if (!result.threadId) throw Error("Fixture launch rejected");
  console.log(JSON.stringify({threadId:result.threadId}));
}).pipe(Effect.scoped,Effect.provide(layer)));
`;
    try {
      const launched = JSON.parse(
        (
          await runPromise(
            run(process.execPath, ["--input-type=module", "--eval", client], {
              cwd: path.join(APP_DIR, "apps/server"),
              env: { ...process.env, FETCH_RETRY_HOME: T3_HOME, FETCH_RETRY_REPO: repo },
            }),
          )
        ).stdout,
      );
      await t3.open(launched);
      try {
        await expect(screen.getByRole("heading", "Done")).toBeVisible({ timeout: 90_000 });
      } finally {
        await app.screenshot("fetch-result");
      }
      expect(Number(await runPromise(fs.readFileString(counter)))).toBe(2);
    } finally {
      await runPromise(
        run(
          process.execPath,
          ["apps/server/src/bin.ts", "project", "remove", repo, "--force", "--base-dir", T3_HOME],
          { cwd: APP_DIR },
        ),
      );
      await runPromise(fs.remove(fixture, { recursive: true, force: true }));
    }
  },
);
