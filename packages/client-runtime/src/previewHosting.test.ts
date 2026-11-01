import {
  AssetPreviewDocumentError,
  EnvironmentId,
  PreviewHostingLeaseId,
  ThreadId,
  type PreviewHostingLeaseSummary,
} from "@t3tools/contracts";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { getPairingTokenFromUrl, stripPreviewBootstrapTokenFromUrl } from "@t3tools/shared/remote";

import * as Option from "effect/Option";
import * as Base64Url from "effect/encoding/Base64Url";
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
  HostedPreviewRecoveryError,
  hostedPreviewNavigationUrl,
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
const savedDocumentPath = `/api/assets/${Base64Url.encode(
  JSON.stringify({
    version: 1,
    kind: "attachment",
    attachmentId: "example-report",
    expiresAt: 1,
  }),
)}.${Base64Url.encode(new Uint8Array(32))}/report.pdf`;

describe("prepareHostedPreview", () => {
  beforeEach(() => vi.restoreAllMocks());
  it("recovers a shared HTTPS destination through its saved sleeping HTTP listener", async () => {
    const sleeping = { ...lease, status: "sleeping" as const };
    const url = lease.url.replace("http://localhost", "https://environment.example");
    const recover = vi.fn(async () => ({
      ...lease,
      restarted: true,
      bootstrapToken: "fixture-navigation",
    }));
    const prepared = await prepareHostedPreview({
      threadRef,
      url,
      environmentUrl: "https://environment.example/",
      list: async () => [sleeping],
      recover,
    });
    expect(prepared).toMatchObject({ url, localUrl: lease.url, managed: true, restored: true });
    expect(recover).toHaveBeenCalledExactlyOnceWith(sleeping, { bootstrap: true });
    expect(getPairingTokenFromUrl(new URL(prepared.navigationUrl!))).toBe("fixture-navigation");
  });

  it("prefers an exact HTTPS lease over the HTTP listener on the same port", async () => {
    const secure = {
      ...lease,
      leaseId: PreviewHostingLeaseId.make("secure-lease"),
      url: lease.url.replace("http:", "https:"),
    };
    const url = secure.url.replace("localhost", "environment.example");
    const recover = vi.fn(async () => secure);
    const prepared = await prepareHostedPreview({
      threadRef,
      url,
      environmentUrl: "https://environment.example/",
      list: async () => [lease, secure],
      recover,
    });
    expect(prepared.localUrl).toBe(secure.url);
    expect(recover).toHaveBeenCalledExactlyOnceWith(secure, { bootstrap: true });
  });

  it("does not match the implicit HTTPS port to an HTTP port 80 listener", async () => {
    const url = "https://environment.example/preview";
    const recover = vi.fn(async () => lease);
    const prepared = await prepareHostedPreview({
      threadRef,
      url,
      environmentUrl: "https://environment.example/",
      list: async () => [{ ...lease, url: "http://localhost/preview" }],
      recover,
    });
    expect(prepared).toEqual({ url, managed: false, restored: false });
    expect(recover).not.toHaveBeenCalled();
  });

  it("does not recover an unrelated HTTPS host through an owned HTTP listener", async () => {
    const url = lease.url.replace("http://localhost", "https://external.example");
    const list = vi.fn(async () => [lease]);
    const recover = vi.fn(async () => lease);
    expect(
      await prepareHostedPreview({
        threadRef,
        url,
        environmentUrl: "https://environment.example/",
        list,
        recover,
      }),
    ).toEqual({ url, managed: false, restored: false });
    expect(list).not.toHaveBeenCalled();
    expect(recover).not.toHaveBeenCalled();
  });

  it("leaves a previous private HTTPS link unchanged when only an HTTP recipe exists", async () => {
    const url = lease.url.replace("http://localhost", "https://previous-managed-server");
    const list = vi.fn(async () => [lease]);
    const recover = vi.fn(async () => lease);
    expect(
      await prepareHostedPreview({
        threadRef,
        url,
        environmentUrl: "https://managed-server:8443/",
        knownEnvironmentUrls: ["https://previous-managed-server:8080/"],
        list,
        recover,
      }),
    ).toEqual({ url, managed: false, restored: false });
    expect(list).toHaveBeenCalledOnce();
    expect(recover).not.toHaveBeenCalled();
  });

  it("preserves a signed document when deferred capability discovery reports unsupported", async () => {
    const url = "https://environment.example/api/assets/expired/report.html";
    const list = vi.fn(async () => [lease]);
    const renewDocumentUrl = vi.fn(async () => null);
    await expect(
      prepareHostedPreview({
        threadRef,
        url,
        environmentUrl: "https://environment.example/",
        list,
        recover: async () => lease,
        renewDocumentUrl,
      }),
    ).resolves.toEqual({ url, managed: false, restored: false });
    expect(renewDocumentUrl).toHaveBeenCalledExactlyOnceWith(url, true);
    expect(list).not.toHaveBeenCalled();
  });

  it("omits the resource URL when deferred capability discovery reports unsupported", async () => {
    const createResourceUrl = vi.fn(async () => null);
    const prepared = await prepareHostedPreview({
      threadRef,
      url: lease.url,
      purpose: "resource",
      environmentUrl: "https://environment.example/",
      list: async () => [lease],
      recover: async () => lease,
      createResourceUrl,
    });
    expect(prepared).toMatchObject({ managed: true, restored: true });
    expect(prepared).not.toHaveProperty("resourceUrl");
    expect(createResourceUrl).toHaveBeenCalledOnce();
  });

  it("keeps a signed document usable when its environment has no renewal operation", async () => {
    const url = "https://environment.example/api/assets/current/report.html?mode=review#chart";
    const list = vi.fn(async () => [lease]);
    const recover = vi.fn(async () => lease);
    await expect(
      prepareHostedPreview({
        threadRef,
        url,
        environmentUrl: "https://environment.example/",
        list,
        recover,
      }),
    ).resolves.toEqual({ url, managed: false, restored: false });
    expect(list).not.toHaveBeenCalled();
    expect(recover).not.toHaveBeenCalled();
  });

  it("preserves the current app run when another consumer already restarted it", async () => {
    const runId = "019fc835-d8cb-4a6e-847f-4b63db5c85bb";
    const prepared = await prepareHostedPreview({
      threadRef,
      url: lease.url,
      environmentUrl: "https://environment.example/",
      purpose: "resource",
      list: async () => [lease],
      recover: async () => ({ ...lease, runId }),
    });
    expect(prepared).toMatchObject({ managed: true, runId });
    expect(prepared).not.toHaveProperty("restarted");
  });

  it("keeps a healthy connected document stable without querying preview leases", async () => {
    const url = "https://environment.example/api/assets/signed/report.pdf?page=2#chart";
    const list = vi.fn(async () => [lease]);
    const renewDocumentUrl = vi.fn(async () => "/api/assets/signed/report.pdf?page=2#chart");
    const result = await prepareHostedPreview({
      threadRef,
      url,
      purpose: "resource",
      environmentUrl: "https://environment.example/",
      list,
      recover: async () => lease,
      renewDocumentUrl,
    });
    expect(result).toEqual({ url, managed: false, restored: true });
    expect(renewDocumentUrl).toHaveBeenCalledExactlyOnceWith(url, false);
    expect(list).not.toHaveBeenCalled();
  });

  it.each([
    ["navigation", "http://localhost:3773/"],
    ["resource", "http://localhost:3773/"],
    ["resource", "https://environment.example/"],
  ] as const)(
    "recovers a managed app asset on another loopback port for %s via %s",
    async (purpose, environmentUrl) => {
      const url = `http://localhost:5173${savedDocumentPath}?page=2#chart`;
      const recover = vi.fn(async () => ({ ...lease, restarted: true }));
      const createResourceUrl = vi.fn(async () => "/api/assets/environment-signed/report.pdf");
      const renewDocumentUrl = vi.fn(async () => {
        throw new Error("App capability is not signed by the environment");
      });
      const result = await prepareHostedPreview({
        threadRef,
        url,
        purpose,
        environmentUrl,
        list: async () => [lease],
        recover,
        createResourceUrl,
        renewDocumentUrl,
      });
      expect(result).toMatchObject({ url, localUrl: url, managed: true, restored: true });
      expect(recover).toHaveBeenCalledExactlyOnceWith(lease, {
        bootstrap: purpose === "navigation",
      });
      expect(renewDocumentUrl).not.toHaveBeenCalled();
      if (purpose === "resource") {
        expect(createResourceUrl).toHaveBeenCalledExactlyOnceWith(lease, url);
        expect(result.resourceUrl).toBe(
          new URL("/api/assets/environment-signed/report.pdf", environmentUrl).href,
        );
      }
    },
  );

  it.each(
    ["empty", "unavailable"].flatMap((listing) =>
      [
        "/api/assets/logo.png",
        "/api/assets/images/logo.png",
        "/api/assets/app.signature/logo.png",
        `/api/assets/${Base64Url.encode(JSON.stringify({ version: 1, kind: "project-favicon", expiresAt: 1 }))}.signature/logo.png`,
      ].map((path) => ({ listing, url: `http://localhost:3000${path}` })),
    ),
  )("preserves ordinary loopback assets with $listing leases: $url", async ({ listing, url }) => {
    const renewDocumentUrl = vi.fn(async () => {
      throw new Error("Not an environment document capability");
    });
    const recover = vi.fn(async () => lease);
    const result = await prepareHostedPreview({
      threadRef,
      url,
      environmentUrl: "https://environment.example/",
      list: async () => {
        if (listing === "unavailable") throw new Error("Lease lookup unavailable");
        return [];
      },
      recover,
      renewDocumentUrl,
    });
    expect(result).toEqual({ url, managed: false, restored: false });
    expect(renewDocumentUrl).not.toHaveBeenCalled();
    expect(recover).not.toHaveBeenCalled();
  });

  it.each([
    `http://127.0.0.1:3773${savedDocumentPath}?page=2#chart`,
    "http://previous-environment.example:3773/api/assets/expired/report.pdf?page=2#chart",
  ])("renews an owned saved document against its connected origin: %s", async (url) => {
    const renewDocumentUrl = vi.fn(async () => "/api/assets/renewed/report.pdf?page=2#chart");
    const list = vi.fn(async () => [lease]);
    const result = await prepareHostedPreview({
      threadRef,
      url,
      environmentUrl: "https://environment.example/",
      knownEnvironmentUrls: ["http://previous-environment.example:3773/"],
      list,
      recover: async () => lease,
      renewDocumentUrl,
    });
    expect(result).toEqual({
      url: "https://environment.example/api/assets/renewed/report.pdf?page=2#chart",
      managed: false,
      restored: true,
      restarted: true,
    });
    expect(renewDocumentUrl).toHaveBeenCalledExactlyOnceWith(url, true);
    expect(list).toHaveBeenCalledTimes(url.startsWith("http://127.0.0.1:") ? 1 : 0);
  });

  it("renews a saved loopback document even when preview lease lookup fails", async () => {
    const url = `http://127.0.0.1:3773${savedDocumentPath}`;
    const renewDocumentUrl = vi.fn(async () => "/api/assets/renewed/report.pdf");
    const recover = vi.fn(async () => lease);
    const result = await prepareHostedPreview({
      threadRef,
      url,
      environmentUrl: "https://environment.example/",
      list: async () => {
        throw new Error("Lease lookup unavailable");
      },
      recover,
      renewDocumentUrl,
    });
    expect(result).toEqual({
      url: "https://environment.example/api/assets/renewed/report.pdf",
      managed: false,
      restored: true,
      restarted: true,
    });
    expect(renewDocumentUrl).toHaveBeenCalledExactlyOnceWith(url, true);
    expect(recover).not.toHaveBeenCalled();
  });

  it("does not offer a foreign asset route to document renewal", async () => {
    const renewDocumentUrl = vi.fn(async () => "/api/assets/renewed/report.pdf");
    const url = "https://external.example/api/assets/signed/report.pdf";
    const result = await prepareHostedPreview({
      threadRef,
      url,
      environmentUrl: "https://environment.example/",
      list: async () => [lease],
      recover: async () => lease,
      renewDocumentUrl,
    });
    expect(result).toEqual({ url, managed: false, restored: false });
    expect(renewDocumentUrl).not.toHaveBeenCalled();
  });

  it.each(["empty", "unavailable"])(
    "preserves another environment's signed loopback document with %s leases",
    async (listing) => {
      const url = `http://127.0.0.1:3773${savedDocumentPath}?page=2#chart`;
      const renewDocumentUrl = vi.fn(async () => {
        throw new AssetPreviewDocumentError({});
      });
      const result = await prepareHostedPreview({
        threadRef,
        url,
        environmentUrl: "https://environment.example/",
        list: async () => {
          if (listing === "unavailable") throw new Error("Lease lookup unavailable");
          return [];
        },
        recover: async () => lease,
        renewDocumentUrl,
      });
      expect(result).toEqual({ url, managed: false, restored: false });
      expect(renewDocumentUrl).toHaveBeenCalledExactlyOnceWith(url, true);
    },
  );

  it("keeps document rejection actionable on the environment's own origin", async () => {
    await expect(
      prepareHostedPreview({
        threadRef,
        url: `https://environment.example${savedDocumentPath}`,
        environmentUrl: "https://environment.example/",
        list: async () => [],
        recover: async () => lease,
        renewDocumentUrl: async () => {
          throw new AssetPreviewDocumentError({});
        },
      }),
    ).rejects.toBeInstanceOf(HostedPreviewRecoveryError);
  });

  it.each(["https://external.example/api/assets/signed/report.pdf", "/other/report.pdf"])(
    "rejects invalid document renewal destinations: %s",
    async (issued) => {
      const list = vi.fn(async () => [lease]);
      await expect(
        prepareHostedPreview({
          threadRef,
          url: "https://environment.example/api/assets/expired/report.pdf",
          environmentUrl: "https://environment.example/",
          list,
          recover: async () => lease,
          renewDocumentUrl: async () => issued,
        }),
      ).rejects.toBeInstanceOf(HostedPreviewRecoveryError);
      expect(list).not.toHaveBeenCalled();
    },
  );

  it.each([
    "https://environment.example/api/assets/expired/report.pdf",
    `http://127.0.0.1:3773${savedDocumentPath}`,
  ])("surfaces document renewal failure without opening the expired URL: %s", async (url) => {
    const list = vi.fn(async () => [lease]);
    await expect(
      prepareHostedPreview({
        threadRef,
        url,
        environmentUrl: "https://environment.example/",
        list,
        recover: async () => lease,
        renewDocumentUrl: async () => {
          throw new Error("File unavailable");
        },
      }),
    ).rejects.toBeInstanceOf(HostedPreviewRecoveryError);
    expect(list).toHaveBeenCalledTimes(url.startsWith("http://127.0.0.1:") ? 1 : 0);
  });

  it("prepares exact remote media on the connected origin without changing Browser identity", async () => {
    const createResourceUrl = vi.fn(async () => "/api/assets/signed-exact-resource/clip.mp4");
    const result = await prepareHostedPreview({
      threadRef,
      purpose: "resource",
      url: "http://127.0.0.1:5173/media/clip.mp4?version=2#chapter",
      environmentUrl: "https://environment.example:8443/",
      list: async () => [lease],
      recover: async () => lease,
      createResourceUrl,
    });
    expect(createResourceUrl).toHaveBeenCalledExactlyOnceWith(
      lease,
      "http://localhost:5173/media/clip.mp4?version=2#chapter",
    );
    expect(result).toEqual({
      url: "http://127.0.0.1:5173/media/clip.mp4?version=2#chapter",
      localUrl: "http://localhost:5173/media/clip.mp4?version=2#chapter",
      resourceUrl: "https://environment.example:8443/api/assets/signed-exact-resource/clip.mp4",
      managed: true,
      restored: true,
    });
  });

  it("does not request a resource capability for navigation or an unowned resource", async () => {
    const createResourceUrl = vi.fn(async () => "/api/assets/signed/image.png");
    const input = {
      threadRef,
      environmentUrl: "https://environment.example/",
      list: async () => [lease],
      recover: async () => lease,
      createResourceUrl,
    };
    await prepareHostedPreview({ ...input, url: lease.url });
    const external = await prepareHostedPreview({
      ...input,
      purpose: "resource",
      url: "https://external.example/image.png",
    });
    const unowned = await prepareHostedPreview({
      ...input,
      purpose: "resource",
      url: "http://localhost:5174/image.png",
    });
    expect(external.managed).toBe(false);
    expect(unowned.managed).toBe(false);
    expect(createResourceUrl).not.toHaveBeenCalled();
  });

  it.each(["https://external.example/api/assets/signed/image.png", "/other/image.png"])(
    "rejects a resource capability outside the connected asset route: %s",
    async (issued) => {
      await expect(
        prepareHostedPreview({
          threadRef,
          purpose: "resource",
          url: lease.url,
          environmentUrl: "https://environment.example/",
          list: async () => [lease],
          recover: async () => lease,
          createResourceUrl: async () => issued,
        }),
      ).rejects.toBeInstanceOf(HostedPreviewRecoveryError);
    },
  );

  it("preserves application reset and invite tokens while preparing and retargeting a bootstrap", async () => {
    const destination =
      "http://localhost:5173/reset?token=application-reset#token=application-invite";
    const result = await prepareHostedPreview({
      threadRef,
      url: destination,
      environmentUrl: "http://localhost:8080",
      list: async () => [lease],
      recover: async () => ({ ...lease, bootstrapToken: "issued-preview-credential" }),
    });
    expect(result.url).toBe(destination);
    const navigation = new URL(result.navigationUrl!);
    expect(getPairingTokenFromUrl(navigation)).toBe("issued-preview-credential");
    expect(stripPreviewBootstrapTokenFromUrl(navigation).href).toBe(destination);
    const redirected =
      "http://127.0.0.1:5173/invite?token=other-application-code#token=other-invite";
    const retargeted = new URL(hostedPreviewNavigationUrl(result, redirected));
    expect(getPairingTokenFromUrl(retargeted)).toBe("issued-preview-credential");
    expect(stripPreviewBootstrapTokenFromUrl(retargeted).href).toBe(redirected);
  });

  it("reopens an old sleeping handoff with a unique credential for each navigation", async () => {
    const sleeping = { ...lease, status: "sleeping" as const };
    let sequence = 0;
    const recover = vi.fn(async () => ({ ...lease, bootstrapToken: `one-use-${++sequence}` }));
    const input = {
      threadRef,
      url: lease.url,
      environmentUrl: "http://localhost:8080",
      list: async () => [sleeping],
      recover,
    };
    const [first, second] = await Promise.all([
      prepareHostedPreview(input),
      prepareHostedPreview(input),
    ]);
    expect(first.url).toBe(lease.url);
    expect(second.url).toBe(lease.url);
    expect(first.navigationUrl).not.toEqual(second.navigationUrl);
    expect(first.navigationUrl).toContain("one-use-1");
    expect(second.navigationUrl).toContain("one-use-2");
    expect(hostedPreviewNavigationUrl(first, "http://127.0.0.1:5173/other#section")).toContain(
      "one-use-1",
    );
    expect(recover).toHaveBeenCalledTimes(2);
  });

  it("does not request or expose browser authentication for a direct resource", async () => {
    const recover = vi.fn(async () => ({ ...lease, bootstrapToken: "unexpected-secret" }));
    const result = await prepareHostedPreview({
      threadRef,
      purpose: "resource",
      url: lease.url,
      environmentUrl: "http://localhost:8080",
      list: async () => [lease],
      recover,
    });
    expect(recover).toHaveBeenCalledWith(lease, { bootstrap: false });
    expect(result).toEqual({ url: lease.url, localUrl: lease.url, managed: true, restored: true });
  });

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
      localUrl: "http://localhost:5173/preview/index.html?theme=dark#top",
      managed: true,
      restored: true,
    });
    expect(recover).toHaveBeenCalledWith(lease, { bootstrap: true });
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
      localUrl: "http://localhost:5173/preview?q=1#section",
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
      localUrl: savedLease.url,
      managed: true,
      restored: true,
    });
    expect(recover).toHaveBeenCalledWith(savedLease, { bootstrap: true });
  });

  it("retains the verified loopback destination for environment browsing through a remote endpoint", async () => {
    const localLease = { ...lease, url: "http://127.0.0.1:5173/" };
    const result = await prepareHostedPreview({
      threadRef,
      url: "http://workstation.example:5173/app/a%2Fb?run=1&token=application#section",
      environmentUrl: "https://workstation.example/",
      list: async () => [localLease],
      recover: async () => ({ ...localLease, bootstrapToken: "navigation-credential" }),
    });

    const localUrl = "http://127.0.0.1:5173/app/a%2Fb?run=1&token=application#section";
    expect(result.localUrl).toBe(localUrl);
    const navigation = new URL(hostedPreviewNavigationUrl(result, result.localUrl));
    expect(stripPreviewBootstrapTokenFromUrl(navigation).href).toBe(localUrl);
    expect(getPairingTokenFromUrl(navigation)).toBe("navigation-credential");
    expect(result.url).toBe(
      "http://workstation.example:5173/app/a%2Fb?run=1&token=application#section",
    );
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

  it("keeps a loopback URL unchanged when no reachable public gateway is configured", async () => {
    const result = await prepareHostedPreview({
      threadRef,
      url: "http://localhost:5173/preview?q=1#section",
      environmentUrl: "https://server.example.com/",
      list: async () => [lease],
      recover: async () => lease,
    });

    expect(result).toEqual({
      url: "http://localhost:5173/preview?q=1#section",
      localUrl: "http://localhost:5173/preview?q=1#section",
      managed: true,
      restored: true,
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

  it("leaves unknown links alone but refuses navigation when known recovery fails", async () => {
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
    const failedRecovery = prepareHostedPreview({
      threadRef,
      url,
      environmentUrl: "http://localhost:8080/",
      list: async () => [lease],
      recover: async () => {
        throw new Error("recovery failed");
      },
    });

    expect(failedList).toEqual({ url, managed: false, restored: false });
    await expect(failedRecovery).rejects.toBeInstanceOf(HostedPreviewRecoveryError);
  });

  it("coalesces concurrent resource preparation for the same scoped URL", async () => {
    let finishList!: (leases: (typeof lease)[]) => void;
    let listStarted!: () => void;
    const started = new Promise<void>((resolve) => (listStarted = resolve));
    const list = vi.fn(() => {
      listStarted();
      return new Promise<(typeof lease)[]>((resolve) => (finishList = resolve));
    });
    const input = {
      purpose: "resource" as const,
      threadRef,
      url: lease.url,
      environmentUrl: "http://localhost:8080/",
      list,
      recover: vi.fn(async () => lease),
    };
    const first = prepareHostedPreview(input);
    const second = prepareHostedPreview(input);

    await started;
    finishList([lease]);
    expect(await first).toMatchObject({ managed: true, restored: true });
    expect(await second).toEqual(await first);
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
    const input = {
      purpose: "resource" as const,
      threadRef,
      environmentUrl: "http://192.168.1.30:8080/",
      list,
      recover,
    };
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
        localUrl: `http://localhost:5173${path}`,
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
    const input = {
      purpose: "resource" as const,
      threadRef,
      environmentUrl: "http://localhost:8080/",
      list,
      recover,
    };
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
