import * as NodeFS from "node:fs";
import * as NodeNet from "node:net";
import * as NodeReadline from "node:readline";
import * as NodeAssert from "node:assert/strict";

const send = (command) => NodeFS.writeSync(7, `${JSON.stringify(command)}\n`);
const replies = NodeReadline.createInterface({
  input: new NodeNet.Socket({ fd: 6, readable: true, writable: false }),
});
const preparationFailure = process.argv[2] === "preparation-failure";
const catalogueFailure = process.argv[2] === "catalogue-failure";
let expected = "profiles-first";
const watchdog = preparationFailure
  ? undefined
  : setTimeout(() => {
      console.error(`native browser fixture stalled awaiting ${expected}`);
      process.exit(1);
    }, 5_000);
replies.on("line", (line) => {
  const event = JSON.parse(line);
  NodeAssert.equal(event.type, "profiles");
  NodeAssert.equal(event.requestId, expected);
  NodeAssert.equal(event.supportsNativeRoots, true);
  if (catalogueFailure) NodeAssert.equal(event.profiles, null);
  else {
    NodeAssert.equal(event.profiles.defaultProfileId, "default");
    NodeAssert.ok(
      event.profiles.profiles.some((profile) => profile.name === "private-profile-name-sentinel"),
    );
  }
  console.log(`received:${expected}`);
  if (expected === "profiles-first") {
    expected = "profiles-second";
    send({ type: "profiles", requestId: expected });
  } else {
    clearTimeout(watchdog);
    console.log("verified");
    // Keep inherited pipes open until the parent stops its own backend run.
  }
});
const bootstrap = NodeReadline.createInterface({
  input: new NodeNet.Socket({ fd: 3, readable: true, writable: false }),
});
bootstrap.once("line", () => {
  console.log("bootstrap-received");
  send({ type: "reconcileRoots", serverEpoch: "fixture-epoch", retainedRootRequestIds: [] });
  if (!preparationFailure) send({ type: "profiles", requestId: expected });
});
