import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeProcess from "node:process";
import * as NodeModule from "node:module";
import { createGeneratedBuildStage } from "../generatedBuildOwnership.ts";

const [cwd, root, role] = NodeProcess.argv.slice(2);
const send = (message) => NodeProcess.send(message);
let stage;

if (role === "paused") {
  const fs = (await import("node:fs")).default;
  const unlink = fs.unlinkSync;
  fs.unlinkSync = (target) => {
    if (target === NodePath.join(cwd, root, "old.js")) {
      send("paused-before-retirement");
      NodeProcess.stdin._handle.setBlocking(true);
      const command = Buffer.alloc(1);
      if (NodeFS.readSync(0, command, 0, 1, null) !== 1) throw new Error("Missing resume command");
      if (command.toString() === "f") throw new Error("Injected retirement failure");
    }
    return unlink(target);
  };
  NodeModule.syncBuiltinESMExports();
  stage = createGeneratedBuildStage(cwd, root);
  NodeFS.writeFileSync(NodePath.join(stage.directory, "current.js"), "publisher A emission");
  try {
    stage.publish(200);
    send("published");
  } catch (error) {
    send(`failed:${error.message}`);
    stage.discard();
  }
  NodeProcess.disconnect();
} else {
  NodeProcess.default.on("message", (command) => {
    if (command === "close") {
      stage?.discard();
      NodeProcess.disconnect();
      return;
    }
    if (!stage) {
      stage = createGeneratedBuildStage(cwd, root);
      NodeFS.writeFileSync(NodePath.join(stage.directory, "old.js"), "original emission");
      send("stage-created");
    }
    try {
      stage.publish(300);
      send("published");
    } catch (error) {
      send(`blocked:${error.name}:${error.message}`);
    }
  });
  send("ready");
}
