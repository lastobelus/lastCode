import { afterEach, describe, expect, it } from "vite-plus/test";
import { DeviceId, ProjectId, ThreadId, DEFAULT_SERVER_SETTINGS } from "@t3tools/contracts";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import {
  HttpClient,
  HttpClientResponse,
  HttpRouter,
  HttpServerRequest,
  HttpServerResponse,
} from "effect/http";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as DeviceAgentAccess from "./DeviceAgentAccess.ts";
import * as DeviceService from "./DeviceService.ts";
import * as AgentDeviceProxy from "./AgentDeviceProxy.ts";

const disposers: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const dispose of disposers.splice(0)) await dispose();
});

const fixture = () => {
  let permitted = true;
  let support = true;
  let threadState: "present" | "deleted" | "missing" = "present";
  let projectState: "present" | "deleted" | "missing" = "present";
  let origin = "http://local-daemon.example";
  const requests: Array<{ url: string; token: string | undefined }> = [];
  const hostRequests: string[] = [];
  const project = ProjectId.make("project-1");
  const access = DeviceAgentAccess.layer.pipe(
    Layer.provide(
      Layer.mock(ProjectionStore.ProjectionStoreV2)({
        getThreadShell: (id) =>
          Effect.sync(() =>
            threadState === "missing" && id !== "thread-2"
              ? null
              : ({
                  projectId: id === "thread-2" ? ProjectId.make("project-2") : project,
                  deletedAt: threadState === "deleted" && id !== "thread-2" ? "2026-01-01" : null,
                } as NonNullable<
                  Effect.Success<
                    ReturnType<ProjectionStore.ProjectionStoreV2["Service"]["getThreadShell"]>
                  >
                >),
          ),
      }),
    ),
    Layer.provide(
      Layer.mock(ProjectStore.ProjectStoreV2)({
        get: (id) =>
          Effect.sync(() =>
            projectState === "missing" && id === project
              ? Option.none()
              : Option.some({
                  deletedAt: projectState === "deleted" && id === project ? "2026-01-01" : null,
                } as ProjectStore.ProjectRow),
          ),
      }),
    ),
    Layer.provide(
      Layer.mock(ServerSettings.ServerSettingsService)({
        getSettings: Effect.sync(() => ({
          ...DEFAULT_SERVER_SETTINGS,
          enableDeviceSupport: support,
          enableAgentDeviceAccess: false,
          projectSettingsOverrides: {
            [project]: { enableAgentDeviceAccess: permitted },
            "project-2": { enableAgentDeviceAccess: true },
          },
        })),
      }),
    ),
    Layer.provide(NodeCrypto.layer),
  );
  const client = HttpClient.make((request) =>
    Effect.sync(() => {
      requests.push({ url: request.url, token: request.headers["x-agent-device-token"] });
      const body = request.url.endsWith("/upload/preflight")
        ? JSON.stringify({
            ok: true,
            uploadId: "upload-1",
            cacheHit: false,
            upload: {
              url: `${origin}/upload/direct/upload-1`,
              headers: {
                authorization: "Bearer raw-daemon-token",
                "x-agent-device-token": "raw-daemon-token",
                "content-type": "application/zip",
              },
            },
          })
        : "ok";
      return HttpClientResponse.fromWeb(request, new Response(body));
    }),
  );
  const issueRoute = HttpRouter.add(
    "POST",
    "/issue",
    Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;
      const url = HttpServerRequest.toURL(request);
      const service = yield* DeviceAgentAccess.DeviceAgentAccess;
      const threadId = ThreadId.make(
        Option.isSome(url) ? (url.value.searchParams.get("thread") ?? "thread-1") : "thread-1",
      );
      return yield* HttpServerResponse.json({
        token: yield* service.issue({
          threadId,
          hostId: "host-1",
          deviceId: DeviceId.make("device-1"),
          session: `session-${threadId}`,
        }),
      });
    }),
  );
  const { handler, dispose } = HttpRouter.toWebHandler(
    Layer.merge(AgentDeviceProxy.layer, issueRoute).pipe(
      Layer.provideMerge(access),
      Layer.provideMerge(
        Layer.mock(DeviceService.DeviceService)({
          agentReadinessIfSupported: (host) =>
            Effect.sync(() => {
              hostRequests.push(host ?? "local");
              return {
                hostId: host,
                agentDevice: { baseUrl: origin, token: "raw-daemon-token" },
              } as DeviceService.DeviceAgentReadiness;
            }),
        }),
      ),
      Layer.provideMerge(Layer.succeed(HttpClient.HttpClient, client)),
    ),
    { disableLogger: true },
  );
  disposers.push(dispose);
  const issue = async (thread = "thread-1") => {
    const response = await handler(
      new Request(`http://t3.example/issue?thread=${thread}`, { method: "POST" }),
    );
    return ((await response.json()) as { token: string }).token;
  };
  const call = (token: string, path = "/rpc", method = "POST", body?: string) =>
    handler(
      new Request(`http://t3.example/api/agent-device${path}`, {
        method,
        headers: {
          host: "t3.example",
          "x-agent-device-token": token,
          "content-type": "application/json",
        },
        ...(method === "GET"
          ? {}
          : {
              body:
                body ??
                JSON.stringify({
                  jsonrpc: "2.0",
                  id: "request-1",
                  method: "agent_device.command",
                  params: { session: "session-thread-1", command: "snapshot" },
                }),
            }),
      }),
    );
  return {
    issue,
    call,
    handler,
    requests,
    hostRequests,
    revoke: () => {
      permitted = false;
    },
    disable: () => {
      support = false;
    },
    thread: (value: typeof threadState) => {
      threadState = value;
    },
    project: (value: typeof projectState) => {
      projectState = value;
    },
    remote: () => {
      origin = "http://ssh-forward.example";
    },
  };
};

