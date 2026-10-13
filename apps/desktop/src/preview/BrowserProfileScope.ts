import {
  DEFAULT_BROWSER_PROFILE_ID,
  EnvironmentId,
  INCOGNITO_BROWSER_PROFILE_ID,
} from "@t3tools/contracts";
import { fetchRemoteEnvironmentDescriptor } from "@t3tools/client-runtime/environment";
import { LASTCODE_DESKTOP_DISTRIBUTION } from "@t3tools/shared/desktopDistribution";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as DesktopBackendPool from "../backend/DesktopBackendPool.ts";
import * as DesktopAppSettings from "../settings/DesktopAppSettings.ts";
import * as DesktopWslEnvironment from "../wsl/DesktopWslEnvironment.ts";
import { resolveWslPickFolderDefaultPath } from "../wsl/wslPathParsing.ts";

export class BrowserProfileScopeError extends Schema.TaggedError<BrowserProfileScopeError>()(
  "BrowserProfileScopeError",
  { cause: Schema.Defect() },
) {
  override get message(): string {
    return "The desktop browser profile identity could not be resolved. Existing browser sessions were not changed.";
  }
}

/** Named profiles retain their primary partition across destination environments. */
export function resolvePartitionScope(
  environmentId: string,
  profileId: string | undefined,
  primaryEnvironmentId: string,
): { readonly scope: string; readonly persistent: boolean; readonly namespace?: "profile" } {
  if (profileId === undefined || profileId === DEFAULT_BROWSER_PROFILE_ID)
    return { scope: environmentId, persistent: true };
  return {
    scope: JSON.stringify([
      profileId === INCOGNITO_BROWSER_PROFILE_ID ? environmentId : primaryEnvironmentId,
      profileId,
    ]),
    persistent: profileId !== INCOGNITO_BROWSER_PROFILE_ID,
    namespace: "profile",
  };
}

const decodeEnvironmentId = Schema.decodeUnknownEffect(EnvironmentId);
const readIdentity = Effect.fn("desktop.preview.readProfileIdentity")(function* (
  identityPath: string,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const raw = yield* fileSystem.readFileString(identityPath).pipe(
    Effect.map(Option.some),
    Effect.catchIf(
      (error) => error.reason._tag === "NotFound",
      () => Effect.succeed(Option.none<string>()),
    ),
  );
  if (Option.isNone(raw)) return Option.none<EnvironmentId>();
  return Option.some(yield* decodeEnvironmentId(raw.value.trim()));
});

const historicalPrimaryIdentity = Effect.fn("desktop.preview.historicalPrimaryIdentity")(
  function* () {
    const environment = yield* DesktopEnvironment.DesktopEnvironment;
    const settings = yield* (yield* DesktopAppSettings.DesktopAppSettings).get;
    const path = yield* Path.Path;
    if (environment.platform !== "win32" || !settings.wslOnly || !settings.wslBackendEnabled)
      return yield* readIdentity(path.join(environment.stateDir, "environment-id"));

    // WSL primaries never write the native identity. Read only the selected
    // distro's historical state so an old Windows login cannot replace it.
    const wsl = yield* DesktopWslEnvironment.DesktopWslEnvironment;
    const distros = yield* wsl.probeDistros;
    const distro = settings.wslDistro ?? distros.find((entry) => entry.isDefault)?.name;
    if (!distro || !distros.some((entry) => entry.name === distro))
      return yield* new BrowserProfileScopeError({
        cause: "The primary WSL distro is unavailable.",
      });
    const home = yield* wsl.getUserHome(distro);
    if (Option.isNone(home))
      return yield* new BrowserProfileScopeError({ cause: "The primary WSL home is unavailable." });
    const identityPath = resolveWslPickFolderDefaultPath(
      {
        initialPath: `${home.value}/${LASTCODE_DESKTOP_DISTRIBUTION.defaultHomeDirName}/${environment.isDevelopment ? "dev" : "userdata"}/environment-id`,
      },
      { distro },
      distros,
      home.value,
    );
    if (identityPath === null)
      return yield* new BrowserProfileScopeError({
        cause: "The primary WSL identity path is unavailable.",
      });
    return yield* readIdentity(identityPath);
  },
);

const profileIdentity = Effect.fn("desktop.preview.profileIdentity")(function* () {
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const anchorPath = path.join(environment.stateDir, "browser-profile-environment-id");
  const anchor = yield* readIdentity(anchorPath);
  if (Option.isSome(anchor)) return anchor.value;

  const primary = yield* (yield* DesktopBackendPool.DesktopBackendPool).primary;
  const config = yield* primary.currentConfig;
  const snapshot = yield* primary.snapshot;
  const descriptor =
    snapshot.ready && Option.isSome(config)
      ? yield* fetchRemoteEnvironmentDescriptor({
          httpBaseUrl: config.value.httpBaseUrl.href,
        }).pipe(Effect.option)
      : Option.none();
  const historical = Option.isSome(descriptor)
    ? Option.some(descriptor.value.environmentId)
    : yield* historicalPrimaryIdentity();
  const settings = yield* (yield* DesktopAppSettings.DesktopAppSettings).get;
  if (Option.isNone(historical) && settings.localEnvironmentEnabled)
    return yield* new BrowserProfileScopeError({ cause: "The primary environment is not ready." });
  const identity = Option.isSome(historical)
    ? historical.value
    : EnvironmentId.make(yield* (yield* Crypto.Crypto).randomUUIDv4);

  // Publish a complete anchor once. Simultaneous first tabs read the same
  // winner, including on a fresh remote-only desktop that generated an ID.
  yield* fileSystem.makeDirectory(environment.stateDir, { recursive: true });
  yield* Effect.scoped(
    Effect.gen(function* () {
      const temporary = yield* fileSystem.makeTempFileScoped({
        directory: environment.stateDir,
        prefix: ".browser-profile-environment-id-",
      });
      yield* fileSystem.writeFileString(temporary, `${identity}\n`);
      yield* fileSystem.link(temporary, anchorPath).pipe(
        Effect.catchIf(
          (error) => error.reason._tag === "AlreadyExists",
          () => Effect.void,
        ),
      );
    }),
  );
  const winner = yield* readIdentity(anchorPath);
  if (Option.isNone(winner))
    return yield* new BrowserProfileScopeError({
      cause: "The browser profile identity was not persisted.",
    });
  return winner.value;
});

export const browserProfileScope = Effect.fn("desktop.preview.browserProfileScope")(function* (
  environmentId: string,
  profileId: string | undefined,
) {
  if (
    profileId === undefined ||
    profileId === DEFAULT_BROWSER_PROFILE_ID ||
    profileId === INCOGNITO_BROWSER_PROFILE_ID
  )
    return resolvePartitionScope(environmentId, profileId, environmentId);
  const identity = yield* profileIdentity().pipe(
    Effect.mapError((cause) => new BrowserProfileScopeError({ cause })),
  );
  return resolvePartitionScope(environmentId, profileId, identity);
});
