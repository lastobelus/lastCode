import {
  EnvironmentId,
  PreviewHostingLeaseId,
  ThreadId,
  type PreviewHostingLeaseSummary,
} from "@t3tools/contracts";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import * as Option from "effect/Option";
import {
  BearerConnectionTarget,
  RelayConnectionTarget,
  PrimaryConnectionTarget,
  type PreparedConnection,
} from "./connection/model.ts";
import { BearerConnectionProfile, type ConnectionCatalogEntry } from "./connection/catalog.ts";
import {
  configuredPreviewEnvironmentUrl,
  HostedPreviewUrlTooLongError,
  prepareHostedPreview,
  selectHostedPreview,
} from "./previewHosting.ts";

const threadRef = {
  environmentId: EnvironmentId.make("environment-preview"),
  threadId: ThreadId.make("thread-preview"),
};
const lease = {
  leaseId: PreviewHostingLeaseId.make("lease-preview"),
  threadId: threadRef.threadId,
  url: "http://localhost:5173/preview/index.html?theme=dark#top",
  handedOffAt: "2026-10-02T00:00:00.000Z",
  expiresAt: "2026-10-03T00:00:00.000Z",
  status: "active" as const,
};

describe("prepareHostedPreview", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("restores an owning local lease and preserves the requested URL components", async () => {
    const recover = vi.fn(async () => lease);
    const result = await prepareHostedPreview({
      threadRef,
      url: "http://127.0.0.1:5173/preview/index.html?theme=dark#top",
      environmentUrl: "http://localhost:8080/",
      list: async () => [lease],
      recover,
    });

    expect(result).toEqual({
      url: "http://localhost:5173/preview/index.html?theme=dark#top",
      managed: true,
      restored: true,
    });
    expect(recover).toHaveBeenCalledWith(lease);
  });

  it("uses a private environment address for loopback links without changing path or query", async () => {
    const result = await prepareHostedPreview({
      threadRef,
      url: "http://localhost:5173/preview?q=1#section",
      environmentUrl: "https://192.168.1.30:8443/",
      list: async () => [lease],
      recover: async () => lease,
    });

    expect(result).toEqual({
      url: "http://192.168.1.30:5173/preview?q=1#section",
      managed: true,
      restored: true,
    });
  });

  it("recovers a saved private-address URL through the owning lease and current private host", async () => {
    const savedUrl = "http://192.168.1.24:5173/preview/index.html?theme=dark#top";
    const savedLease = { ...lease, url: "http://localhost:5173/preview/index.html?theme=dark#top" };
    const recover = vi.fn(async () => savedLease);

    const result = await prepareHostedPreview({
      threadRef,
      url: savedUrl,
      environmentUrl: "https://100.100.12.4:8443/",
      knownEnvironmentUrls: ["http://192.168.1.24:8080/"],
      list: async () => [savedLease],
      recover,
    });

    expect(result).toEqual({
      url: "http://100.100.12.4:5173/preview/index.html?theme=dark#top",
      managed: true,
      restored: true,
    });
    expect(recover).toHaveBeenCalledWith(savedLease);
  });

  it("does not adopt an unrelated private address even with an exact owning lease", async () => {
    const url = "http://10.8.0.42:5173/preview/index.html?theme=dark#top";
    const recover = vi.fn(async () => lease);

    const result = await prepareHostedPreview({
      threadRef,
      url,
      environmentUrl: "https://100.100.12.4:8443/",
      list: async () => [lease],
      recover,
    });

    expect(result).toEqual({ url, managed: false, restored: false });
    expect(recover).not.toHaveBeenCalled();
  });

  it("does not adopt a private URL by port alone when the saved path differs", async () => {
    const url = "http://10.8.0.42:5173/another-app?theme=dark";
    const recover = vi.fn(async () => lease);

    const result = await prepareHostedPreview({
      threadRef,
      url,
      environmentUrl: "https://100.100.12.4:8443/",
      list: async () => [lease],
      recover,
    });

    expect(result).toEqual({ url, managed: false, restored: false });
    expect(recover).not.toHaveBeenCalled();
  });

  it("keeps a loopback URL unchanged when the environment requires an unavailable public gateway", async () => {
    const result = await prepareHostedPreview({
      threadRef,
      url: "http://localhost:5173/preview?q=1#section",
      environmentUrl: "https://server.example.com/",
      list: async () => [lease],
      recover: async () => null,
    });

    expect(result).toEqual({
      url: "http://localhost:5173/preview?q=1#section",
      managed: true,
      restored: false,
    });
  });

  it("does not list for public links or another thread's lease", async () => {
    const list = vi.fn(async () => [lease]);
    const publicLink = await prepareHostedPreview({
      threadRef,
      url: "https://public.example/",
      environmentUrl: "http://localhost:8080/",
      list,
      recover: async () => lease,
    });
    const wrongOwner = await prepareHostedPreview({
      threadRef,
      url: lease.url,
      environmentUrl: "http://localhost:8080/",
      list: async () => [{ ...lease, threadId: ThreadId.make("other-thread") }],
      recover: async () => lease,
    });

    expect(publicLink).toEqual({ url: "https://public.example/", managed: false, restored: false });
    expect(wrongOwner).toEqual({ url: lease.url, managed: false, restored: false });
    expect(list).not.toHaveBeenCalled();
  });

  it("falls back to the exact input URL when listing or recovery fails", async () => {
    const url = "http://localhost:5173/preview?x=%2f#part";
    const failedList = await prepareHostedPreview({
      threadRef,
      url,
      environmentUrl: "http://localhost:8080/",
      list: async () => {
        throw new Error("offline");
      },
      recover: async () => lease,
    });
    const failedRecovery = await prepareHostedPreview({
      threadRef,
      url,
      environmentUrl: "http://localhost:8080/",
      list: async () => [lease],
      recover: async () => {
        throw new Error("recovery failed");
      },
    });

    expect(failedList).toEqual({ url, managed: false, restored: false });
    expect(failedRecovery).toEqual({
      url: "http://localhost:5173/preview?x=%2f#part",
      managed: true,
      restored: false,
    });
  });

  it("coalesces concurrent preparation for the same scoped URL", async () => {
    let finishList!: (leases: (typeof lease)[]) => void;
    let listStarted!: () => void;
    const started = new Promise<void>((resolve) => (listStarted = resolve));
    const list = vi.fn(() => {
      listStarted();
      return new Promise<(typeof lease)[]>((resolve) => (finishList = resolve));
    });
    const input = {
      threadRef,
      url: lease.url,
      environmentUrl: "http://localhost:8080/",
      list,
      recover: vi.fn(async () => lease),
    };
    const first = prepareHostedPreview(input);
    const second = prepareHostedPreview(input);

    expect(second).toBe(first);
    await started;
    finishList([lease]);
    expect(await first).toMatchObject({ managed: true, restored: true });
    expect(list).toHaveBeenCalledTimes(1);
    expect(input.recover).toHaveBeenCalledTimes(1);
  });
  it("shares one listing and recovery across different assets while retaining each URL", async () => {
    let finishList!: (leases: (typeof lease)[]) => void;
    let listStarted!: () => void;
    const listed = new Promise<void>((resolve) => (listStarted = resolve));
    let finishRecovery!: (value: typeof lease) => void;
    let recoveryStarted!: () => void;
    const recovering = new Promise<void>((resolve) => (recoveryStarted = resolve));
    const list = vi.fn(() => {
      listStarted();
      return new Promise<(typeof lease)[]>((resolve) => (finishList = resolve));
    });
    const recover = vi.fn(() => {
      recoveryStarted();
      return new Promise<typeof lease>((resolve) => (finishRecovery = resolve));
    });
    const input = { threadRef, environmentUrl: "http://192.168.1.30:8080/", list, recover };
    const urls = ["/a.png?run=1#first", "/b.png", "/c.mp4"];
    const preparations = urls.map((path) =>
      prepareHostedPreview({ ...input, url: `http://localhost:5173${path}` }),
    );
    await listed;
    expect(list).toHaveBeenCalledTimes(1);
    finishList([lease]);
    await recovering;
    expect(recover).toHaveBeenCalledTimes(1);
    finishRecovery(lease);
    expect(await Promise.all(preparations)).toEqual(
      urls.map((path) => ({
        url: `http://192.168.1.30:5173${path}`,
        managed: true,
        restored: true,
      })),
    );
    const laterRecover = vi.fn(async () => lease);
    await prepareHostedPreview({
      ...input,
      url: "http://localhost:5173/a.png",
      list: async () => [lease],
      recover: laterRecover,
    });
    expect(laterRecover).toHaveBeenCalledTimes(1);
  });

  it("keeps recovery separate for other owners, environments, and leases", async () => {
    const otherThread = ThreadId.make("other-preview-thread");
    const secondLease = {
      ...lease,
      leaseId: PreviewHostingLeaseId.make("second-lease"),
      url: "http://localhost:5174/",
    };
    const list = vi.fn(async () => [lease, secondLease]);
    const recover = vi.fn(async (owned: PreviewHostingLeaseSummary) => owned);
    const input = { threadRef, environmentUrl: "http://localhost:8080/", list, recover };
    const result = await Promise.all([
      prepareHostedPreview({ ...input, url: "http://localhost:5173/a.png" }),
      prepareHostedPreview({ ...input, url: "http://localhost:5174/b.png" }),
      prepareHostedPreview({
        ...input,
        threadRef: { ...threadRef, threadId: otherThread },
        url: "http://localhost:5173/c.png",
      }),
      prepareHostedPreview({
        ...input,
        threadRef: { ...threadRef, environmentId: EnvironmentId.make("other-environment") },
        url: "http://localhost:5173/d.png",
      }),
    ]);
    expect(list).toHaveBeenCalledTimes(3);
    expect(recover).toHaveBeenCalledTimes(3);
    expect(result.map((value) => value.managed)).toEqual([true, true, false, true]);
  });
});

