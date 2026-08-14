import {
  LastCodeSettingsImportPreviewSchema,
  LastCodeSettingsImportResultSchema,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import * as DesktopEnvironment from "../../app/DesktopEnvironment.ts";
import * as DesktopLifecycle from "../../app/DesktopLifecycle.ts";
import * as DesktopAppSettings from "../../settings/DesktopAppSettings.ts";
import {
  importT3Settings as importT3SettingsFiles,
  isT3SettingsImportSupported,
  previewT3SettingsImport as previewT3SettingsImportFiles,
  type LastCodeSettingsImportPaths,
} from "../../settings/LastCodeSettingsImport.ts";
import * as IpcChannels from "../channels.ts";
import * as DesktopIpc from "../DesktopIpc.ts";

function resolveImportPaths(
  environment: DesktopEnvironment.DesktopEnvironment["Service"],
): LastCodeSettingsImportPaths {
  return {
    sourceDirectory: environment.path.join(environment.homeDirectory, ".t3", "userdata"),
    destinationDirectory: environment.stateDir,
    backupRootDirectory: environment.path.join(environment.baseDir, "settings-import-backups"),
  };
}

const WSL_ONLY_IMPORT_MESSAGE =
  "Import is unavailable while WSL-only mode is selected. Disable WSL-only mode before importing the Windows profile.";

class LastCodeSettingsImportUnavailableError extends Schema.TaggedErrorClass<LastCodeSettingsImportUnavailableError>()(
  "LastCodeSettingsImportUnavailableError",
  { reason: Schema.String },
) {
  override get message(): string {
    return this.reason;
  }
}

export const previewT3SettingsImport = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.LASTCODE_SETTINGS_IMPORT_PREVIEW_CHANNEL,
  payload: Schema.Void,
  result: LastCodeSettingsImportPreviewSchema,
  handler: Effect.fn("desktop.ipc.lastCodeSettings.previewImport")(function* () {
    const environment = yield* DesktopEnvironment.DesktopEnvironment;
    const appSettings = yield* DesktopAppSettings.DesktopAppSettings;
    const preview = yield* Effect.tryPromise(() =>
      previewT3SettingsImportFiles(resolveImportPaths(environment)),
    );
    return !isT3SettingsImportSupported(environment.platform, (yield* appSettings.get).wslOnly)
      ? { ...preview, canImport: false, message: WSL_ONLY_IMPORT_MESSAGE }
      : preview;
  }),
});

export const importT3Settings = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.LASTCODE_SETTINGS_IMPORT_CHANNEL,
  payload: Schema.Void,
  result: LastCodeSettingsImportResultSchema,
  handler: Effect.fn("desktop.ipc.lastCodeSettings.import")(function* () {
    const environment = yield* DesktopEnvironment.DesktopEnvironment;
    const appSettings = yield* DesktopAppSettings.DesktopAppSettings;
    if (!isT3SettingsImportSupported(environment.platform, (yield* appSettings.get).wslOnly)) {
      return yield* new LastCodeSettingsImportUnavailableError({ reason: WSL_ONLY_IMPORT_MESSAGE });
    }
    const result = yield* Effect.tryPromise(() =>
      importT3SettingsFiles(resolveImportPaths(environment)),
    );
    const lifecycle = yield* DesktopLifecycle.DesktopLifecycle;
    yield* lifecycle.relaunch("t3-settings-imported");
    return result;
  }),
});
