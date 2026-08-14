// @effect-diagnostics nodeBuiltinImport:off -- These integration tests exercise the real atomic filesystem transaction in temporary directories.
import { assert, describe, it } from "@effect/vitest";
import {
  DEFAULT_CLIENT_SETTINGS,
  DEFAULT_SERVER_SETTINGS,
  ServerSettings,
} from "@t3tools/contracts";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeOS from "node:os";
import * as Schema from "effect/Schema";

const fs = NodeFS.promises;

import {
  importT3Settings,
  previewT3SettingsImport,
  type LastCodeSettingsImportPaths,
} from "./LastCodeSettingsImport.ts";

const encodeServerSettings = Schema.encodeSync(ServerSettings);

async function makePaths(): Promise<LastCodeSettingsImportPaths> {
  const root = await fs.mkdtemp(NodePath.join(NodeOS.tmpdir(), "lastcode-settings-import-"));
  const paths = {
    sourceDirectory: NodePath.join(root, "t3"),
    destinationDirectory: NodePath.join(root, "lastcode"),
    backupRootDirectory: NodePath.join(root, "backups"),
  };
  await Promise.all([
    fs.mkdir(paths.sourceDirectory, { recursive: true }),
    fs.mkdir(paths.destinationDirectory, { recursive: true }),
  ]);
  return paths;
}

function json(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function record(value: unknown): Record<string, unknown> {
  assert.isObject(value);
  assert.isNotArray(value);
  return value as Record<string, unknown>;
}

async function expectRejected(effect: () => Promise<unknown>): Promise<void> {
  let rejected = false;
  try {
    await effect();
  } catch {
    rejected = true;
  }
  assert.isTrue(rejected);
}

describe("LastCodeSettingsImport", () => {
  it("previews missing and invalid categories without exposing file contents", async () => {
    const paths = await makePaths();
    await fs.writeFile(NodePath.join(paths.sourceDirectory, "client-settings.json"), "not-json");
    await fs.writeFile(
      NodePath.join(paths.sourceDirectory, "keybindings.json"),
      "[\n  // T3 Code accepts JSONC here.\n]\n",
    );

    const preview = await previewT3SettingsImport(paths);

    assert.equal(preview.canImport, true);
    assert.deepEqual(
      preview.categories.map(({ id, status }) => ({ id, status })),
      [
        { id: "client-preferences", status: "invalid" },
        { id: "keybindings", status: "ready" },
        { id: "server-preferences", status: "missing" },
      ],
    );
  });

  it("imports allowlisted preferences while preserving LastCode-only state and secrets", async () => {
    const paths = await makePaths();
    const sourceClient = { ...DEFAULT_CLIENT_SETTINGS, fontSizeInterface: 17 };
    const sourceServer = record(structuredClone(encodeServerSettings(DEFAULT_SERVER_SETTINGS)));
    const sourceProviders = record(sourceServer.providers);
    const sourceOpenCode = record(sourceProviders.opencode);
    const sourceCodex = record(sourceProviders.codex);
    sourceServer.addProjectBaseDirectory = "/src/t3-projects";
    sourceOpenCode.serverUrl = "http://127.0.0.1:4096";
    sourceOpenCode.serverPassword = "source-secret";
    sourceCodex.launchArgs = "--source-secret token";
    sourceServer.providerInstances = {
      personal: {
        driver: "codex",
        environment: [{ name: "TOKEN", value: "source-token", sensitive: true }],
      },
    };

    const destinationServer = record(
      structuredClone(encodeServerSettings(DEFAULT_SERVER_SETTINGS)),
    );
    const destinationProviders = record(destinationServer.providers);
    const destinationOpenCode = record(destinationProviders.opencode);
    const destinationCodex = record(destinationProviders.codex);
    destinationServer.addProjectBaseDirectory = "/src/lastcode-projects";
    destinationOpenCode.serverPassword = "lastcode-secret";
    destinationCodex.launchArgs = "--lastcode-only";
    destinationServer.providerInstances = {
      lastcode: {
        driver: "codex",
        environment: [{ name: "TOKEN", value: "lastcode-token", sensitive: true }],
      },
    };
    await Promise.all([
      fs.writeFile(
        NodePath.join(paths.sourceDirectory, "client-settings.json"),
        `// T3 Code accepts JSONC here.\n${json(sourceClient)}`,
      ),
      fs.writeFile(NodePath.join(paths.sourceDirectory, "keybindings.json"), "[\n  // none\n]\n"),
      fs.writeFile(
        NodePath.join(paths.sourceDirectory, "settings.json"),
        `// T3 Code accepts JSONC here.\n${json(sourceServer)}`,
      ),
      fs.writeFile(
        NodePath.join(paths.destinationDirectory, "settings.json"),
        `// LastCode accepts JSONC here too.\n${json(destinationServer)}`,
      ),
    ]);

    const result = await importT3Settings(paths);
    const importedClient = JSON.parse(
      await fs.readFile(NodePath.join(paths.destinationDirectory, "client-settings.json"), "utf8"),
    ) as Record<string, unknown>;
    const importedServer = record(
      JSON.parse(
        await fs.readFile(NodePath.join(paths.destinationDirectory, "settings.json"), "utf8"),
      ) as unknown,
    );
    const importedProviders = record(importedServer.providers);
    const importedOpenCode = record(importedProviders.opencode);
    const importedCodex = record(importedProviders.codex);
    assert.equal(importedClient.fontSizeInterface, 17);
    assert.equal(importedServer.addProjectBaseDirectory, "/src/t3-projects");
    assert.equal(importedOpenCode.serverUrl, "http://127.0.0.1:4096");
    assert.equal(importedOpenCode.serverPassword, "lastcode-secret");
    assert.equal(importedCodex.launchArgs, "--lastcode-only");
    assert.deepEqual(importedServer.providerInstances, destinationServer.providerInstances);
    assert.deepEqual(result.imported, ["client-preferences", "keybindings", "server-preferences"]);
    assert.include(
      await fs.readFile(NodePath.join(result.backupDirectory, "settings.json"), "utf8"),
      '"serverPassword": "lastcode-secret"',
    );
    assert.equal(
      JSON.parse(await fs.readFile(NodePath.join(result.backupDirectory, "manifest.json"), "utf8"))
        .files.length,
      3,
    );
  });

  it("refuses to import when the source and destination are the same directory", async () => {
    const paths = await makePaths();
    const preview = await previewT3SettingsImport({
      ...paths,
      destinationDirectory: paths.sourceDirectory,
    });

    assert.equal(preview.canImport, false);
    assert.isTrue(preview.categories.every((category) => category.status === "invalid"));
  });

  it("validates every destination before replacing any file", async () => {
    const paths = await makePaths();
    await Promise.all([
      fs.writeFile(
        NodePath.join(paths.sourceDirectory, "client-settings.json"),
        json(DEFAULT_CLIENT_SETTINGS),
      ),
      fs.writeFile(
        NodePath.join(paths.sourceDirectory, "settings.json"),
        json(encodeServerSettings(DEFAULT_SERVER_SETTINGS)),
      ),
      fs.writeFile(NodePath.join(paths.destinationDirectory, "settings.json"), "not-json"),
    ]);

    await expectRejected(() => importT3Settings(paths));
    await expectRejected(() =>
      fs.readFile(NodePath.join(paths.destinationDirectory, "client-settings.json")),
    );
  });
});
