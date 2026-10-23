import { EnvironmentId, ThreadId, type ServerConfig } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/reactivity";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({
  config: vi.fn<() => ServerConfig | null>(),
  bootstrap: vi.fn(),
  createUrl: vi.fn(),
  bootstrapFamily: {},
  assetFamily: {},
}));
vi.mock("@react-navigation/native", () => ({ useNavigation: () => ({}) }));
vi.mock("../../state/entities", () => ({ useEnvironmentServerConfig: mocks.config }));
vi.mock("../../state/preview", () => ({ previewEnvironment: {} }));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => vi.fn() }));
vi.mock("../../state/assets", () => ({ assetEnvironment: { createUrl: mocks.assetFamily } }));
vi.mock("../../state/session", () => ({
  environmentSession: { bootstrap: mocks.bootstrapFamily },
}));
vi.mock("../../state/use-atom-query-runner", () => ({
  useAtomQueryRunner: (family: unknown) =>
    family === mocks.bootstrapFamily ? mocks.bootstrap : mocks.createUrl,
}));

import { prepareThenOpenThreadFeedUrl } from "../../lib/prepareThreadFeedPreview";
import {
  useCreateManagedPreviewResourceUrl,
  useRenewPreviewDocumentUrl,
} from "./useOpenManagedBrowserPreview";

const threadRef = {
  environmentId: EnvironmentId.make("remote-environment"),
  threadId: ThreadId.make("owning-thread"),
};
const url = "https://environment.example/api/assets/expired/report.html";
const input = {
  threadRef,
  url,
  environmentUrl: "https://environment.example/",
  list: vi.fn(async () => []),
  recover: vi.fn(async () => null),
};
const config = (supported?: boolean) =>
  ({
    environment: {
      capabilities: supported === undefined ? {} : { previewAssetRecovery: supported },
    },
  }) as ServerConfig;

beforeEach(() => {
  vi.resetAllMocks();
  mocks.config.mockReturnValue(null);
  mocks.createUrl.mockResolvedValue(
    AsyncResult.success({ relativeUrl: "/api/assets/renewed/report.html" }),
  );
});

describe("mobile preview asset recovery", () => {
  it.each([true, undefined])(
    "waits on the first click before choosing renewal: %s",
    async (supported) => {
      let ready!: (value: unknown) => void;
      mocks.bootstrap.mockImplementation(
        () =>
          new Promise((resolve) => {
            ready = resolve;
          }),
      );
      const open = vi.fn((url: string) => url);
      const pending = prepareThenOpenThreadFeedUrl(
        {
          ...input,
          renewDocumentUrl: useRenewPreviewDocumentUrl(threadRef),
        },
        open,
      );
      expect(open).not.toHaveBeenCalled();
      expect(mocks.createUrl).not.toHaveBeenCalled();
      ready(AsyncResult.success({ config: config(supported) }));
      await expect(pending).resolves.toBe(
        supported ? "https://environment.example/api/assets/renewed/report.html" : url,
      );
      expect(open).toHaveBeenCalledTimes(1);
      expect(mocks.bootstrap).toHaveBeenCalledExactlyOnceWith({
        environmentId: threadRef.environmentId,
        input: undefined,
      });
      expect(mocks.createUrl).toHaveBeenCalledTimes(supported ? 1 : 0);
      if (supported)
        expect(mocks.createUrl).toHaveBeenCalledWith({
          environmentId: threadRef.environmentId,
          input: {
            resource: {
              _tag: "preview-document",
              threadId: threadRef.threadId,
              url,
              refresh: true,
            },
          },
        });
    },
  );

  it.each(["readiness", "renewal"])(
    "does not open an expired link after %s fails",
    async (stage) => {
      const failure = AsyncResult.failure(Cause.fail(new Error("Asset unavailable")));
      mocks.bootstrap.mockResolvedValue(
        stage === "readiness" ? failure : AsyncResult.success({ config: config(true) }),
      );
      mocks.createUrl.mockResolvedValue(failure);
      const open = vi.fn();
      await expect(
        prepareThenOpenThreadFeedUrl(
          {
            ...input,
            renewDocumentUrl: useRenewPreviewDocumentUrl(threadRef),
          },
          open,
        ),
      ).rejects.toThrow("The saved preview could not be started.");
      expect(open).not.toHaveBeenCalled();
      expect(mocks.createUrl).toHaveBeenCalledTimes(stage === "readiness" ? 0 : 1);
    },
  );

  it("preserves a known old-host link without bootstrapping or sending an asset operation", async () => {
    mocks.config.mockReturnValue(config());
    const open = vi.fn((url: string) => url);
    await expect(
      prepareThenOpenThreadFeedUrl(
        {
          ...input,
          renewDocumentUrl: useRenewPreviewDocumentUrl(threadRef),
        },
        open,
      ),
    ).resolves.toBe(url);
    expect(mocks.bootstrap).not.toHaveBeenCalled();
    expect(mocks.createUrl).not.toHaveBeenCalled();
  });

  it.each([true, undefined])(
    "gates managed resources and retains their authenticated owner: %s",
    async (supported) => {
      mocks.bootstrap.mockResolvedValue(AsyncResult.success({ config: config(supported) }));
      const lease = {
        leaseId: "owned-lease",
        threadId: threadRef.threadId,
        url: "http://localhost:5173/image.png",
        handedOffAt: "2026-10-01T00:00:00.000Z",
        expiresAt: "2026-10-02T00:00:00.000Z",
        status: "active" as const,
      };
      const open = vi.fn((url: string) => url);
      await expect(
        prepareThenOpenThreadFeedUrl(
          {
            ...input,
            url: lease.url,
            purpose: "resource",
            list: async () => [lease],
            recover: async () => lease,
            createResourceUrl: useCreateManagedPreviewResourceUrl(threadRef),
          },
          open,
        ),
      ).resolves.toBe(
        supported ? "https://environment.example/api/assets/renewed/report.html" : lease.url,
      );
      expect(mocks.createUrl).toHaveBeenCalledTimes(supported ? 1 : 0);
      if (supported)
        expect(mocks.createUrl).toHaveBeenCalledWith({
          environmentId: threadRef.environmentId,
          input: {
            resource: {
              _tag: "managed-preview-resource",
              threadId: threadRef.threadId,
              leaseId: lease.leaseId,
              url: lease.url,
            },
          },
        });
    },
  );
});
