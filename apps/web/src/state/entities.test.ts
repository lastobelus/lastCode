import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { readEnvironmentSupportsArchiveFamilies, resolveThreadDetailRef } from "./entities";

const serverState = vi.hoisted(() => ({
  configs: new Map<
    string,
    {
      environment: {
        capabilities: { threadArchiveFamilies: boolean; threadArchiveFamiliesV2?: boolean };
      };
    }
  >(),
}));
vi.mock("../rpc/atomRegistry", () => ({
  appAtomRegistry: { get: () => serverState.configs },
}));

beforeEach(() => serverState.configs.clear());

describe("readEnvironmentSupportsArchiveFamilies", () => {
  it.each([undefined, false, true])(
    "requires the current policy even when the original capability is present (V2=%s)",
    (supported) => {
      const environmentId = EnvironmentId.make("environment-1");
      serverState.configs.set(environmentId, {
        environment: {
          capabilities: {
            threadArchiveFamilies: true,
            ...(supported === undefined ? {} : { threadArchiveFamiliesV2: supported }),
          },
        },
      });
      expect(readEnvironmentSupportsArchiveFamilies(environmentId)).toBe(supported === true);
      expect(
        readEnvironmentSupportsArchiveFamilies(EnvironmentId.make("missing-environment")),
      ).toBe(false);
    },
  );
});

const threadRef = scopeThreadRef(EnvironmentId.make("environment-1"), ThreadId.make("thread-1"));

describe("resolveThreadDetailRef", () => {
  it("does not subscribe to a reserved draft thread before it enters the shell index", () => {
    expect(
      resolveThreadDetailRef(threadRef, {
        shellExists: false,
        waitForShell: true,
      }),
    ).toBeNull();
  });

  it("subscribes once the reserved draft thread enters the shell index", () => {
    expect(
      resolveThreadDetailRef(threadRef, {
        shellExists: true,
        waitForShell: true,
      }),
    ).toBe(threadRef);
  });

  it("keeps direct server-thread lookups enabled when the shell has not loaded it", () => {
    expect(
      resolveThreadDetailRef(threadRef, {
        shellExists: false,
        waitForShell: false,
      }),
    ).toBe(threadRef);
  });
});
