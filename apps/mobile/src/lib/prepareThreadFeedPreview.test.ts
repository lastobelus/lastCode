import { HostedPreviewUrlTooLongError } from "@t3tools/client-runtime/preview-hosting";
import { EnvironmentId, PreviewHostingLeaseId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  openThreadFeedMarkdownUrl,
  prepareThenOpenThreadFeedUrl,
  preparedThreadFeedMediaActionsSource,
  startPreparingThreadFeedMediaUrl,
  type ThreadFeedMediaPreparation,
} from "./prepareThreadFeedPreview";

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

describe("prepareThenOpenThreadFeedUrl", () => {
  it("restores an owned thread lease before opening the environment-resolved URL", async () => {
    const order: string[] = [];
    const opened = vi.fn(async () => {
      order.push("open");
      return true;
    });
    const result = await prepareThenOpenThreadFeedUrl(
      {
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
      },
      opened,
    );

    expect(result).toBe(true);
    expect(order).toEqual(["list", "recover", "open"]);
    expect(opened).toHaveBeenCalledWith("http://192.168.1.30:5173/report/index.html?run=7#chart");
  });

  it("opens ordinary public links unchanged without querying preview leases", async () => {
    const list = vi.fn(async () => [lease]);
    const opened = vi.fn(async () => true);

    await prepareThenOpenThreadFeedUrl(
      {
        threadRef,
        url: "https://public.example/article?a=1#section",
        environmentUrl: "http://localhost:8080/",
        list,
        recover: async () => lease,
      },
      opened,
    );

    expect(list).not.toHaveBeenCalled();
    expect(opened).toHaveBeenCalledWith("https://public.example/article?a=1#section");
  });

  it("waits for managed recovery before a thread markdown link opens externally", async () => {
    let finishRecovery!: (recovered: typeof lease) => void;
    let recoveryStarted!: () => void;
    const started = new Promise<void>((resolve) => (recoveryStarted = resolve));
    const opened = vi.fn(async (url: string) => url);
    const opening = openThreadFeedMarkdownUrl(
      {
        threadRef,
        environmentUrl: "https://192.168.1.30:8443/",
        list: async () => [lease],
        recover: () => {
          recoveryStarted();
          return new Promise<typeof lease>((resolve) => (finishRecovery = resolve));
        },
      },
      lease.url,
      opened,
    );

    await started;
    expect(opened).not.toHaveBeenCalled();
    finishRecovery(lease);
    await expect(opening).resolves.toBe("http://192.168.1.30:5173/report/index.html?run=7#chart");
    expect(opened).toHaveBeenCalledOnce();
  });

  it.each(["pdf", "png", "mp4"])(
    "waits for owned preview recovery before opening a .%s viewer",
    async (extension) => {
      const url = `http://localhost:5173/report.${extension}?run=7#chart`;
      let finishRecovery!: (recovered: typeof lease) => void;
      let recoveryStarted!: () => void;
      const started = new Promise<void>((resolve) => (recoveryStarted = resolve));
      const openViewer = vi.fn((preparedUrl: string) => ({ kind: extension, uri: preparedUrl }));
      const opening = prepareThenOpenThreadFeedUrl(
        {
          threadRef,
          url,
          environmentUrl: "https://192.168.1.30:8443/",
          list: async () => [{ ...lease, url }],
          recover: () => {
            recoveryStarted();
            return new Promise<typeof lease>((resolve) => (finishRecovery = resolve));
          },
        },
        openViewer,
      );

      await started;
      expect(openViewer).not.toHaveBeenCalled();
      finishRecovery(lease);
      await expect(opening).resolves.toEqual({
        kind: extension,
        uri: `http://192.168.1.30:5173/report.${extension}?run=7#chart`,
      });
      expect(openViewer).toHaveBeenCalledOnce();
    },
  );
});

