#!/usr/bin/env node

// Dependency-free fake used only by the isolated public-documentation fixture.
// It speaks the packaged desktop helper protocol without fetching or building anything.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

const RESULT_PREFIX = "LASTCODE_LOCAL_UPDATE_RESULT=";
const AVAILABLE_TAG = "lastcode/revision/v0.0.13-nightly.20260830.1200.1";
const AVAILABLE_VERSION = "0.0.13-nightly.20260830.1200.1";
const BUILD_MARKERS = [
  "[lastcode:ci] 1/11 Repository integrity",
  "[lastcode:ci] 3/11 Workspace typecheck",
  "[lastcode:ci] 4/11 Workspace tests",
  "[desktop-artifact] Building desktop/server/web artifacts",
  "[desktop-artifact] Building mac/dmg",
];

function parseOptions(argv) {
  const command = argv[0];
  if (command !== "inspect" && command !== "build") {
    throw new Error("Expected 'inspect' or 'build'.");
  }
  const values = new Map();
  for (let index = 1; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!flag?.startsWith("--") || value === undefined) {
      throw new Error(`Invalid helper argument '${flag ?? ""}'.`);
    }
    values.set(flag, value);
  }
  const home = values.get("--home");
  if (!home) throw new Error("Missing --home.");
  if (command === "build" && values.get("--checkpoint") !== AVAILABLE_TAG) {
    throw new Error("The documentation fixture only builds its advertised revision.");
  }
  return { command, home };
}

function writeResult(result) {
  process.stdout.write(`${RESULT_PREFIX}${JSON.stringify(result)}\n`);
}

function inspect() {
  writeResult({
    schemaVersion: 2,
    status: "available",
    checkpointTag: AVAILABLE_TAG,
    availableVersion: AVAILABLE_VERSION,
    releaseNotes: {
      lastCode: {
        status: "known",
        items: [
          "Document resumable Project Actions",
          "Keep thread annotations visible in the sidebar",
        ],
        omittedItems: 0,
      },
      upstream: {
        groups: [
          {
            version: "v0.0.13-nightly.20260830.1200",
            isTarget: true,
            items: ["Improve thread navigation", "Polish update progress"],
            omittedItems: 0,
          },
        ],
        omittedGroups: 0,
      },
    },
  });
}

async function build(home) {
  const updateRoot = NodePath.join(home, ".lastcode", "local-updates");
  const buildRoot = NodePath.join(updateRoot, "fixture-build");
  const logPath = NodePath.join(updateRoot, "build.log");
  NodeFS.mkdirSync(buildRoot, { recursive: true, mode: 0o700 });
  NodeFS.writeFileSync(logPath, "", { mode: 0o600 });
  for (const marker of BUILD_MARKERS) {
    NodeFS.appendFileSync(logPath, `${marker}\n`);
    await new Promise((resolve) => setTimeout(resolve, 350));
  }

  const dmgPath = NodePath.join(buildRoot, `LastCode-${AVAILABLE_VERSION}-arm64.dmg`);
  const manifestPath = NodePath.join(buildRoot, "build-manifest.json");
  NodeFS.writeFileSync(dmgPath, "Synthetic LastCode documentation fixture.\n", { mode: 0o600 });
  const dmgSha256 = NodeCrypto.createHash("sha256")
    .update(NodeFS.readFileSync(dmgPath))
    .digest("hex");
  NodeFS.writeFileSync(
    manifestPath,
    `${JSON.stringify({ schemaVersion: 1, fixture: true, checkpointTag: AVAILABLE_TAG }, null, 2)}\n`,
    { mode: 0o600 },
  );
  writeResult({
    schemaVersion: 1,
    status: "built",
    checkpointTag: AVAILABLE_TAG,
    outputDir: buildRoot,
    manifestPath,
    dmgPath,
    dmgSha256,
  });
}

const options = parseOptions(process.argv.slice(2));
if (options.command === "inspect") inspect();
else await build(options.home);
