// @effect-diagnostics nodeBuiltinImport:off -- Preview preparation runs before the development server's Effect runtime starts.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { fromLenientJson } from "@t3tools/shared/schemaJson";

import { readChromiumLocalStorage } from "../../desktop/src/app/chromiumLocalStorage.ts";

interface PreparePreviewSettingsOptions {
  sourceStateDir: string;
  sourceBrowserProfile: string;
  sourceOrigin: string;
  targetHome: string;
}

type LocalStorageReader = (
  directory: string,
  origin: string,
) => Promise<ReadonlyMap<string, string>>;

const readSavedLocalStorage: LocalStorageReader = (directory, origin) =>
  Effect.runPromise(
    readChromiumLocalStorage(directory, origin).pipe(Effect.provide(NodeServices.layer)),
  );

const settingsFiles = [
  "client-settings.json",
  "settings.json",
  "keybindings.json",
  "desktop-settings.json",
] as const;

const browserPreferenceKeys = [
  "t3code:theme",
  "t3code:theme-follow-system",
  "t3code:theme-appearance-mode",
  "t3code:theme-halves:v1",
  "t3code:themes:v1",
  "t3code:typography-advanced",
  "chat_thread_sidebar_width",
  "t3code:usage-page-preferences:v1",
  "t3code:last-editor",
  "t3code:last-enabled-project-grouping-mode",
  "t3code:sidebar:settled-expanded",
  "t3code:sidebar:snoozed-expanded",
  "t3code:sidebar:working-expanded",
  "t3code.diffFileTreeOpen",
  "t3code.pullRequestFileTreeOpen",
  "t3code.fileExplorerOpen",
  "t3code.renderMarkdown",
  "t3code.renderBrowserFile",
  "t3code.renderTable",
  "t3code:pull-request-comment-filter:v1",
  "t3.pullRequests.preferences",
];
const decodeSavedSettings = Schema.decodeSync(fromLenientJson(Schema.Unknown));
const decodeUiPreferences = Schema.decodeSync(
  Schema.fromJsonString(
    Schema.Struct({ pullRequestMergeMethod: Schema.optionalKey(Schema.String) }),
  ),
);

const isMissing = (error: unknown) =>
  error instanceof Error && "code" in error && error.code === "ENOENT";

// Resolve existing parents too, so a not-yet-created destination cannot hide a
// link back into the running app's state or browser profile.
async function resolveDestination(destination: string): Promise<string> {
  try {
    return await NodeFSP.realpath(destination);
  } catch (error) {
    if (!isMissing(error)) throw error;
    const entry = await NodeFSP.lstat(destination).catch((cause: unknown) => {
      if (!isMissing(cause)) throw cause;
      return undefined;
    });
    if (entry?.isSymbolicLink()) {
      return resolveDestination(
        NodePath.resolve(NodePath.dirname(destination), await NodeFSP.readlink(destination)),
      );
    }
    const parent = NodePath.dirname(destination);
    if (parent === destination) throw error;
    return NodePath.join(await resolveDestination(parent), NodePath.basename(destination));
  }
}

function isWithin(candidate: string, directory: string) {
  const relative = NodePath.relative(directory, candidate);
  return (
    relative === "" ||
    (!relative.startsWith(`..${NodePath.sep}`) &&
      relative !== ".." &&
      !NodePath.isAbsolute(relative))
  );
}

