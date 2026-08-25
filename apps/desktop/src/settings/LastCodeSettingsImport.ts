// @effect-diagnostics nodeBuiltinImport:off cryptoRandomUUID:off globalDate:off -- This adapter performs one bounded, transactional import against host profile files before the desktop process relaunches.
import {
  ClientSettingsSchema,
  KeybindingRule,
  KeybindingsConfig,
  MAX_KEYBINDINGS_COUNT,
  ServerSettings,
  type LastCodeSettingsImportCategory,
  type LastCodeSettingsImportCategoryId,
  type LastCodeSettingsImportPreview,
  type LastCodeSettingsImportResult,
} from "@t3tools/contracts";
import { compileResolvedKeybindingRule } from "@t3tools/shared/keybindings";
import { fromLenientJson } from "@t3tools/shared/schemaJson";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as Schema from "effect/Schema";

const fs = NodeFS.promises;
const fsConstants = NodeFS.constants;

const ClientSettingsDocumentSchema = Schema.Struct({ settings: ClientSettingsSchema });
const ClientSettingsJson = fromLenientJson(ClientSettingsSchema);
const LegacyClientSettingsDocumentJson = fromLenientJson(ClientSettingsDocumentSchema);
const RawKeybindingsJson = fromLenientJson(Schema.Array(Schema.Unknown));
const KeybindingsJson = fromLenientJson(KeybindingsConfig);
const ServerSettingsJson = fromLenientJson(ServerSettings);

const decodeClientSettingsJson = Schema.decodeUnknownSync(ClientSettingsJson);
const decodeLegacyClientSettingsDocumentJson = Schema.decodeUnknownSync(
  LegacyClientSettingsDocumentJson,
);
const encodeClientSettingsJson = Schema.encodeSync(ClientSettingsJson);
const decodeRawKeybindingsJson = Schema.decodeUnknownSync(RawKeybindingsJson);
const decodeKeybindingRule = Schema.decodeUnknownSync(KeybindingRule);
const encodeKeybindingsJson = Schema.encodeSync(KeybindingsJson);
const decodeServerSettingsJson = Schema.decodeUnknownSync(ServerSettingsJson);
const encodeServerSettings = Schema.encodeSync(ServerSettings);

const CATEGORY_DEFINITIONS: ReadonlyArray<{
  readonly id: LastCodeSettingsImportCategoryId;
  readonly label: string;
  readonly sourceFile: string;
  readonly detail: string;
}> = [
  {
    id: "client-preferences",
    label: "Appearance and app preferences",
    sourceFile: "client-settings.json",
    detail: "Theme, fonts, editor, sidebar, confirmations, and model display preferences.",
  },
  {
    id: "keybindings",
    label: "Keyboard shortcuts",
    sourceFile: "keybindings.json",
    detail: "Custom keybinding rules.",
  },
  {
    id: "server-preferences",
    label: "Server behavior",
    sourceFile: "settings.json",
    detail: "Background behavior, Git fetch, thread defaults, and source-control writing.",
  },
];

export const LASTCODE_SETTINGS_IMPORT_EXCLUSIONS = [
  "Projects, threads, checkpoints, attachments, and databases",
  "Provider configuration, credentials, instances, and model selections",
  "Saved environments, connections, and machine identity",
  "Desktop window state, network exposure, Tailscale, ports, and WSL runtime selection",
  "Update channels, local-nightly settings, caches, logs, and browser storage",
] as const;

const BUILT_IN_PROVIDER_INSTANCE_IDS = new Set([
  "codex",
  "claudeAgent",
  "cursor",
  "grok",
  "opencode",
]);

const SAFE_SERVER_SETTING_KEYS = [
  "enableLegacyTokenStreaming",
  "enableProviderUpdateChecks",
  "backgroundActivity",
  "automaticGitFetchInterval",
  "providerHealthRefreshInterval",
  "backgroundActivityProfile",
  "defaultThreadEnvMode",
  "newWorktreesStartFromOrigin",
  "addProjectBaseDirectory",
  "sourceControlWritingStyle",
] as const;

type JsonRecord = Record<string, unknown>;

export interface LastCodeSettingsImportPaths {
  readonly sourceDirectory: string;
  readonly destinationDirectory: string;
  readonly backupRootDirectory: string;
}

export function isT3SettingsImportSupported(platform: NodeJS.Platform, wslOnly: boolean): boolean {
  return platform !== "win32" || !wslOnly;
}

interface PreparedWrite {
  readonly id: LastCodeSettingsImportCategoryId;
  readonly fileName: string;
  readonly targetPath: string;
  readonly content: string;
  readonly previousContent: string | null;
}

