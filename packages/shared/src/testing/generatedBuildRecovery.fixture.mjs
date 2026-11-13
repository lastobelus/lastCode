import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeProcess from "node:process";
import * as NodeModule from "node:module";
import {
  createGeneratedBuildStage,
  inspectGeneratedBuildOwnership,
} from "../generatedBuildOwnership.ts";

const [cwd, root, operation, fault, serializedFiles = "{}"] = NodeProcess.argv.slice(2);
const send = (message) => NodeProcess.send(message);
const fs = (await import("node:fs")).default;
const prepared = (target) => String(target).includes(`${NodePath.sep}.t3-build-publication-`);
const output = NodePath.join(cwd, root);
const noSpace = () =>
  Object.assign(new Error(`Injected ENOSPC during ${fault}`), { code: "ENOSPC" });
let hits = 0;
let stage;

const installFault = () => {
  const copy = fs.copyFileSync;
  const chmod = fs.chmodSync;
  const read = fs.readFileSync;
  const write = fs.writeFileSync;
  const rename = fs.renameSync;
  let copies = 0;
  fs.copyFileSync = (source, destination, flags) => {
    if (prepared(destination) && ++copies === 2 && ["copy", "partial-write"].includes(fault)) {
      hits++;
      if (fault === "partial-write") write(destination, "partial", { flag: "wx" });
      throw noSpace();
    }
    return copy(source, destination, flags);
  };
  fs.chmodSync = (target, mode) => {
    if (prepared(target) && fault === "chmod" && hits++ === 0) throw noSpace();
    return chmod(target, mode);
  };
  fs.readFileSync = (target, ...options) => {
    if (prepared(target) && fault === "hash" && hits++ === 0) throw noSpace();
    return read(target, ...options);
  };
  fs.writeFileSync = (target, ...options) => {
    if (
      ["ledger-write", "ledger-partial-write", "watch-ledger"].includes(fault) &&
      /^t3-build-[a-f0-9]{64}\.json\.[a-f0-9-]{36}\.tmp$/.test(NodePath.basename(String(target))) &&
      hits++ === 0
    ) {
      if (fault === "ledger-partial-write") write(target, "partial record", { flag: "wx" });
      throw noSpace();
    }
    return write(target, ...options);
  };
  fs.renameSync = (source, destination) => {
    // Simulate a repository whose Git metadata is on another filesystem. A
    // verified replacement must be staged beside its destination parent.
    if (
      prepared(source) &&
      String(destination).startsWith(`${output}${NodePath.sep}`) &&
      NodePath.dirname(NodePath.dirname(String(source))) !== NodePath.dirname(String(destination))
    )
      throw Object.assign(new Error("Publication crossed a filesystem boundary"), {
        code: "EXDEV",
      });
    const result = rename(source, destination);
    if (
      fault === "death" &&
      prepared(source) &&
      String(destination).startsWith(`${output}${NodePath.sep}`) &&
      hits++ === 0
    ) {
      send({ kind: "installed", path: NodePath.relative(output, destination) });
      NodeProcess.stdin._handle.setBlocking(true);
      const command = Buffer.alloc(1);
      if (NodeFS.readSync(0, command, 0, 1, null) !== 1)
        throw new Error("Missing publication resume command");
    }
    return result;
  };
  NodeModule.syncBuiltinESMExports();
};

try {
  stage = createGeneratedBuildStage(cwd, root);
  if (operation === "publish") {
    for (const [relative, contents] of Object.entries(JSON.parse(serializedFiles))) {
      const target = NodePath.join(stage.directory, relative);
      NodeFS.mkdirSync(NodePath.dirname(target), { recursive: true });
      NodeFS.writeFileSync(target, contents);
      if (relative === "a.js") NodeFS.chmodSync(target, 0o755);
    }
    installFault();
    if (fault === "watch-ledger") {
      try {
        stage.publish(200, undefined, true);
        throw new Error("Expected the first watched publication to fail");
      } catch (error) {
        if (!error.message.includes("Injected ENOSPC")) throw error;
        send({ kind: "watch-failed", hits, message: error.message });
      }
      NodeFS.writeFileSync(NodePath.join(stage.directory, "a.js"), "watched replacement output");
      NodeFS.unlinkSync(NodePath.join(stage.directory, "b.js"));
      NodeFS.writeFileSync(NodePath.join(stage.directory, "c.js"), "watched changing chunk");
      stage.publish(300, undefined, true);
      stage.discard();
    } else {
      stage.publish(200);
    }
  } else {
    stage.discard();
  }
  send({ kind: "success", hits, inspection: inspectGeneratedBuildOwnership(cwd, root) });
} catch (error) {
  send({ kind: "failure", hits, message: error.message });
  stage?.discard();
}
NodeProcess.disconnect();