describe("startPreparingThreadFeedMediaUrl", () => {
  it("keeps local media sources immediate", () => {
    const prepare = vi.fn(async (url: string) => url);
    const publish = vi.fn();

    startPreparingThreadFeedMediaUrl("file:///workspace/image.png", prepare, publish);

    expect(publish).toHaveBeenCalledWith({ status: "ready", uri: "file:///workspace/image.png" });
    expect(prepare).not.toHaveBeenCalled();
  });

  it("does not publish a media source until owned preview recovery finishes", async () => {
    let finishRecovery!: (url: string) => void;
    let recoveryStarted!: () => void;
    const started = new Promise<void>((resolve) => (recoveryStarted = resolve));
    const published: ThreadFeedMediaPreparation[] = [];
    let finishPublishing!: () => void;
    const publishedResult = new Promise<void>((resolve) => (finishPublishing = resolve));
    const cancel = startPreparingThreadFeedMediaUrl(
      lease.url,
      () => {
        recoveryStarted();
        return new Promise<string>((resolve) => (finishRecovery = resolve));
      },
      (result) => {
        published.push(result);
        finishPublishing();
      },
    );

    await started;
    expect(published).toEqual([]);
    finishRecovery("http://192.168.1.30:5173/report/index.html?run=7#chart");
    await publishedResult;
    expect(published).toEqual([
      { status: "ready", uri: "http://192.168.1.30:5173/report/index.html?run=7#chart" },
    ]);
    cancel();
  });

  it.each(["png", "mp4"])(
    "settles an oversized .%s preview as unavailable without publishing its loopback URL",
    async (extension) => {
      const prefix = "http://localhost:5173/";
      const suffix = `.${extension}`;
      const url = prefix + "x".repeat(2048 - prefix.length - suffix.length) + suffix;
      const found = { ...lease, url };
      const recover = vi.fn(async () => found);
      const result = await new Promise<ThreadFeedMediaPreparation>((publish) => {
        startPreparingThreadFeedMediaUrl(
          url,
          (url) =>
            prepareThenOpenThreadFeedUrl(
              {
                threadRef,
                url,
                environmentUrl: "http://192.168.100.100:3773/",
                list: async () => [found],
                recover,
              },
              (preparedUrl) => preparedUrl,
            ),
          publish,
        );
      });

      expect(result).toEqual({ status: "unavailable", uri: null });
      expect(recover).not.toHaveBeenCalled();
    },
  );

  it("ignores an unavailable result after the media source is replaced", async () => {
    let rejectPreparation!: (cause: unknown) => void;
    let preparationStarted!: () => void;
    const started = new Promise<void>((resolve) => (preparationStarted = resolve));
    const preparation = new Promise<string>((_, reject) => (rejectPreparation = reject));
    const publish = vi.fn();
    const cancel = startPreparingThreadFeedMediaUrl(
      lease.url,
      () => {
        preparationStarted();
        return preparation;
      },
      publish,
    );

    await started;
    cancel();
    rejectPreparation(new HostedPreviewUrlTooLongError());
    await expect(preparation).rejects.toBeInstanceOf(HostedPreviewUrlTooLongError);
    await Promise.resolve();
    expect(publish).not.toHaveBeenCalled();
  });

  it("ignores a late media URL after the component source is replaced or unmounted", async () => {
    let finishRecovery!: (url: string) => void;
    let recoveryStarted!: () => void;
    const started = new Promise<void>((resolve) => (recoveryStarted = resolve));
    const publish = vi.fn();
    const cancel = startPreparingThreadFeedMediaUrl(
      lease.url,
      () => {
        recoveryStarted();
        return new Promise<string>((resolve) => (finishRecovery = resolve));
      },
      publish,
    );

    await started;
    cancel();
    finishRecovery("http://192.168.1.30:5173/report/index.html?run=7#chart");
    await Promise.resolve();
    expect(publish).not.toHaveBeenCalled();
  });
});

describe("preparedThreadFeedMediaActionsSource", () => {
  it("uses the prepared remote URL for direct image actions and URL references", () => {
    expect(
      preparedThreadFeedMediaActionsSource(
        {
          uri: lease.url,
          name: "Preview image",
          mimeType: "image/png",
          reference: { kind: "url", url: lease.url },
        },
        "http://192.168.1.30:5173/report.png?run=7#chart",
      ),
    ).toEqual({
      uri: "http://192.168.1.30:5173/report.png?run=7#chart",
      name: "Preview image",
      mimeType: "image/png",
      reference: {
        kind: "url",
        url: "http://192.168.1.30:5173/report.png?run=7#chart",
      },
    });
  });

  it("leaves environment-backed media actions unchanged", () => {
    const source = {
      environmentId: threadRef.environmentId,
      resource: { _tag: "media-file" as const, threadId: threadRef.threadId, path: "image.png" },
      name: "Workspace image",
      mimeType: "image/png",
    };

    expect(preparedThreadFeedMediaActionsSource(source, lease.url)).toBe(source);
  });
});

it("does not open the authored loopback URL after a rewritten destination exceeds the limit", async () => {
  const prefix = "http://localhost:5173/";
  const url = prefix + "x".repeat(2048 - prefix.length);
  const found = { ...lease, url };
  const open = vi.fn();
  const recover = vi.fn(async () => found);
  await expect(
    prepareThenOpenThreadFeedUrl(
      {
        threadRef,
        url,
        environmentUrl: "http://192.168.100.100:3773/",
        list: async () => [found],
        recover,
      },
      open,
    ),
  ).rejects.toBeInstanceOf(HostedPreviewUrlTooLongError);
  expect(open).not.toHaveBeenCalled();
  expect(recover).not.toHaveBeenCalled();
});