describe("thread-scoped device CLI proxy", () => {
  it("rechecks a copied credential after project revocation without touching unrelated access", async () => {
    const f = fixture();
    const token = await f.issue();
    const other = await f.issue("thread-2");
    expect((await f.call(token)).status).toBe(200);
    expect(f.requests).toEqual([
      { url: "http://local-daemon.example/rpc", token: "raw-daemon-token" },
    ]);
    f.revoke();
    for (const [path, method] of [
      ["/rpc", "POST"],
      ["/health", "GET"],
      ["/upload/preflight", "POST"],
      ["/upload/direct/upload-1", "PUT"],
      ["/artifacts/artifact-1", "GET"],
    ])
      expect((await f.call(token, path, method)).status).toBe(403);
    expect(f.requests).toHaveLength(1);
    expect(f.hostRequests).toHaveLength(1);
    expect((await f.call(other, "/health", "GET")).status).toBe(200);
    expect(f.requests).toHaveLength(2);
  });
  it.each(["missing", "deleted"] as const)(
    "denies %s threads and projects before forwarding",
    async (state) => {
      const f = fixture();
      const token = await f.issue();
      f.thread(state);
      expect((await f.call(token)).status).toBe(403);
      f.thread("present");
      f.project(state);
      expect((await f.call(token)).status).toBe(403);
      expect(f.requests).toEqual([]);
    },
  );
  it("denies disabled support and refuses another session or device", async () => {
    const f = fixture();
    const token = await f.issue();
    for (const params of [
      { session: "other", command: "snapshot" },
      { session: "session-thread-1", command: "open", flags: { udid: "another-device" } },
    ])
      expect(
        (
          await f.call(
            token,
            "/rpc",
            "POST",
            JSON.stringify({ jsonrpc: "2.0", method: "agent_device.command", params }),
          )
        ).status,
      ).toBe(403);
    f.disable();
    expect((await f.call(token)).status).toBe(403);
    expect(f.requests).toEqual([]);
  });
  it("keeps SSH upload URLs and credentials behind the proxy through upload and artifact download", async () => {
    const f = fixture();
    f.remote();
    const token = await f.issue();
    const response = await f.call(token, "/upload/preflight");
    const body = await response.text();
    expect(body).not.toContain("raw-daemon-token");
    expect(body).not.toContain("ssh-forward.example");
    const descriptor = JSON.parse(body) as {
      upload: { url: string; headers: Record<string, string> };
    };
    expect(descriptor.upload.url).toBe("http://t3.example/api/agent-device/upload/direct/upload-1");
    expect(
      (
        await f.handler(
          new Request(descriptor.upload.url, {
            method: "PUT",
            headers: descriptor.upload.headers,
            body: "bytes",
          }),
        )
      ).status,
    ).toBe(200);
    for (const [path, method] of [
      ["/upload", "POST"],
      ["/upload/finalize", "POST"],
      ["/artifacts", "GET"],
      ["/artifacts/artifact-1", "GET"],
      ["/sessions/session-thread-1/requests/request-1/diagnostics", "GET"],
    ])
      expect((await f.call(token, path, method)).status).toBe(200);
    expect(
      f.requests.every(
        (r) => r.url.startsWith("http://ssh-forward.example/") && r.token === "raw-daemon-token",
      ),
    ).toBe(true);
  });
});