function asRecord(value: unknown, description: string): JsonRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${description} must be a JSON object.`);
  }
  return value as JsonRecord;
}

function decodeSourceClientSettings(raw: string) {
  try {
    return decodeLegacyClientSettingsDocumentJson(raw).settings;
  } catch {
    return decodeClientSettingsJson(raw);
  }
}

function decodeUsableKeybindings(raw: string) {
  const keybindings = [];
  for (const entry of decodeRawKeybindingsJson(raw)) {
    try {
      const rule = decodeKeybindingRule(entry);
      if (compileResolvedKeybindingRule(rule) !== null) keybindings.push(rule);
    } catch {
      // T3 Code ignores obsolete or malformed entries while retaining the rest of the file.
    }
  }
  return keybindings.slice(-MAX_KEYBINDINGS_COUNT);
}

function safeServerPreferences(raw: string): JsonRecord {
  const encoded = asRecord(
    encodeServerSettings(decodeServerSettingsJson(raw)),
    "Encoded server settings",
  );
  const selected: JsonRecord = {};
  for (const key of SAFE_SERVER_SETTING_KEYS) selected[key] = encoded[key];
  return selected;
}

function validateSource(id: LastCodeSettingsImportCategoryId, raw: string): void {
  switch (id) {
    case "client-preferences":
      decodeSourceClientSettings(raw);
      return;
    case "keybindings":
      decodeUsableKeybindings(raw);
      return;
    case "server-preferences":
      safeServerPreferences(raw);
      return;
  }
}

async function readOptional(path: string): Promise<string | null> {
  try {
    return await fs.readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function inspectCategory(
  definition: (typeof CATEGORY_DEFINITIONS)[number],
  sourceDirectory: string,
): Promise<LastCodeSettingsImportCategory> {
  const raw = await readOptional(NodePath.join(sourceDirectory, definition.sourceFile));
  if (raw === null) return { ...definition, status: "missing" };
  try {
    validateSource(definition.id, raw);
    return { ...definition, status: "ready" };
  } catch {
    return { ...definition, status: "invalid" };
  }
}

export async function previewT3SettingsImport(
  paths: LastCodeSettingsImportPaths,
): Promise<LastCodeSettingsImportPreview> {
  const sourceDirectory = NodePath.resolve(paths.sourceDirectory);
  const destinationDirectory = NodePath.resolve(paths.destinationDirectory);
  const sameDirectory = sourceDirectory === destinationDirectory;
  const categories = sameDirectory
    ? CATEGORY_DEFINITIONS.map((definition) => ({ ...definition, status: "invalid" as const }))
    : await Promise.all(
        CATEGORY_DEFINITIONS.map((definition) => inspectCategory(definition, sourceDirectory)),
      );
  return {
    sourceDirectory,
    destinationDirectory,
    categories,
    excluded: LASTCODE_SETTINGS_IMPORT_EXCLUSIONS,
    canImport: !sameDirectory && categories.some((category) => category.status === "ready"),
    message: sameDirectory ? "T3 Code and LastCode resolve to the same settings directory." : null,
  };
}

function stringifyJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function mergeClientSettings(sourceRaw: string, destinationRaw: string | null): string {
  const source = decodeSourceClientSettings(sourceRaw);
  const destination =
    destinationRaw === null
      ? decodeClientSettingsJson("{}")
      : decodeSourceClientSettings(destinationRaw);
  const isBuiltInProviderPreference = (provider: string) =>
    BUILT_IN_PROVIDER_INSTANCE_IDS.has(provider);
  const favorites = [
    ...destination.favorites.filter(({ provider }) => !isBuiltInProviderPreference(provider)),
    ...source.favorites.filter(({ provider }) => isBuiltInProviderPreference(provider)),
  ];
  const providerModelPreferences = Object.fromEntries([
    ...Object.entries(destination.providerModelPreferences).filter(
      ([provider]) => !isBuiltInProviderPreference(provider),
    ),
    ...Object.entries(source.providerModelPreferences).filter(([provider]) =>
      isBuiltInProviderPreference(provider),
    ),
  ]);
  return `${encodeClientSettingsJson({
    ...source,
    favorites,
    providerModelPreferences,
    environmentIconColors: destination.environmentIconColors,
    legacySidebarScale: destination.legacySidebarScale,
    roundedProjectIcons: destination.roundedProjectIcons,
    showLocalEnvironmentIcon: destination.showLocalEnvironmentIcon,
  })}\n`;
}

function mergeServerSettings(sourceRaw: string, destinationRaw: string | null): string {
  const destination =
    destinationRaw === null
      ? asRecord(encodeServerSettings(decodeServerSettingsJson("{}")), "Server settings")
      : asRecord(encodeServerSettings(decodeServerSettingsJson(destinationRaw)), "Server settings");
  const imported = safeServerPreferences(sourceRaw);
  return stringifyJson({ ...destination, ...imported });
}

function buildImportedContent(
  id: LastCodeSettingsImportCategoryId,
  sourceRaw: string,
  destinationRaw: string | null,
): string {
  switch (id) {
    case "client-preferences":
      return mergeClientSettings(sourceRaw, destinationRaw);
    case "keybindings":
      return `${encodeKeybindingsJson(decodeUsableKeybindings(sourceRaw))}\n`;
    case "server-preferences":
      return mergeServerSettings(sourceRaw, destinationRaw);
  }
}

async function prepareWrites(
  paths: LastCodeSettingsImportPaths,
  categories: readonly LastCodeSettingsImportCategory[],
): Promise<PreparedWrite[]> {
  const writes: PreparedWrite[] = [];
  for (const category of categories) {
    if (category.status !== "ready") continue;
    const sourcePath = NodePath.join(paths.sourceDirectory, category.sourceFile);
    const targetPath = NodePath.join(paths.destinationDirectory, category.sourceFile);
    const [sourceRaw, previousContent] = await Promise.all([
      fs.readFile(sourcePath, "utf8"),
      readOptional(targetPath),
    ]);
    writes.push({
      id: category.id,
      fileName: category.sourceFile,
      targetPath,
      content: buildImportedContent(category.id, sourceRaw, previousContent),
      previousContent,
    });
  }
  return writes;
}

async function replaceFileAtomically(targetPath: string, content: string): Promise<void> {
  const temporaryPath = `${targetPath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporaryPath, content, { encoding: "utf8", mode: 0o600 });
    await fs.rename(temporaryPath, targetPath);
  } finally {
    await fs.rm(temporaryPath, { force: true }).catch(() => undefined);
  }
}