export async function preparePreviewSettings(
  options: PreparePreviewSettingsOptions,
  readLocalStorage: LocalStorageReader = readSavedLocalStorage,
) {
  const sourceStateDir = await NodeFSP.realpath(options.sourceStateDir);
  const sourceBrowserProfile = await NodeFSP.realpath(options.sourceBrowserProfile);
  const sourceThemesDir = await NodeFSP.realpath(NodePath.join(sourceStateDir, "themes")).catch(
    (error: unknown) => {
      if (!isMissing(error)) throw error;
      return undefined;
    },
  );
  const themeFiles: string[] = [];
  const protectedSources = [sourceStateDir, sourceBrowserProfile];
  if (sourceThemesDir) {
    protectedSources.push(sourceThemesDir);
    for (const entry of await NodeFSP.readdir(sourceThemesDir, { withFileTypes: true })) {
      if (!entry.name.endsWith(".json") || (!entry.isFile() && !entry.isSymbolicLink())) continue;
      const themePath = await NodeFSP.realpath(NodePath.join(sourceThemesDir, entry.name));
      if (!(await NodeFSP.stat(themePath)).isFile()) continue;
      themeFiles.push(NodePath.join("themes", entry.name));
      protectedSources.push(themePath);
    }
  }
  const filesToCopy = [...settingsFiles, ...themeFiles];
  const targetHome = NodePath.resolve(options.targetHome);
  const targetStateDir = NodePath.join(targetHome, "userdata");
  const settingsPath = NodePath.join(targetStateDir, "preview-settings.json");
  const destinations = [
    targetHome,
    targetStateDir,
    settingsPath,
    NodePath.join(targetStateDir, "themes"),
    ...filesToCopy.map((name) => NodePath.join(targetStateDir, name)),
  ];
  for (const destination of destinations) {
    const resolved = await resolveDestination(destination);
    if (protectedSources.some((source) => isWithin(resolved, source))) {
      throw new Error(
        "Preview settings destination must be separate from the source state and browser profile.",
      );
    }
  }

  const clientBytes = await NodeFSP.readFile(NodePath.join(sourceStateDir, "client-settings.json"));
  const document = decodeSavedSettings(clientBytes.toString("utf8"));
  if (document === null || typeof document !== "object" || Array.isArray(document)) {
    throw new Error("Saved client settings must be a JSON object.");
  }
  const clientSettings = "settings" in document ? document.settings : document;
  if (
    clientSettings === null ||
    typeof clientSettings !== "object" ||
    Array.isArray(clientSettings)
  ) {
    throw new Error("Saved client settings must contain a settings object.");
  }

  const savedStorage = await readLocalStorage(
    NodePath.join(sourceBrowserProfile, "Local Storage", "leveldb"),
    options.sourceOrigin,
  );
  const localStorage: Record<string, string | null> = Object.fromEntries(
    browserPreferenceKeys.map((key) => [key, null]),
  );
  let browserPreferenceCount = 0;
  for (const [key, value] of savedStorage) {
    if (browserPreferenceKeys.includes(key) || key.startsWith("t3code:theme-")) {
      localStorage[key] = value;
      browserPreferenceCount++;
    }
  }
  localStorage["t3code:client-settings:v1"] = JSON.stringify(clientSettings);
  localStorage["t3code:ui-state:v1"] = JSON.stringify(
    decodeUiPreferences(savedStorage.get("t3code:ui-state:v1") ?? "{}"),
  );

  await NodeFSP.mkdir(targetStateDir, { recursive: true });
  const targetThemesDir = NodePath.join(targetStateDir, "themes");
  const previousThemes = await NodeFSP.readdir(targetThemesDir).catch((error: unknown) => {
    if (!isMissing(error)) throw error;
    return [];
  });
  for (const name of previousThemes) {
    if (name.endsWith(".json") && !themeFiles.includes(NodePath.join("themes", name))) {
      await NodeFSP.unlink(NodePath.join(targetThemesDir, name));
    }
  }
  if (themeFiles.length > 0) {
    await NodeFSP.mkdir(targetThemesDir, { recursive: true });
  }
  const copiedFiles: string[] = [];
  for (const name of filesToCopy) {
    try {
      if (name === "client-settings.json") {
        await NodeFSP.writeFile(NodePath.join(targetStateDir, name), clientBytes);
      } else {
        await NodeFSP.copyFile(
          NodePath.join(sourceStateDir, name),
          NodePath.join(targetStateDir, name),
        );
      }
      copiedFiles.push(name);
    } catch (error) {
      if (name === "client-settings.json" || !isMissing(error)) throw error;
      await NodeFSP.rm(NodePath.join(targetStateDir, name), { force: true });
    }
  }
  const id = NodeCrypto.randomUUID();
  await NodeFSP.writeFile(settingsPath, JSON.stringify({ id, localStorage }), { mode: 0o600 });
  return { id, settingsPath, copiedFiles, browserPreferenceCount };
}