describe("selectHostedPreview", () => {
  it("prefers an exact path and query when several candidates share a port", () => {
    const another = {
      ...lease,
      leaseId: PreviewHostingLeaseId.make("lease-another"),
      url: "http://localhost:5173/other",
    };
    expect(
      selectHostedPreview(new URL("http://127.0.0.1:5173/preview/index.html?theme=dark"), [
        another,
        lease,
      ]),
    ).toEqual(lease);
  });

  it("refuses to guess when multiple candidates match no requested path", () => {
    const another = {
      ...lease,
      leaseId: PreviewHostingLeaseId.make("lease-another"),
      url: "http://localhost:5173/other",
    };
    expect(
      selectHostedPreview(new URL("http://localhost:5173/unknown"), [lease, another]),
    ).toBeNull();
  });
});

describe("configured preview endpoints", () => {
  const target = new BearerConnectionTarget({
    environmentId: threadRef.environmentId,
    label: "Remote environment",
    connectionId: "saved-connection",
  });
  const connection: PreparedConnection = {
    environmentId: threadRef.environmentId,
    label: target.label,
    httpBaseUrl: "http://100.100.12.4:3773/",
    socketUrl: "ws://100.100.12.4:3773/ws",
    httpAuthorization: null,
    target,
  };
  const entry: ConnectionCatalogEntry = {
    target,
    enabled: true,
    profile: Option.some(
      new BearerConnectionProfile({
        environmentId: threadRef.environmentId,
        connectionId: target.connectionId,
        label: target.label,
        httpBaseUrl: "http://192.168.1.24:3773/",
        wsBaseUrl: "ws://192.168.1.24:3773/ws",
      }),
    ),
  };
  it("retains a bearer profile endpoint alongside the resolved transport address", () => {
    expect(configuredPreviewEnvironmentUrl(connection, entry)).toBe("http://192.168.1.24:3773/");
  });
  it("refuses profiles belonging to other environments or connections", () => {
    expect(
      configuredPreviewEnvironmentUrl(connection, {
        ...entry,
        target: new BearerConnectionTarget({
          ...target,
          environmentId: EnvironmentId.make("other-environment"),
        }),
      }),
    ).toBeNull();
    expect(
      configuredPreviewEnvironmentUrl(connection, {
        ...entry,
        target: new BearerConnectionTarget({ ...target, connectionId: "other-connection" }),
      }),
    ).toBeNull();
    expect(
      configuredPreviewEnvironmentUrl(connection, { ...entry, profile: Option.none() }),
    ).toBeNull();
    expect(
      configuredPreviewEnvironmentUrl(connection, {
        ...entry,
        profile: Option.some(
          new BearerConnectionProfile({
            connectionId: target.connectionId,
            label: target.label,
            httpBaseUrl: "http://192.168.1.24:3773/",
            wsBaseUrl: "ws://192.168.1.24:3773/ws",
            environmentId: EnvironmentId.make("other-environment"),
          }),
        ),
      }),
    ).toBeNull();
  });
  it("does not infer private endpoints from relay targets", () => {
    expect(
      configuredPreviewEnvironmentUrl(
        {
          ...connection,
          target: new RelayConnectionTarget({
            environmentId: threadRef.environmentId,
            label: target.label,
          }),
        },
        entry,
      ),
    ).toBeNull();
  });
  it("retains a primary target's configured endpoint", () => {
    expect(
      configuredPreviewEnvironmentUrl(
        {
          ...connection,
          target: new PrimaryConnectionTarget({
            environmentId: threadRef.environmentId,
            label: target.label,
            httpBaseUrl: "http://192.168.1.24:3773/",
            wsBaseUrl: "ws://192.168.1.24:3773/ws",
          }),
        },
        undefined,
      ),
    ).toBe("http://192.168.1.24:3773/");
  });
});