async function restoreWrites(writes: readonly PreparedWrite[]): Promise<void> {
  const errors: unknown[] = [];
  for (const write of writes.toReversed()) {
    try {
      if (write.previousContent === null) {
        await fs.rm(write.targetPath, { force: true });
      } else {
        await replaceFileAtomically(write.targetPath, write.previousContent);
      }
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length > 0) throw new AggregateError(errors, "Could not roll back imported settings.");
}

export async function importT3Settings(
  paths: LastCodeSettingsImportPaths,
): Promise<LastCodeSettingsImportResult> {
  const preview = await previewT3SettingsImport(paths);
  if (!preview.canImport) throw new Error("No valid T3 Code settings are available to import.");

  const writes = await prepareWrites(paths, preview.categories);
  await fs.mkdir(paths.destinationDirectory, { recursive: true, mode: 0o700 });
  await fs.mkdir(paths.backupRootDirectory, { recursive: true, mode: 0o700 });
  const backupDirectory = NodePath.join(
    paths.backupRootDirectory,
    `${new Date().toISOString().replace(/[:.]/g, "-")}-${crypto.randomUUID().slice(0, 8)}`,
  );
  await fs.mkdir(backupDirectory, { mode: 0o700 });

  for (const write of writes) {
    if (write.previousContent !== null) {
      await fs.writeFile(NodePath.join(backupDirectory, write.fileName), write.previousContent, {
        encoding: "utf8",
        mode: 0o600,
      });
    }
  }
  await fs.writeFile(
    NodePath.join(backupDirectory, "manifest.json"),
    stringifyJson({
      importedAt: new Date().toISOString(),
      sourceDirectory: preview.sourceDirectory,
      destinationDirectory: preview.destinationDirectory,
      files: writes.map((write) => ({
        category: write.id,
        file: write.fileName,
        hadPreviousVersion: write.previousContent !== null,
      })),
    }),
    { encoding: "utf8", mode: 0o600 },
  );

  const replaced: PreparedWrite[] = [];
  try {
    for (const write of writes) {
      await fs.access(NodePath.dirname(write.targetPath), fsConstants.W_OK);
      await replaceFileAtomically(write.targetPath, write.content);
      replaced.push(write);
    }
  } catch (error) {
    try {
      await restoreWrites(replaced);
    } catch (rollbackError) {
      // eslint-disable-next-line preserve-caught-error -- Both caught failures are explicit AggregateError members.
      throw new AggregateError(
        [error, rollbackError],
        "Settings import and rollback both failed.",
        {
          cause: rollbackError,
        },
      );
    }
    throw error;
  }

  return { imported: writes.map((write) => write.id), backupDirectory };
}
