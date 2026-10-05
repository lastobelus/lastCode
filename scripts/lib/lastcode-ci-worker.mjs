// The compiler starts only after its parent has durably recorded this group.
// If the parent dies earlier, IPC disconnect ends this idle worker harmlessly.
import * as NodeChildProcess from "node:child_process";
import * as NodeProcess from "node:process";

const workerProcess = NodeProcess.default;

let started = false;
let stopping = false;

function stopOwnedGroup() {
  if (stopping) return;
  stopping = true;
  if (!started) NodeProcess.exit(0);
  NodeProcess.kill(-NodeProcess.pid, "SIGTERM");
  setTimeout(() => NodeProcess.kill(-NodeProcess.pid, "SIGKILL"), 2_000);
}

function finishWorker(code) {
  // After controller death this worker owns the final group kill. A launcher
  // exiting on TERM must not discard that timer while descendants remain.
  if (stopping) return;
  NodeProcess.exit(code);
}

workerProcess.on("SIGTERM", stopOwnedGroup);
workerProcess.on("SIGINT", stopOwnedGroup);
workerProcess.on("disconnect", stopOwnedGroup);
workerProcess.once("message", (value) => {
  if (
    !value ||
    typeof value !== "object" ||
    typeof value.command !== "string" ||
    !Array.isArray(value.args) ||
    !value.args.every((arg) => typeof arg === "string")
  ) {
    NodeProcess.exit(1);
  }
  started = true;
  const child = NodeChildProcess.spawn(value.command, value.args, { stdio: "inherit" });
  child.once("error", (error) => {
    NodeProcess.stderr.write(`${error.message}\n`);
    finishWorker(1);
  });
  child.once("close", (code) => finishWorker(code ?? 1));
});