describe("rewritten preview URL limits", () => {
  it.each([2047, 2048])("accepts an unchanged %i-character destination", async (length) => {
    const prefix = "http://localhost:5173/";
    const url = prefix + "x".repeat(length - prefix.length);
    const found = { ...lease, url };
    const recover = vi.fn(async () => found);
    await expect(
      prepareHostedPreview({
        threadRef,
        url,
        environmentUrl: "http://localhost:3773/",
        list: async () => [found],
        recover,
      }),
    ).resolves.toMatchObject({ url, managed: true, restored: true });
    expect(recover).toHaveBeenCalledTimes(1);
  });
  it("rejects hostname growth beyond the wire limit before restarting the server", async () => {
    const prefix = "http://localhost:5173/";
    const url = prefix + "x".repeat(2048 - prefix.length);
    const found = { ...lease, url };
    const recover = vi.fn(async () => found);
    await expect(
      prepareHostedPreview({
        threadRef,
        url,
        environmentUrl: "http://192.168.100.100:3773/",
        list: async () => [found],
        recover,
      }),
    ).rejects.toBeInstanceOf(HostedPreviewUrlTooLongError);
    expect(recover).not.toHaveBeenCalled();
  });
  it("preserves a rewritten destination at the exact limit including query and fragment", async () => {
    const prefix = "http://localhost:5173/";
    const suffix = "?q=original#section";
    const growth = "192.168.100.100".length - "localhost".length;
    const url = prefix + "x".repeat(2048 - prefix.length - suffix.length - growth) + suffix;
    const found = { ...lease, url };
    const result = await prepareHostedPreview({
      threadRef,
      url,
      environmentUrl: "http://192.168.100.100:3773/",
      list: async () => [found],
      recover: async () => found,
    });
    expect(result.url).toBe(url.replace("localhost", "192.168.100.100"));
    expect(result.url).toHaveLength(2048);
  });
});
