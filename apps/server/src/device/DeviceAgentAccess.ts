import { type DeviceHostId, type DeviceId, type ThreadId } from "@t3tools/contracts";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ServerSettings from "../serverSettings.ts";

export const AGENT_DEVICE_ROUTE_PREFIX = "/api/agent-device";

/** Shared consent check; callers supply their existing thread reader. */
export const currentThreadDeviceAccess = <E>(
  thread: Effect.Effect<
    {
      readonly projectId: import("@t3tools/contracts").ProjectId;
      readonly deletedAt: import("effect/DateTime").Utc | null;
    } | null,
    E
  >,
) =>
  Effect.gen(function* () {
    const projects = yield* ProjectStore.ProjectStoreV2;
    const settings = yield* ServerSettings.ServerSettingsService;
    const current = yield* thread;
    if (current === null || current.deletedAt !== null) return false;
    const project = yield* projects.get(current.projectId);
    if (Option.isNone(project) || project.value.deletedAt !== null) return false;
    const value = yield* settings.getSettings;
    return (
      value.enableDeviceSupport &&
      resolveProjectSettings(value, current.projectId).settings.enableAgentDeviceAccess
    );
  }).pipe(Effect.orElseSucceed(() => false));

export class DeviceAgentAccessDenied extends Schema.TaggedError<DeviceAgentAccessDenied>()(
  "DeviceAgentAccessDenied",
  {},
) {
  override get message() {
    return "Device access is not authorized for this thread.";
  }
}

interface Target {
  readonly threadId: ThreadId;
  readonly hostId: DeviceHostId;
  readonly deviceId: DeviceId;
  readonly session: string;
}

export class DeviceAgentAccess extends Context.Service<
  DeviceAgentAccess,
  {
    readonly issue: (target: Target) => Effect.Effect<string, DeviceAgentAccessDenied>;
    readonly authorize: (token: string) => Effect.Effect<Target, DeviceAgentAccessDenied>;
  }
>()("t3/device/DeviceAgentAccess") {}

const make = Effect.gen(function* () {
  const threads = yield* ProjectionStore.ProjectionStoreV2;
  const crypto = yield* Crypto.Crypto;
  const consentContext = yield* Effect.context<
    ProjectStore.ProjectStoreV2 | ServerSettings.ServerSettingsService
  >();
  const credentials = new Map<string, Target>();
  const allowed = (target: Target) =>
    currentThreadDeviceAccess(threads.getThreadShell(target.threadId)).pipe(
      Effect.provide(consentContext),
    );
  return DeviceAgentAccess.of({
    issue: Effect.fn("DeviceAgentAccess.issue")(function* (target) {
      if (!(yield* allowed(target))) return yield* new DeviceAgentAccessDenied({});
      const token = yield* crypto.randomUUIDv4.pipe(Effect.orDie);
      credentials.set(token, target);
      return token;
    }),
    authorize: Effect.fn("DeviceAgentAccess.authorize")(function* (token) {
      const target = credentials.get(token);
      if (!target || !(yield* allowed(target))) return yield* new DeviceAgentAccessDenied({});
      return target;
    }),
  });
});

export const layer = Layer.effect(DeviceAgentAccess, make);
