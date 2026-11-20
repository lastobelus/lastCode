import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeProcess from "node:process";
import * as NodeModule from "node:module";
import {
  createGeneratedBuildStage,
  inspectGeneratedBuildOwnership,
  recordGeneratedBuildUse,
  removeGeneratedBuildFiles,
  removeGeneratedBuildFilesAsync,
} from "../generatedBuildOwnership.ts";

const [cwd, root, role, contents = "original emission"] = NodeProcess.argv.slice(2);
const send = (message) => NodeProcess.send(message);
let stage;
const pause = (milestone) => {
  send(milestone);
  NodeProcess.stdin._handle.setBlocking(true);
  const command = Buffer.alloc(1);
  if (NodeFS.readSync(0, command, 0, 1, null) !== 1) throw new Error("Missing resume command");
  if (command.toString() === "f") throw new Error("Injected retirement failure");
};

if (role === "paused" || role.startsWith("remove-")) {
  const fs = (await import("node:fs")).default;
  const unlink = fs.unlinkSync;
  fs.unlinkSync = (target) => {
    if (target === NodePath.join(cwd, root, "old.js"))
      pause(role === "paused" ? "paused-before-retirement" : "paused-before-removal");
    return unlink(target);
  };
  NodeModule.syncBuiltinESMExports();
  try {
    if (role === "paused") {
      stage = createGeneratedBuildStage(cwd, root);
      NodeFS.writeFileSync(NodePath.join(stage.directory, "current.js"), "publisher A emission");
      stage.publish(200);
      send("published");
    } else {
      const inspected = inspectGeneratedBuildOwnership(cwd, root);
      const removed =
        role === "remove-async"
          ? await removeGeneratedBuildFilesAsync(
              cwd,
              root,
              inspected.token,
              ["old.js"],
              async () => true,
            )
          : removeGeneratedBuildFiles(cwd, root, inspected.token, ["old.js"]);
      send(`removed:${JSON.stringify(removed)}`);
    }
  } catch (error) {
    send(`failed:${error.message}`);
    stage?.discard();
  }
  NodeProcess.disconnect();
} else if (role === "usage") {
  const fs = (await import("node:fs")).default;
  const rename = fs.renameSync;
  fs.renameSync = (source, destination) => {
    if (
      NodePath.basename(destination).startsWith("t3-build-") &&
      String(destination).endsWith(".json")
    )
      pause("paused-before-usage-write");
    return rename(source, destination);
  };
  NodeModule.syncBuiltinESMExports();
  send(`usage:${recordGeneratedBuildUse(cwd, root, 1000)}`);
  NodeProcess.disconnect();
} else {
  NodeProcess.default.on("message", (command) => {
    if (command === "close") {
      stage?.discard();
      NodeProcess.disconnect();
      return;
    }
    try {
      if (!stage) {
        stage = createGeneratedBuildStage(cwd, root);
        NodeFS.writeFileSync(NodePath.join(stage.directory, "old.js"), contents);
        send("stage-created");
      }
      stage.publish(300);
      send("published");
    } catch (error) {
      send(`blocked:${error.name}:${error.message}`);
    }
  });
  send("ready");
}
