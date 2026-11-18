import { EnvironmentId } from "@t3tools/contracts";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import {
  readEnvironmentSupportsArchiveFamilies,
  readEnvironmentSupportsThreadAnnotations,
} from "./entities";

const serverState = vi.hoisted(() => ({
  configs: new Map<
    string,
    {
      environment: {
        capabilities: {
          threadArchiveFamilies: boolean;
          threadArchiveFamiliesV2?: boolean;
          threadAnnotations?: boolean;
          threadAnnotationHistory?: boolean;
        };
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

describe("readEnvironmentSupportsThreadAnnotations", () => {
  it.each([undefined, false, true])(
    "requires history-preserving support even on annotation-capable servers (%s)",
    (supported) => {
      const environmentId = EnvironmentId.make("annotation-server");
      serverState.configs.set(environmentId, {
        environment: {
          capabilities: {
            threadArchiveFamilies: true,
            threadAnnotations: true,
            ...(supported === undefined ? {} : { threadAnnotationHistory: supported }),
          },
        },
      });
      expect(readEnvironmentSupportsThreadAnnotations(environmentId)).toBe(supported === true);
    },
  );
});
