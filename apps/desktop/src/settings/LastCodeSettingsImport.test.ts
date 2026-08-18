// @effect-diagnostics nodeBuiltinImport:off -- These integration tests exercise the real atomic filesystem transaction in temporary directories.
import { assert, describe, it } from "@effect/vitest";
import {
  DEFAULT_CLIENT_SETTINGS,
  DEFAULT_SERVER_SETTINGS,
  ProviderInstanceId,
  ServerSettings,
} from "@t3tools/contracts";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeOS from "node:os";
import * as Schema from "effect/Schema";

const fs = NodeFS.promises;

import {
  importT3Settings,
  isT3SettingsImportSupported,
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
  it("disables imports only for the Windows WSL-only profile", () => {
    assert.isFalse(isT3SettingsImportSupported("win32", true));
    assert.isTrue(isT3SettingsImportSupported("win32", false));
    assert.isTrue(isT3SettingsImportSupported("darwin", true));
    assert.isTrue(isT3SettingsImportSupported("linux", true));
  });

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
    const codex = ProviderInstanceId.make("codex");
    const sourceCustom = ProviderInstanceId.make("source_custom");
    const lastCodeCustom = ProviderInstanceId.make("lastcode_custom");
    const sourceClient = { ...DEFAULT_CLIENT_SETTINGS, fontSizeInterface: 17 };
    Reflect.deleteProperty(sourceClient, "legacySidebarScale");
    sourceClient.favorites = [
      { provider: codex, model: "gpt-source" },
      { provider: sourceCustom, model: "source-model" },
    ];
    sourceClient.providerModelPreferences = {
      [codex]: { hiddenModels: ["hidden-source"], modelOrder: ["gpt-source"] },
      [sourceCustom]: { hiddenModels: [], modelOrder: ["source-model"] },
    };
    const destinationClient = {
      ...DEFAULT_CLIENT_SETTINGS,
      legacySidebarScale: 75,
      favorites: [{ provider: lastCodeCustom, model: "lastcode-model" }],
      providerModelPreferences: {
        [lastCodeCustom]: { hiddenModels: [], modelOrder: ["lastcode-model"] },
      },
    };
    const sourceServer = record(structuredClone(encodeServerSettings(DEFAULT_SERVER_SETTINGS)));
    const sourceProviders = record(sourceServer.providers);
    const sourceOpenCode = record(sourceProviders.opencode);
    const sourceCodex = record(sourceProviders.codex);
    sourceServer.addProjectBaseDirectory = "/src/t3-projects";
    sourceOpenCode.serverUrl = "http://127.0.0.1:4096";
    sourceOpenCode.serverPassword = "source-secret";
    sourceCodex.launchArgs = "--source-secret token";
    sourceServer.textGenerationModelSelection = {
      instanceId: "opencode",
      model: "source-model",
      options: [],
    };
    sourceServer.sourceControlWriterModelSelection = {
      instanceId: "opencode",
      model: "source-writer",
      options: [],
    };
    sourceServer.providerInstances = {
      codex: {
        driver: "codex",
        displayName: "T3 Codex",
        accentColor: "#123456",
        enabled: false,
        config: {
          binaryPath: "/opt/t3/codex",
          homePath: "/Users/source/.codex",
          launchArgs: "--source-instance-secret token",
          customModels: ["source-model"],
        },
        environment: [{ name: "TOKEN", value: "source-default-token", sensitive: true }],
      },
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
    destinationOpenCode.serverUrl = "http://127.0.0.1:7777";
    destinationOpenCode.serverPassword = "lastcode-secret";
    destinationCodex.launchArgs = "--lastcode-only";
    destinationServer.textGenerationModelSelection = {
      instanceId: "codex",
      model: "lastcode-model",
      options: [],
    };
    destinationServer.sourceControlWriterModelSelection = {
      instanceId: "codex",
      model: "lastcode-writer",
      options: [],
    };
    destinationServer.providerInstances = {
      codex: {
        driver: "codex",
        enabled: true,
        config: {
          binaryPath: "/opt/lastcode/codex",
          launchArgs: "--lastcode-instance-only",
        },
        environment: [{ name: "TOKEN", value: "lastcode-default-token", sensitive: true }],
      },
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
      fs.writeFile(
        NodePath.join(paths.destinationDirectory, "client-settings.json"),
        json(destinationClient),
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
    assert.equal(importedClient.fontSizeInterface, 17);
    assert.equal(importedClient.legacySidebarScale, 75);
    assert.deepEqual(importedClient.favorites, [
      { provider: "lastcode_custom", model: "lastcode-model" },
      { provider: "codex", model: "gpt-source" },
    ]);
    assert.deepEqual(importedClient.providerModelPreferences, {
      lastcode_custom: { hiddenModels: [], modelOrder: ["lastcode-model"] },
      codex: { hiddenModels: ["hidden-source"], modelOrder: ["gpt-source"] },
    });
    assert.equal(importedServer.addProjectBaseDirectory, "/src/t3-projects");
    assert.deepEqual(importedServer.providers, destinationServer.providers);
    assert.deepEqual(importedServer.providerInstances, destinationServer.providerInstances);
    assert.deepEqual(
      importedServer.textGenerationModelSelection,
      destinationServer.textGenerationModelSelection,
    );
    assert.deepEqual(
      importedServer.sourceControlWriterModelSelection,
      destinationServer.sourceControlWriterModelSelection,
    );
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

  it("imports usable keybindings while omitting invalid entries", async () => {
    const paths = await makePaths();
    const usable = Array.from({ length: 258 }, (_, index) => ({
      key: "mod+j",
      command: "terminal.toggle",
      when: `context${index}`,
    }));
    await fs.writeFile(
      NodePath.join(paths.sourceDirectory, "keybindings.json"),
      `[
        // Obsolete commands and malformed shortcuts are ignored by T3 Code.
        { "key": "mod+x", "command": "removed.command" },
        { "key": "mod+shift+d+o", "command": "terminal.new" },
        ${usable.map((rule) => JSON.stringify(rule)).join(",\n        ")},
      ]`,
    );

    const preview = await previewT3SettingsImport(paths);
    assert.equal(preview.categories.find(({ id }) => id === "keybindings")?.status, "ready");

    await importT3Settings(paths);

    assert.deepEqual(
      JSON.parse(
        await fs.readFile(NodePath.join(paths.destinationDirectory, "keybindings.json"), "utf8"),
      ),
      usable.slice(-256),
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
