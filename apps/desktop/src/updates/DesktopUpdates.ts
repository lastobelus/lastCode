import {
  DesktopUpdateChannelSchema,
  type DesktopLocalBuildFailure,
  type DesktopLastCodeSettingsState,
  type DesktopRuntimeInfo,
  type DesktopUpdateActionResult,
  type DesktopUpdateChannel,
  type DesktopUpdateCheckResult,
  type DesktopUpdateReleaseNote,
  type DesktopUpdateState,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Scope from "effect/Scope";

import * as DesktopBackendPool from "../backend/DesktopBackendPool.ts";
import * as DesktopConfig from "../app/DesktopConfig.ts";
import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as DesktopObservability from "../app/DesktopObservability.ts";
import * as DesktopState from "../app/DesktopState.ts";
import * as ElectronApp from "../electron/ElectronApp.ts";
import * as ElectronUpdater from "../electron/ElectronUpdater.ts";
import * as ElectronWindow from "../electron/ElectronWindow.ts";
import * as IpcChannels from "../ipc/channels.ts";
import * as DesktopAppSettings from "../settings/DesktopAppSettings.ts";
import * as LastCodeLocalUpdates from "./LastCodeLocalUpdates.ts";
import { normalizeDesktopUpdateReleaseNotes } from "./releaseNotes.ts";
import { resolveDefaultDesktopUpdateChannel } from "./updateChannels.ts";
import {
  createInitialDesktopUpdateState,
  reduceDesktopUpdateStateOnCheckFailure,
  reduceDesktopUpdateStateOnCheckStart,
  reduceDesktopUpdateStateOnDownloadComplete,
  reduceDesktopUpdateStateOnDownloadFailure,
  reduceDesktopUpdateStateOnDownloadProgress,
  reduceDesktopUpdateStateOnDownloadStart,
  reduceDesktopUpdateStateOnInstallFailure,
  reduceDesktopUpdateStateOnLocalBuildFailure,
  reduceDesktopUpdateStateOnLocalBuildProgress,
  reduceDesktopUpdateStateOnLocalBuildStart,
  reduceDesktopUpdateStateOnNoUpdate,
  reduceDesktopUpdateStateOnUpdateAvailable,
} from "./updateMachine.ts";

const AUTO_UPDATE_STARTUP_DELAY = "15 seconds";
const AUTO_UPDATE_POLL_INTERVAL = "4 minutes";

const AppUpdateYmlConfig = Schema.Record(Schema.String, Schema.String);
type AppUpdateYmlConfig = typeof AppUpdateYmlConfig.Type;

const UpdateInfo = Schema.Struct({
  version: Schema.String,
  // Left unvalidated on purpose: a malformed release-notes payload must never
  // fail the decode and block the update state transition. The shape is
  // validated defensively in normalizeDesktopUpdateReleaseNotes.
  releaseNotes: Schema.optional(Schema.Unknown),
});

const DownloadProgressInfo = Schema.Struct({
  percent: Schema.Number,
});
const decodeAppUpdateYmlConfig = Schema.decodeUnknownEffect(AppUpdateYmlConfig);
const decodeUpdateInfo = Schema.decodeUnknownEffect(UpdateInfo);
const decodeDownloadProgressInfo = Schema.decodeUnknownEffect(DownloadProgressInfo);

const currentIsoTimestamp = DateTime.now.pipe(Effect.map(DateTime.formatIso));

export function mapLastCodeLocalReleaseNotes(
  inspection: Extract<
    LastCodeLocalUpdates.LastCodeLocalUpdateInspection,
    { readonly status: "available" }
  >,
): ReadonlyArray<DesktopUpdateReleaseNote> {
  const groups: DesktopUpdateReleaseNote[] = [];
  const lastCode = inspection.releaseNotes.lastCode;
  if (lastCode.status === "unavailable") {
    groups.push({
      version: inspection.availableVersion,
      heading: "LastCode changes",
      items: [],
      summaries: ["Couldn’t determine changes from this installed build."],
    });
  } else if (lastCode.items.length > 0) {
    groups.push({
      version: inspection.availableVersion,
      heading: "LastCode changes",
      items: lastCode.items,
      ...(lastCode.omittedItems > 0
        ? {
            summaries: [
              `…and ${lastCode.omittedItems} more LastCode ${lastCode.omittedItems === 1 ? "change" : "changes"}`,
            ],
          }
        : {}),
    });
  }

  const upstreamGroups = inspection.releaseNotes.upstream.groups.map(
    (group): DesktopUpdateReleaseNote => ({
      version: group.version,
      heading: group.isTarget ? "Upstream changes" : `Upstream changes in ${group.version}`,
      items: group.items,
      ...(group.omittedItems > 0
        ? {
            summaries: [
              `…and ${group.omittedItems} more ${group.omittedItems === 1 ? "change" : "changes"}`,
            ],
          }
        : {}),
    }),
  );
  const omittedGroups = inspection.releaseNotes.upstream.omittedGroups;
  if (omittedGroups > 0 && upstreamGroups.length > 0) {
    const index = upstreamGroups.length - 1;
    const oldest = upstreamGroups[index];
    if (oldest) {
      upstreamGroups[index] = {
        ...oldest,
        summaries: [
          ...(oldest.summaries ?? []),
          `${omittedGroups} older ${omittedGroups === 1 ? "nightly" : "nightlies"} not shown`,
        ],
      };
    }
  }
  return [...groups, ...upstreamGroups];
}

export class DesktopUpdateActionInProgressError extends Schema.TaggedErrorClass<DesktopUpdateActionInProgressError>()(
  "DesktopUpdateActionInProgressError",
  {
    action: Schema.Literals(["check", "download", "install"]),
    requestedChannel: DesktopUpdateChannelSchema,
  },
) {
  override get message(): string {
    return `Cannot change the desktop update channel to ${this.requestedChannel} while an update ${this.action} action is in progress.`;
  }
}

export class DesktopUpdateChannelPersistenceError extends Schema.TaggedErrorClass<DesktopUpdateChannelPersistenceError>()(
  "DesktopUpdateChannelPersistenceError",
  {
    channel: DesktopUpdateChannelSchema,
    cause: Schema.instanceOf(DesktopAppSettings.DesktopSettingsWriteError),
  },
) {
  override get message(): string {
    return `Failed to persist the ${this.channel} desktop update channel.`;
  }
}

export class DesktopUpdatePollerError extends Schema.TaggedErrorClass<DesktopUpdatePollerError>()(
  "DesktopUpdatePollerError",
  {
    poller: Schema.Literals(["startup", "poll"]),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Desktop update ${this.poller} poller failed.`;
  }
}

export class DesktopUpdateEventHandlingError extends Schema.TaggedErrorClass<DesktopUpdateEventHandlingError>()(
  "DesktopUpdateEventHandlingError",
  {
    event: Schema.Literals(["update-available", "download-progress", "update-downloaded"]),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to handle desktop update ${this.event} event.`;
  }
}

export class DesktopUpdaterReportedError extends Schema.TaggedErrorClass<DesktopUpdaterReportedError>()(
  "DesktopUpdaterReportedError",
  {
    operation: Schema.Literals(["check", "download", "install", "background"]),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Desktop updater ${this.operation} operation reported an error.`;
  }
}

export class DesktopUpdateUnexpectedActionError extends Schema.TaggedErrorClass<DesktopUpdateUnexpectedActionError>()(
  "DesktopUpdateUnexpectedActionError",
  {
    action: Schema.Literals(["download", "install"]),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Desktop update ${this.action} action failed unexpectedly.`;
  }
}

export type DesktopUpdateConfigureError = never;

export const DesktopUpdateSetChannelError = Schema.Union([
  DesktopUpdateActionInProgressError,
  DesktopUpdateChannelPersistenceError,
]);
export type DesktopUpdateSetChannelError = typeof DesktopUpdateSetChannelError.Type;
export const isDesktopUpdateSetChannelError = Schema.is(DesktopUpdateSetChannelError);

export class DesktopUpdates extends Context.Service<
  DesktopUpdates,
  {
    readonly getState: Effect.Effect<DesktopUpdateState>;
    readonly getLastCodeSettings: Effect.Effect<DesktopLastCodeSettingsState>;
    readonly setShowAndInstallLocalNightlies: (
      enabled: boolean,
    ) => Effect.Effect<DesktopLastCodeSettingsState, DesktopAppSettings.DesktopSettingsWriteError>;
    readonly emitState: Effect.Effect<void>;
    readonly disabledReason: Effect.Effect<Option.Option<string>>;
    readonly configure: Effect.Effect<void, DesktopUpdateConfigureError, Scope.Scope>;
    readonly setChannel: (
      channel: DesktopUpdateChannel,
    ) => Effect.Effect<DesktopUpdateState, DesktopUpdateSetChannelError>;
    readonly check: (reason: string) => Effect.Effect<DesktopUpdateCheckResult>;
    readonly download: Effect.Effect<DesktopUpdateActionResult>;
    readonly install: Effect.Effect<DesktopUpdateActionResult>;
  }
>()("@t3tools/desktop/updates/DesktopUpdates") {}

const {
  logInfo: logUpdaterInfo,
  logWarning: logUpdaterWarning,
  logError: logUpdaterError,
} = DesktopObservability.makeComponentLogger("desktop-updater");

function parseAppUpdateYml(raw: string): Effect.Effect<Option.Option<AppUpdateYmlConfig>> {
  const entries: Record<string, string> = {};
  for (const line of raw.split("\n")) {
    const match = line.match(/^(\w+):\s*(.+)$/);
    if (match?.[1] && match[2]) {
      entries[match[1]] = match[2].trim();
    }
  }

  return decodeAppUpdateYmlConfig(entries).pipe(
    Effect.map((config) => (config.provider ? Option.some(config) : Option.none())),
    Effect.orElseSucceed(() => Option.none<AppUpdateYmlConfig>()),
  );
}

function createBaseUpdateState(
  channel: DesktopUpdateChannel,
  enabled: boolean,
  environment: DesktopEnvironment.DesktopEnvironment["Service"],
  source: DesktopUpdateState["source"] = "hosted",
): DesktopUpdateState {
  return {
    ...createInitialDesktopUpdateState(environment.appVersion, environment.runtimeInfo, channel),
    enabled,
    source,
    status: enabled ? "idle" : "disabled",
  };
}

function getCanRetryFromState(state: DesktopUpdateState): boolean {
  return state.availableVersion !== null || state.downloadedVersion !== null;
}

function shouldBroadcastDownloadProgress(
  currentState: DesktopUpdateState,
  nextPercent: number,
): boolean {
  if (currentState.status !== "downloading") {
    return true;
  }

  const currentPercent = currentState.downloadPercent;
  if (currentPercent === null) {
    return true;
  }

  const previousStep = Math.floor(currentPercent / 10);
  const nextStep = Math.floor(nextPercent / 10);
  return nextStep !== previousStep || nextPercent === 100;
}

function getAutoUpdateDisabledReason(args: {
  isDevelopment: boolean;
  isPackaged: boolean;
  platform: NodeJS.Platform;
  appImage?: string | undefined;
  disabledByEnv: boolean;
  hasUpdateFeedConfig: boolean;
}): string | null {
  if (!args.hasUpdateFeedConfig) {
    return "Automatic updates are not available because no update feed is configured.";
  }
  if (args.isDevelopment || !args.isPackaged) {
    return "Automatic updates are only available in packaged production builds.";
  }
  if (args.disabledByEnv) {
    return "Automatic updates are disabled by the T3CODE_DISABLE_AUTO_UPDATE setting.";
  }
  if (args.platform === "linux" && !args.appImage) {
    return "Automatic updates on Linux require running the AppImage build.";
  }
  return null;
}

function isArm64HostRunningIntelBuild(runtimeInfo: DesktopRuntimeInfo): boolean {
  return runtimeInfo.hostArch === "arm64" && runtimeInfo.appArch === "x64";
}

export const make = Effect.gen(function* () {
  const config = yield* DesktopConfig.DesktopConfig;
  const pool = yield* DesktopBackendPool.DesktopBackendPool;
  const desktopState = yield* DesktopState.DesktopState;
  const electronApp = yield* ElectronApp.ElectronApp;
  const electronUpdater = yield* ElectronUpdater.ElectronUpdater;
  const electronWindow = yield* ElectronWindow.ElectronWindow;
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const fileSystem = yield* FileSystem.FileSystem;
  const desktopSettings = yield* DesktopAppSettings.DesktopAppSettings;
  const localUpdates = yield* LastCodeLocalUpdates.LastCodeLocalUpdates;

  const appUpdateYmlConfigRef = yield* Ref.make<Option.Option<AppUpdateYmlConfig>>(Option.none());
  const updateCheckInFlightRef = yield* Ref.make(false);
  const updateDownloadInFlightRef = yield* Ref.make(false);
  const updateInstallInFlightRef = yield* Ref.make(false);
  const updaterConfiguredRef = yield* Ref.make(false);
  const lastLoggedDownloadMilestoneRef = yield* Ref.make(-1);
  const localCheckpointTagRef = yield* Ref.make<Option.Option<string>>(Option.none());
  const localBuildRef = yield* Ref.make<
    Option.Option<{
      readonly build: LastCodeLocalUpdates.LastCodeLocalUpdateBuild;
      readonly version: string;
    }>
  >(Option.none());
  const checkTransitionMutex = yield* Semaphore.make(1);
  const updateStateRef = yield* Ref.make<DesktopUpdateState>(
    createInitialDesktopUpdateState(
      environment.appVersion,
      environment.runtimeInfo,
      environment.defaultDesktopSettings.updateChannel,
    ),
  );

  const emitState = Ref.get(updateStateRef).pipe(
    Effect.flatMap((state) => electronWindow.sendAll(IpcChannels.UPDATE_STATE_CHANNEL, state)),
  );

  const setState = (state: DesktopUpdateState): Effect.Effect<void> =>
    Ref.set(updateStateRef, state).pipe(Effect.andThen(emitState));

  const updateState = (
    f: (state: DesktopUpdateState) => DesktopUpdateState,
  ): Effect.Effect<DesktopUpdateState> =>
    Ref.get(updateStateRef).pipe(
      Effect.flatMap((state) => {
        const nextState = f(state);
        return setState(nextState).pipe(Effect.as(nextState));
      }),
    );

  const readAppUpdateYml = fileSystem.readFileString(environment.appUpdateYmlPath, "utf-8").pipe(
    Effect.option,
    Effect.flatMap(
      Option.match({
        onNone: () => Effect.succeed(Option.none<AppUpdateYmlConfig>()),
        onSome: parseAppUpdateYml,
      }),
    ),
  );

  const hasUpdateFeedConfig = Ref.get(appUpdateYmlConfigRef).pipe(
    Effect.map((appUpdateYmlConfig) => Option.isSome(appUpdateYmlConfig) || config.mockUpdates),
  );

  const applyHostedFeed = Effect.gen(function* () {
    if (config.mockUpdates) {
      yield* electronUpdater.setFeedURL({
        provider: "generic",
        url: `http://localhost:${config.mockUpdateServerPort}`,
      } as ElectronUpdater.ElectronUpdaterFeedUrl);
      return;
    }
    const appUpdateYmlConfig = yield* Ref.get(appUpdateYmlConfigRef);
    if (Option.isSome(appUpdateYmlConfig)) {
      yield* electronUpdater.setFeedURL(
        appUpdateYmlConfig.value as ElectronUpdater.ElectronUpdaterFeedUrl,
      );
    }
  });

  const resolveDisabledReason = Effect.gen(function* () {
    const settings = yield* desktopSettings.get;
    if (settings.showAndInstallLocalNightlies && localUpdates.supported) {
      return Option.none<string>();
    }
    const hasFeedConfig = yield* hasUpdateFeedConfig;
    return Option.fromNullishOr(
      getAutoUpdateDisabledReason({
        isDevelopment: environment.isDevelopment,
        isPackaged: environment.isPackaged,
        platform: environment.platform,
        appImage: Option.getOrUndefined(config.appImagePath),
        disabledByEnv: config.disableAutoUpdate,
        hasUpdateFeedConfig: hasFeedConfig,
      }),
    );
  });

  const resolveUpdaterErrorContext = Effect.gen(function* () {
    if (yield* Ref.get(updateInstallInFlightRef)) return "install" as const;
    if (yield* Ref.get(updateDownloadInFlightRef)) return "download" as const;
    if (yield* Ref.get(updateCheckInFlightRef)) return "check" as const;
    return (yield* Ref.get(updateStateRef)).errorContext;
  });

  const activeUpdateAction = Effect.gen(function* () {
    if (yield* Ref.get(updateInstallInFlightRef)) return Option.some("install" as const);
    if (yield* Ref.get(updateDownloadInFlightRef)) return Option.some("download" as const);
    if (yield* Ref.get(updateCheckInFlightRef)) return Option.some("check" as const);
    return Option.none<"check" | "download" | "install">();
  });

  const applyAutoUpdaterChannel = Effect.fn("desktop.updates.applyAutoUpdaterChannel")(function* (
    channel: DesktopUpdateChannel,
  ) {
    yield* Effect.annotateCurrentSpan({ channel });
    const allowsPrerelease = channel === "nightly";
    yield* electronUpdater.setChannel(channel);
    yield* electronUpdater.setAllowPrerelease(allowsPrerelease);
    yield* electronUpdater.setAllowDowngrade(allowsPrerelease);
    yield* electronUpdater.setFullChangelog(allowsPrerelease);
    yield* logUpdaterInfo("using update channel", {
      channel,
      allowPrerelease: allowsPrerelease,
      allowDowngrade: allowsPrerelease,
      fullChangelog: allowsPrerelease,
    });
  });

  const shouldEnableAutoUpdates = resolveDisabledReason.pipe(Effect.map(Option.isNone));

  const localNightliesUnsupportedMessage =
    "Local LastCode nightlies require a packaged macOS build running on Apple Silicon.";

  const makeLastCodeSettingsState = Effect.gen(function* () {
    const settings = yield* desktopSettings.get;
    const updateState = yield* Ref.get(updateStateRef);
    return {
      supported: localUpdates.supported,
      showAndInstallLocalNightlies: settings.showAndInstallLocalNightlies,
      message: !localUpdates.supported
        ? localNightliesUnsupportedMessage
        : updateState.source === "lastcode-local" && updateState.status === "error"
          ? updateState.message
          : null,
    } satisfies DesktopLastCodeSettingsState;
  });

  const checkForLocalUpdate = Effect.fn("desktop.updates.checkForLocalUpdate")(function* (
    reason: string,
  ) {
    yield* Effect.annotateCurrentSpan({ reason });
    const state = yield* Ref.get(updateStateRef);
    const checkedAt = yield* currentIsoTimestamp;
    yield* setState(reduceDesktopUpdateStateOnCheckStart(state, checkedAt));
    return yield* localUpdates.inspect(environment.appVersion).pipe(
      Effect.flatMap((inspection) => {
        if (inspection.status === "up-to-date") {
          return Ref.set(localCheckpointTagRef, Option.none()).pipe(
            Effect.andThen(setState(reduceDesktopUpdateStateOnNoUpdate(state, checkedAt))),
            Effect.as(true),
          );
        }
        const releaseNotes = mapLastCodeLocalReleaseNotes(inspection);
        return Ref.set(localCheckpointTagRef, Option.some(inspection.checkpointTag)).pipe(
          Effect.andThen(
            setState(
              reduceDesktopUpdateStateOnUpdateAvailable(
                state,
                inspection.availableVersion,
                checkedAt,
                releaseNotes,
              ),
            ),
          ),
          Effect.as(true),
        );
      }),
      Effect.catchTag("LastCodeLocalUpdateError", (error) =>
        setState(reduceDesktopUpdateStateOnCheckFailure(state, error.message, checkedAt)).pipe(
          Effect.as(true),
        ),
      ),
    );
  });

  const checkForUpdatesUnlocked = Effect.fn("desktop.updates.checkForUpdatesUnlocked")(function* (
    reason: string,
  ) {
    yield* Effect.annotateCurrentSpan({ reason });
    if (yield* Ref.get(desktopState.quitting)) return false;
    if (!(yield* Ref.get(updaterConfiguredRef))) return false;
    if (yield* Ref.get(updateCheckInFlightRef)) return false;

    const state = yield* Ref.get(updateStateRef);
    if (state.status === "downloading" || state.status === "downloaded") {
      yield* logUpdaterInfo("skipping update check while update is active", {
        reason,
        status: state.status,
      });
      return false;
    }

    if (state.source === "lastcode-local") {
      if (!state.enabled || !localUpdates.supported) return false;
      yield* Ref.set(updateCheckInFlightRef, true);
      return yield* checkForLocalUpdate(reason).pipe(
        Effect.ensuring(Ref.set(updateCheckInFlightRef, false)),
      );
    }

    yield* Ref.set(updateCheckInFlightRef, true);
    const checkedAt = yield* currentIsoTimestamp;
    yield* setState(reduceDesktopUpdateStateOnCheckStart(state, checkedAt));
    yield* logUpdaterInfo("checking for updates", { reason });

    return yield* electronUpdater.checkForUpdates.pipe(
      Effect.as(true),
      Effect.catchTags({
        ElectronUpdaterCheckForUpdatesError: Effect.fn(
          "desktop.updates.handleCheckForUpdatesFailure",
        )(function* (error) {
          const failedAt = yield* currentIsoTimestamp;
          yield* updateState((current) =>
            reduceDesktopUpdateStateOnCheckFailure(current, error.message, failedAt),
          );
          yield* logUpdaterError(error.message, {
            errorTag: error._tag,
            channel: error.channel,
          });
          return true;
        }),
      }),
      Effect.ensuring(Ref.set(updateCheckInFlightRef, false)),
    );
  });

  const checkForUpdates = Effect.fn("desktop.updates.checkForUpdates")((reason: string) =>
    checkTransitionMutex.withPermit(checkForUpdatesUnlocked(reason)),
  );

  const downloadAvailableUpdate = Effect.gen(function* () {
    const state = yield* Ref.get(updateStateRef);
    if (
      !(yield* Ref.get(updaterConfiguredRef)) ||
      (yield* Ref.get(updateDownloadInFlightRef)) ||
      state.status !== "available"
    ) {
      return { accepted: false, completed: false };
    }

    yield* Ref.set(updateDownloadInFlightRef, true);
    return yield* Effect.gen(function* () {
      if (state.source === "lastcode-local") {
        yield* Ref.set(localBuildRef, Option.none());
        const checkpointTag = yield* Ref.get(localCheckpointTagRef).pipe(
          Effect.flatMap(
            Option.match({
              onNone: () =>
                Effect.fail(
                  new LastCodeLocalUpdates.LastCodeLocalUpdateError({
                    operation: "build",
                    message: "The available LastCode update is no longer selected. Check again.",
                  }),
                ),
              onSome: Effect.succeed,
            }),
          ),
        );
        yield* setState(
          reduceDesktopUpdateStateOnLocalBuildStart(state, {
            checkpointTag,
            ...LastCodeLocalUpdates.initialLocalBuildProgress(),
          }),
        );
        yield* logUpdaterInfo("building local LastCode nightly", { checkpointTag });
        const build = yield* localUpdates.build(checkpointTag, (progress) =>
          updateState((current) =>
            reduceDesktopUpdateStateOnLocalBuildProgress(current, {
              checkpointTag,
              ...progress,
            }),
          ).pipe(Effect.asVoid),
        );
        const version = state.availableVersion;
        if (!version) {
          return yield* new LastCodeLocalUpdates.LastCodeLocalUpdateError({
            operation: "build",
            message: "The built LastCode update no longer has a selected version. Check again.",
          });
        }
        yield* Ref.set(localBuildRef, Option.some({ build, version }));
        yield* setState(reduceDesktopUpdateStateOnDownloadComplete(state, version));
        return { accepted: true, completed: true };
      }
      yield* setState(reduceDesktopUpdateStateOnDownloadStart(state, 0));
      yield* electronUpdater.setDisableDifferentialDownload(
        isArm64HostRunningIntelBuild(environment.runtimeInfo),
      );
      yield* logUpdaterInfo("downloading update");
      yield* electronUpdater.downloadUpdate;
      return { accepted: true, completed: true };
    }).pipe(
      Effect.catchTags({
        LastCodeLocalUpdateError: Effect.fn("desktop.updates.handleLocalBuildFailure")(
          function* (error) {
            yield* updateState((current) => {
              const checkpointTag = current.localBuildProgress?.checkpointTag ?? "unavailable";
              const progress = current.localBuildProgress ?? {
                checkpointTag,
                ...LastCodeLocalUpdates.initialLocalBuildProgress(),
              };
              const failure = {
                ...progress,
                currentVersion: current.currentVersion,
                targetVersion: current.availableVersion ?? current.currentVersion,
                logPath: localUpdates.buildLogPath,
                error: error.message.replaceAll("\0", "").slice(0, 32_000),
              } satisfies DesktopLocalBuildFailure;
              return reduceDesktopUpdateStateOnLocalBuildFailure(current, failure);
            });
            yield* logUpdaterError(error.message, {
              errorTag: error._tag,
              operation: error.operation,
            });
            return { accepted: true, completed: false };
          },
        ),
        ElectronUpdaterDownloadUpdateError: Effect.fn("desktop.updates.handleDownloadFailure")(
          function* (error) {
            yield* updateState((current) =>
              reduceDesktopUpdateStateOnDownloadFailure(current, error.message),
            );
            yield* logUpdaterError(error.message, {
              errorTag: error._tag,
              channel: error.channel,
            });
            return { accepted: true, completed: false };
          },
        ),
      }),
      Effect.onInterrupt(() =>
        updateState((current) => (current.status === "downloading" ? state : current)).pipe(
          Effect.asVoid,
        ),
      ),
      Effect.catchCause((cause) => {
        if (Cause.hasInterruptsOnly(cause)) {
          return Effect.failCause(cause);
        }
        const error = new DesktopUpdateUnexpectedActionError({ action: "download", cause });
        return Effect.gen(function* () {
          yield* updateState((current) => {
            if (state.source !== "lastcode-local") {
              return reduceDesktopUpdateStateOnDownloadFailure(current, error.message);
            }
            const checkpointTag = current.localBuildProgress?.checkpointTag ?? "unavailable";
            const progress = current.localBuildProgress ?? {
              checkpointTag,
              ...LastCodeLocalUpdates.initialLocalBuildProgress(),
            };
            return reduceDesktopUpdateStateOnLocalBuildFailure(current, {
              ...progress,
              currentVersion: current.currentVersion,
              targetVersion: current.availableVersion ?? current.currentVersion,
              logPath: localUpdates.buildLogPath,
              error: error.message,
            });
          });
          yield* logUpdaterError(error.message, {
            errorTag: error._tag,
            action: error.action,
          });
          return { accepted: true, completed: false };
        });
      }),
      Effect.ensuring(Ref.set(updateDownloadInFlightRef, false)),
    );
  }).pipe(Effect.withSpan("desktop.updates.downloadAvailableUpdate"));

  const resetInstallAction = Effect.all(
    [Ref.set(updateInstallInFlightRef, false), Ref.set(desktopState.quitting, false)],
    { discard: true },
  );

  const installDownloadedUpdate = Effect.gen(function* () {
    const state = yield* Ref.get(updateStateRef);
    if (
      (yield* Ref.get(desktopState.quitting)) ||
      (yield* Ref.get(updateInstallInFlightRef)) ||
      !(yield* Ref.get(updaterConfiguredRef)) ||
      state.status !== "downloaded"
    ) {
      return { accepted: false, completed: false };
    }

    yield* Ref.set(updateInstallInFlightRef, true);

    return yield* Effect.gen(function* () {
      if (state.source === "lastcode-local") {
        const selected = yield* Ref.get(localBuildRef).pipe(
          Effect.flatMap(
            Option.match({
              onNone: () =>
                Effect.fail(
                  new LastCodeLocalUpdates.LastCodeLocalUpdateError({
                    operation: "install",
                    message: "The built LastCode DMG is no longer selected. Build it again.",
                  }),
                ),
              onSome: Effect.succeed,
            }),
          ),
        );
        if (selected.version !== state.downloadedVersion) {
          return yield* new LastCodeLocalUpdates.LastCodeLocalUpdateError({
            operation: "install",
            message: "The selected LastCode DMG does not match the downloaded version.",
          });
        }
        return yield* Effect.acquireUseRelease(
          localUpdates.prepareInstall({
            dmgPath: selected.build.dmgPath,
            dmgSha256: selected.build.dmgSha256,
            expectedVersion: selected.version,
          }),
          (acceptedHandoff) =>
            Effect.gen(function* () {
              const instances = yield* pool.list;
              const instanceSnapshots = yield* Effect.forEach(
                instances,
                (instance) =>
                  instance.snapshot.pipe(Effect.map((snapshot) => ({ instance, snapshot }))),
                { concurrency: "unbounded" },
              );
              const previouslyRunningInstances = instanceSnapshots
                .filter(({ snapshot }) => snapshot.desiredRunning)
                .map(({ instance }) => instance);

              yield* Ref.set(desktopState.quitting, true);
              yield* Effect.gen(function* () {
                yield* Effect.forEach(
                  instances,
                  (instance) => instance.stop({ timeout: Duration.seconds(5) }),
                  { concurrency: "unbounded" },
                );
                yield* acceptedHandoff.commit;
              }).pipe(
                Effect.catchCause((cause) =>
                  acceptedHandoff.cancel.pipe(
                    Effect.andThen(
                      Effect.forEach(previouslyRunningInstances, (instance) => instance.start, {
                        concurrency: "unbounded",
                        discard: true,
                      }),
                    ),
                    Effect.andThen(Effect.failCause(cause)),
                  ),
                ),
              );
              yield* electronApp.quit;
              return { accepted: true, completed: false };
            }),
          (acceptedHandoff) => acceptedHandoff.cancel,
        );
      }

      yield* Ref.set(desktopState.quitting, true);
      // Stop every backend in the pool, not just the primary. With
      // parallel WSL + Windows backends, leaving the WSL instance up
      // means quitAndInstall's app.quit() exits before the pool's
      // scope cascade has a chance to run its stop finalizer, so the
      // WSL child gets hard-killed by the OS instead of receiving
      // SIGTERM + grace. Stops run concurrently with the same 5s
      // budget the primary had on its own.
      const instances = yield* pool.list;
      yield* Effect.forEach(
        instances,
        (instance) => instance.stop({ timeout: Duration.seconds(5) }),
        { concurrency: "unbounded" },
      );
      yield* electronWindow.destroyAll;
      yield* electronUpdater.quitAndInstall({
        isSilent: true,
        isForceRunAfter: true,
      });
      return { accepted: true, completed: false };
    }).pipe(
      Effect.catchTags({
        LastCodeLocalUpdateError: Effect.fn("desktop.updates.handleLocalInstallFailure")(
          function* (error) {
            yield* resetInstallAction;
            yield* updateState((current) =>
              reduceDesktopUpdateStateOnInstallFailure(current, error.message),
            );
            yield* logUpdaterError(error.message, {
              errorTag: error._tag,
              operation: error.operation,
            });
            return { accepted: true, completed: false };
          },
        ),
        ElectronUpdaterQuitAndInstallError: Effect.fn("desktop.updates.handleInstallFailure")(
          function* (error) {
            yield* resetInstallAction;
            yield* updateState((current) =>
              reduceDesktopUpdateStateOnInstallFailure(current, error.message),
            );
            yield* logUpdaterError(error.message, {
              errorTag: error._tag,
              channel: error.channel,
              isSilent: error.isSilent,
              isForceRunAfter: error.isForceRunAfter,
            });
            return { accepted: true, completed: false };
          },
        ),
      }),
      Effect.onInterrupt(() => resetInstallAction),
      Effect.catchCause((cause) =>
        Effect.gen(function* () {
          if (Cause.hasInterruptsOnly(cause)) {
            return yield* Effect.failCause(cause);
          }
          yield* resetInstallAction;
          const error = new DesktopUpdateUnexpectedActionError({ action: "install", cause });
          yield* updateState((current) =>
            reduceDesktopUpdateStateOnInstallFailure(current, error.message),
          );
          yield* logUpdaterError(error.message, {
            errorTag: error._tag,
            action: error.action,
          });
          return { accepted: true, completed: false };
        }),
      ),
    );
  }).pipe(Effect.withSpan("desktop.updates.installDownloadedUpdate"));

  const startUpdatePollers: Effect.Effect<void, never, Scope.Scope> = Effect.gen(function* () {
    yield* Effect.sleep(AUTO_UPDATE_STARTUP_DELAY).pipe(
      Effect.andThen(checkForUpdates("startup")),
      Effect.catchCause((cause) => {
        if (Cause.hasInterruptsOnly(cause)) {
          return Effect.void;
        }
        const error = new DesktopUpdatePollerError({ poller: "startup", cause });
        return logUpdaterError(error.message, {
          errorTag: error._tag,
          poller: error.poller,
        });
      }),
      Effect.forkScoped,
    );
    yield* Effect.sleep(AUTO_UPDATE_POLL_INTERVAL).pipe(
      Effect.andThen(checkForUpdates("poll")),
      Effect.forever,
      Effect.catchCause((cause) => {
        if (Cause.hasInterruptsOnly(cause)) {
          return Effect.void;
        }
        const error = new DesktopUpdatePollerError({ poller: "poll", cause });
        return logUpdaterError(error.message, {
          errorTag: error._tag,
          poller: error.poller,
        });
      }),
      Effect.forkScoped,
    );
  }).pipe(Effect.withSpan("desktop.updates.startPollers"));

  const handleUpdateAvailable = Effect.fn("desktop.updates.handleUpdateAvailable")(function* (
    raw: unknown,
  ) {
    yield* decodeUpdateInfo(raw).pipe(
      Effect.flatMap(
        Effect.fn("desktop.updates.applyUpdateAvailable")(function* (info) {
          const state = yield* Ref.get(updateStateRef);
          if (resolveDefaultDesktopUpdateChannel(info.version) !== state.channel) {
            yield* logUpdaterInfo("ignoring update that does not match selected channel", {
              version: info.version,
              channel: state.channel,
            });
            const checkedAt = yield* currentIsoTimestamp;
            yield* setState(reduceDesktopUpdateStateOnNoUpdate(state, checkedAt));
            yield* Ref.set(lastLoggedDownloadMilestoneRef, -1);
            return;
          }

          const checkedAt = yield* currentIsoTimestamp;
          const releaseNotes =
            state.source === "lastcode-local"
              ? state.releaseNotes
              : normalizeDesktopUpdateReleaseNotes(info.releaseNotes, info.version);
          if (state.source === "lastcode-local" && (yield* Ref.get(updateDownloadInFlightRef))) {
            yield* logUpdaterInfo("locally built update staged for download", {
              version: info.version,
            });
            return;
          }
          yield* setState(
            reduceDesktopUpdateStateOnUpdateAvailable(state, info.version, checkedAt, releaseNotes),
          );
          yield* Ref.set(lastLoggedDownloadMilestoneRef, -1);
          yield* logUpdaterInfo("update available", {
            version: info.version,
            releaseNoteGroups: releaseNotes.length,
          });
        }),
      ),
      Effect.catchCause((cause) => {
        if (Cause.hasInterruptsOnly(cause)) {
          return Effect.void;
        }
        const error = new DesktopUpdateEventHandlingError({ event: "update-available", cause });
        return logUpdaterWarning(error.message, {
          errorTag: error._tag,
          event: error.event,
        });
      }),
    );
  });

  const handleUpdateNotAvailable = Effect.gen(function* () {
    const checkedAt = yield* currentIsoTimestamp;
    const state = yield* Ref.get(updateStateRef);
    yield* setState(reduceDesktopUpdateStateOnNoUpdate(state, checkedAt));
    yield* Ref.set(lastLoggedDownloadMilestoneRef, -1);
    yield* logUpdaterInfo("no updates available");
  }).pipe(Effect.withSpan("desktop.updates.handleUpdateNotAvailable"));

  const handleUpdaterError = Effect.fn("desktop.updates.handleUpdaterError")(function* (
    cause: unknown,
  ) {
    const activeAction = yield* activeUpdateAction;
    const error = new DesktopUpdaterReportedError({
      operation: Option.getOrElse(activeAction, () => "background" as const),
      cause,
    });
    if (yield* Ref.get(updateInstallInFlightRef)) {
      yield* Ref.set(updateInstallInFlightRef, false);
      yield* Ref.set(desktopState.quitting, false);
      yield* updateState((current) =>
        reduceDesktopUpdateStateOnInstallFailure(current, error.message),
      );
      yield* logUpdaterError(error.message, {
        errorTag: error._tag,
        operation: error.operation,
      });
      return;
    }

    if (!(yield* Ref.get(updateCheckInFlightRef)) && !(yield* Ref.get(updateDownloadInFlightRef))) {
      const errorContext = yield* resolveUpdaterErrorContext;
      const checkedAt = yield* currentIsoTimestamp;
      yield* updateState((current) => ({
        ...current,
        status: "error",
        message: error.message,
        checkedAt,
        downloadPercent: null,
        errorContext,
        canRetry: getCanRetryFromState(current),
      }));
    }

    yield* logUpdaterError(error.message, {
      errorTag: error._tag,
      operation: error.operation,
    });
  });

  const handleDownloadProgress = Effect.fn("desktop.updates.handleDownloadProgress")(function* (
    raw: unknown,
  ) {
    yield* decodeDownloadProgressInfo(raw).pipe(
      Effect.flatMap(
        Effect.fn("desktop.updates.applyDownloadProgress")(function* (progress) {
          const state = yield* Ref.get(updateStateRef);
          const percent = Math.floor(progress.percent);
          if (shouldBroadcastDownloadProgress(state, progress.percent) || state.message !== null) {
            yield* setState(reduceDesktopUpdateStateOnDownloadProgress(state, progress.percent));
          }
          const milestone = percent - (percent % 10);
          const lastLoggedMilestone = yield* Ref.get(lastLoggedDownloadMilestoneRef);
          if (milestone > lastLoggedMilestone) {
            yield* Ref.set(lastLoggedDownloadMilestoneRef, milestone);
            yield* logUpdaterInfo("download progress", { percent });
          }
        }),
      ),
      Effect.catchCause((cause) => {
        if (Cause.hasInterruptsOnly(cause)) {
          return Effect.void;
        }
        const error = new DesktopUpdateEventHandlingError({ event: "download-progress", cause });
        return logUpdaterWarning(error.message, {
          errorTag: error._tag,
          event: error.event,
        });
      }),
    );
  });

  const handleUpdateDownloaded = Effect.fn("desktop.updates.handleUpdateDownloaded")(function* (
    raw: unknown,
  ) {
    yield* decodeUpdateInfo(raw).pipe(
      Effect.flatMap(
        Effect.fn("desktop.updates.applyUpdateDownloaded")(function* (info) {
          const state = yield* Ref.get(updateStateRef);
          yield* setState(reduceDesktopUpdateStateOnDownloadComplete(state, info.version));
          yield* logUpdaterInfo("update downloaded", { version: info.version });
        }),
      ),
      Effect.catchCause((cause) => {
        if (Cause.hasInterruptsOnly(cause)) {
          return Effect.void;
        }
        const error = new DesktopUpdateEventHandlingError({ event: "update-downloaded", cause });
        return logUpdaterWarning(error.message, {
          errorTag: error._tag,
          event: error.event,
        });
      }),
    );
  });

  return DesktopUpdates.of({
    getState: Ref.get(updateStateRef),
    getLastCodeSettings: makeLastCodeSettingsState,
    setShowAndInstallLocalNightlies: Effect.fn("desktop.updates.setShowAndInstallLocalNightlies")(
      (requestedEnabled: boolean) =>
        checkTransitionMutex.withPermit(
          Effect.gen(function* () {
            if (Option.isSome(yield* activeUpdateAction)) {
              return yield* makeLastCodeSettingsState;
            }
            const localEnabled = requestedEnabled && localUpdates.supported;
            const settings = (yield* desktopSettings.setShowAndInstallLocalNightlies(localEnabled))
              .settings;
            const hostedEnabled = yield* shouldEnableAutoUpdates;
            const source = localEnabled || !hostedEnabled ? "lastcode-local" : "hosted";
            const enabled = source === "lastcode-local" ? localEnabled : hostedEnabled;
            const channel = source === "lastcode-local" ? "nightly" : settings.updateChannel;
            yield* Ref.set(localCheckpointTagRef, Option.none());
            yield* setState(createBaseUpdateState(channel, enabled, environment, source));
            if (yield* Ref.get(updaterConfiguredRef)) {
              if (source === "hosted") {
                yield* applyHostedFeed;
              }
              yield* applyAutoUpdaterChannel(channel);
              yield* electronUpdater.setDisableDifferentialDownload(
                isArm64HostRunningIntelBuild(environment.runtimeInfo),
              );
            }
            if (enabled && (yield* Ref.get(updaterConfiguredRef))) {
              yield* checkForUpdatesUnlocked("local-nightlies-setting-change");
            }
            return yield* makeLastCodeSettingsState;
          }),
        ),
    ),
    emitState,
    disabledReason: resolveDisabledReason,
    configure: Effect.gen(function* () {
      const context = yield* Effect.context<never>();
      const runEffect = (effect: Effect.Effect<void>) => {
        void Effect.runPromiseWith(context)(effect);
      };

      const appUpdateYmlConfig = yield* readAppUpdateYml;
      yield* Ref.set(appUpdateYmlConfigRef, appUpdateYmlConfig);

      yield* applyHostedFeed;

      const settings = yield* desktopSettings.get;
      const hostedEnabled = yield* shouldEnableAutoUpdates;
      const localEnabled = settings.showAndInstallLocalNightlies && localUpdates.supported;
      const source = localEnabled || !hostedEnabled ? "lastcode-local" : "hosted";
      const enabled = source === "lastcode-local" ? localEnabled : hostedEnabled;
      yield* setState(
        createBaseUpdateState(
          source === "lastcode-local" ? "nightly" : settings.updateChannel,
          enabled,
          environment,
          source,
        ),
      );
      yield* Ref.set(updaterConfiguredRef, true);

      yield* electronUpdater.setAutoDownload(false);
      yield* electronUpdater.setAutoInstallOnAppQuit(false);
      yield* applyAutoUpdaterChannel(
        source === "lastcode-local" ? "nightly" : settings.updateChannel,
      );
      yield* electronUpdater.setDisableDifferentialDownload(
        isArm64HostRunningIntelBuild(environment.runtimeInfo),
      );

      if (isArm64HostRunningIntelBuild(environment.runtimeInfo)) {
        yield* logUpdaterInfo(
          "Apple Silicon host detected while running Intel build; updates will switch to arm64 packages",
        );
      }

      yield* electronUpdater.on("checking-for-update", () => {
        runEffect(
          logUpdaterInfo("looking for updates").pipe(
            Effect.withSpan("desktop.updates.handleCheckingForUpdate"),
          ),
        );
      });
      yield* electronUpdater.on("update-available", (info: unknown) => {
        runEffect(handleUpdateAvailable(info));
      });
      yield* electronUpdater.on("update-not-available", () => {
        runEffect(handleUpdateNotAvailable);
      });
      yield* electronUpdater.on("error", (error: unknown) => {
        runEffect(handleUpdaterError(error));
      });
      yield* electronUpdater.on("download-progress", (progress: unknown) => {
        runEffect(handleDownloadProgress(progress));
      });
      yield* electronUpdater.on("update-downloaded", (info: unknown) => {
        runEffect(handleUpdateDownloaded(info));
      });

      yield* startUpdatePollers;
      if (localEnabled) {
        yield* checkForUpdates("local-nightlies-enabled");
      }
    }).pipe(Effect.withSpan("desktop.updates.configure")),
    setChannel: Effect.fn("desktop.updates.setChannel")(function* (
      nextChannel: DesktopUpdateChannel,
    ) {
      yield* Effect.annotateCurrentSpan({ channel: nextChannel });
      const activeAction = yield* activeUpdateAction;
      if (Option.isSome(activeAction)) {
        return yield* new DesktopUpdateActionInProgressError({
          action: activeAction.value,
          requestedChannel: nextChannel,
        });
      }

      const state = yield* Ref.get(updateStateRef);
      if (state.source === "lastcode-local") {
        return state;
      }
      if (nextChannel === state.channel) {
        return state;
      }

      yield* desktopSettings
        .setUpdateChannel(nextChannel)
        .pipe(
          Effect.mapError(
            (cause) => new DesktopUpdateChannelPersistenceError({ channel: nextChannel, cause }),
          ),
        );

      const enabled = yield* shouldEnableAutoUpdates;
      yield* setState(createBaseUpdateState(nextChannel, enabled, environment));

      if (!enabled || !(yield* Ref.get(updaterConfiguredRef))) {
        return yield* Ref.get(updateStateRef);
      }

      yield* applyAutoUpdaterChannel(nextChannel);
      const allowDowngrade = yield* electronUpdater.allowDowngrade;
      yield* electronUpdater.setAllowDowngrade(true);
      yield* checkForUpdates("channel-change").pipe(
        Effect.ensuring(electronUpdater.setAllowDowngrade(allowDowngrade).pipe(Effect.ignore)),
      );
      return yield* Ref.get(updateStateRef);
    }),
    check: Effect.fn("desktop.updates.check")(function* (reason: string) {
      yield* Effect.annotateCurrentSpan({ reason });
      if (!(yield* Ref.get(updaterConfiguredRef))) {
        return {
          checked: false,
          state: yield* Ref.get(updateStateRef),
        };
      }
      const checked = yield* checkForUpdates(reason);
      return {
        checked,
        state: yield* Ref.get(updateStateRef),
      };
    }),
    download: Effect.gen(function* () {
      const result = yield* downloadAvailableUpdate;
      return {
        accepted: result.accepted,
        completed: result.completed,
        state: yield* Ref.get(updateStateRef),
      };
    }).pipe(Effect.withSpan("desktop.updates.download")),
    install: Effect.gen(function* () {
      if (yield* Ref.get(desktopState.quitting)) {
        return {
          accepted: false,
          completed: false,
          state: yield* Ref.get(updateStateRef),
        };
      }
      const result = yield* installDownloadedUpdate;
      return {
        accepted: result.accepted,
        completed: result.completed,
        state: yield* Ref.get(updateStateRef),
      };
    }).pipe(Effect.withSpan("desktop.updates.install")),
  });
});

export const layer = Layer.effect(DesktopUpdates, make);
