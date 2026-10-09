import { type DeviceHostId, type DeviceId, type ThreadId } from "@t3tools/contracts";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
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

interface Resource {
  readonly kind: "artifact" | "upload";
  readonly id: string;
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
    readonly authorize: (
      token: string,
      resource?: Resource,
    ) => Effect.Effect<Target, DeviceAgentAccessDenied>;
    readonly ownsResource: (target: Target, resource: Resource) => Effect.Effect<boolean>;
    readonly recordResource: (
      target: Target,
      resource: Resource,
    ) => Effect.Effect<void, DeviceAgentAccessDenied>;
  }
>()("t3/device/DeviceAgentAccess") {}

const make = Effect.gen(function* () {
  const threads = yield* ProjectionStore.ProjectionStoreV2;
  const crypto = yield* Crypto.Crypto;
  const consentContext = yield* Effect.context<
    ProjectStore.ProjectStoreV2 | ServerSettings.ServerSettingsService
  >();
  const credentials = new Map<string, Target>();
  const slots = new Map<string, string>();
  const credentialLock = yield* Semaphore.make(1);
  const targetKey = (target: Target) =>
    JSON.stringify([target.threadId, target.hostId, target.deviceId, target.session]);
  const discard = (target: Target) => {
    const key = targetKey(target);
    const token = slots.get(key);
    if (token !== undefined) credentials.delete(token);
    slots.delete(key);
  };
  // The pinned daemon only tracks tenants, not sessions. Keep session ownership
  // alongside the issued credentials; a server restart makes unknown IDs fail closed.
  const resources = new Map<string, string>();
  const owner = (target: Target) => JSON.stringify([target.threadId, target.session]);
  const resourceKey = (target: Target, resource: Resource) =>
    JSON.stringify([target.hostId, resource.kind, resource.id]);
  const owns = (target: Target, resource: Resource) =>
    resources.get(resourceKey(target, resource)) === owner(target);
  const allowed = (target: Target) =>
    currentThreadDeviceAccess(threads.getThreadShell(target.threadId)).pipe(
      Effect.provide(consentContext),
    );
  return DeviceAgentAccess.of({
    issue: Effect.fn("DeviceAgentAccess.issue")(function* (target) {
      if (!(yield* allowed(target))) {
        discard(target);
        return yield* new DeviceAgentAccessDenied({});
      }
      const key = targetKey(target);
      const existing = slots.get(key);
      // Reissuing a config must not invalidate commands already using it.
      if (existing !== undefined) return existing;
      const token = yield* crypto.randomUUIDv4.pipe(Effect.orDie);
      credentials.set(token, target);
      slots.set(key, token);
      return token;
    }, credentialLock.withPermit),
    authorize: Effect.fn("DeviceAgentAccess.authorize")(function* (token, resource) {
      const target = credentials.get(token);
      if (!target) return yield* new DeviceAgentAccessDenied({});
      if (!(yield* allowed(target))) {
        discard(target);
        return yield* new DeviceAgentAccessDenied({});
      }
      if (resource !== undefined && !owns(target, resource))
        return yield* new DeviceAgentAccessDenied({});
      return target;
    }, credentialLock.withPermit),
    ownsResource: (target, resource) => Effect.sync(() => owns(target, resource)),
    recordResource: (target, resource) =>
      Effect.gen(function* () {
        const key = resourceKey(target, resource);
        const previous = resources.get(key);
        if (previous !== undefined && previous !== owner(target))
          return yield* new DeviceAgentAccessDenied({});
        resources.set(key, owner(target));
      }),
  });
});

export const layer = Layer.effect(DeviceAgentAccess, make);
