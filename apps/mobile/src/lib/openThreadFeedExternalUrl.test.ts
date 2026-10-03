import { EnvironmentId, PreviewHostingLeaseId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import { openThreadFeedExternalUrl } from "./openThreadFeedExternalUrl";

const threadRef = {
  environmentId: EnvironmentId.make("environment-mobile-link"),
  threadId: ThreadId.make("thread-mobile-link"),
};
const lease = {
  leaseId: PreviewHostingLeaseId.make("lease-mobile-link"),
  threadId: threadRef.threadId,
  url: "http://localhost:5173/report/index.html?run=7#chart",
  handedOffAt: "2026-10-02T00:00:00.000Z",
  expiresAt: "2026-10-03T00:00:00.000Z",
  status: "active" as const,
};

describe("openThreadFeedExternalUrl", () => {
  it("restores an owned thread lease before opening the environment-resolved URL", async () => {
    const order: string[] = [];
    const opened = vi.fn(async () => {
      order.push("open");
      return true;
    });
    const result = await openThreadFeedExternalUrl({
      threadRef,
      url: "http://localhost:5173/report/index.html?run=7#chart",
      environmentUrl: "https://192.168.1.30:8443/",
      list: async () => {
        order.push("list");
        return [lease];
      },
      recover: async (found) => {
        order.push("recover");
        expect(found).toEqual(lease);
        return lease;
      },
      openExternal: opened,
    });

    expect(result).toBe(true);
    expect(order).toEqual(["list", "recover", "open"]);
    expect(opened).toHaveBeenCalledWith("http://192.168.1.30:5173/report/index.html?run=7#chart");
  });

  it("opens ordinary public links unchanged without querying preview leases", async () => {
    const list = vi.fn(async () => [lease]);
    const opened = vi.fn(async () => true);

    await openThreadFeedExternalUrl({
      threadRef,
      url: "https://public.example/article?a=1#section",
      environmentUrl: "http://localhost:8080/",
      list,
      recover: async () => lease,
      openExternal: opened,
    });

    expect(list).not.toHaveBeenCalled();
    expect(opened).toHaveBeenCalledWith("https://public.example/article?a=1#section");
  });
});
