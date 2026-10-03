import { EnvironmentId, PreviewHostingLeaseId, ThreadId } from "@t3tools/contracts";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { prepareHostedPreview, selectHostedPreview } from "./previewHosting.ts";

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
    const list = vi.fn(() => new Promise<(typeof lease)[]>((resolve) => (finishList = resolve)));
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
    finishList([lease]);
    expect(await first).toMatchObject({ managed: true, restored: true });
    expect(list).toHaveBeenCalledTimes(1);
    expect(input.recover).toHaveBeenCalledTimes(1);
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
