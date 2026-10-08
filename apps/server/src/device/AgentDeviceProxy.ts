/** Keeps the shared daemon credential behind thread consent for every CLI request. */
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import {
  HttpClient,
  HttpClientRequest,
  HttpRouter,
  HttpServerRequest,
  HttpServerResponse,
} from "effect/http";
import * as DeviceAgentAccess from "./DeviceAgentAccess.ts";
import * as DeviceService from "./DeviceService.ts";

const JsonObject = Schema.Record(Schema.String, Schema.Unknown);
const RpcRequest = Schema.Struct({
  jsonrpc: Schema.Literal("2.0"),
  id: Schema.optional(Schema.Unknown),
  method: Schema.String,
  params: JsonObject,
});
const UploadDescriptor = Schema.Struct({
  ok: Schema.Boolean,
  uploadId: Schema.String,
  cacheHit: Schema.Boolean,
  upload: Schema.optional(
    Schema.Struct({ url: Schema.String, headers: Schema.Record(Schema.String, Schema.String) }),
  ),
});
const decodeRpcRequest = Schema.decodeUnknownEffect(RpcRequest);
const decodeObject = Schema.decodeUnknownEffect(JsonObject);
const decodeUploadDescriptor = Schema.decodeUnknownEffect(UploadDescriptor);
const DROPPED_HEADERS = new Set([
  "host",
  "connection",
  "upgrade",
  "cookie",
  "authorization",
  "x-agent-device-token",
  "content-length",
  "accept-encoding",
  "origin",
  "x-forwarded-host",
  "x-forwarded-proto",
]);

const handler = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const url = HttpServerRequest.toURL(request);
  if (Option.isNone(url)) return HttpServerResponse.text("Bad Request", { status: 400 });
  const path = url.value.pathname.slice(DeviceAgentAccess.AGENT_DEVICE_ROUTE_PREFIX.length);
  const allowed =
    request.method === "GET"
      ? /^\/(health|artifacts\/?|artifacts\/[^/]+|sessions\/[^/]+\/requests\/[^/]+\/diagnostics)$/.test(
          path,
        )
      : request.method === "POST"
        ? /^\/(rpc|upload|upload\/preflight|upload\/finalize)$/.test(path)
        : request.method === "PUT" && /^\/upload\/direct\/[^/]+$/.test(path);
  if (!allowed) return HttpServerResponse.text("Not Found", { status: 404 });
  const token =
    request.headers["x-agent-device-token"] ??
    request.headers.authorization?.replace(/^Bearer /i, "") ??
    "";
  const access = yield* DeviceAgentAccess.DeviceAgentAccess;
  const target = yield* access.authorize(token);
  if (path.startsWith("/sessions/") && path.split("/")[2] !== encodeURIComponent(target.session))
    return HttpServerResponse.text("Forbidden", { status: 403 });
  const devices = yield* DeviceService.DeviceService;
  const ready = yield* devices.agentReadinessIfSupported(target.hostId, true);
  if (!ready) return HttpServerResponse.text("Device agent is not running", { status: 503 });
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(request.headers)) {
    if (!DROPPED_HEADERS.has(name) && value !== undefined) headers[name] = value;
  }
  headers.authorization = `Bearer ${ready.agentDevice.token}`;
  headers["x-agent-device-token"] = ready.agentDevice.token;
  let upstream = HttpClientRequest.make(request.method)(
    `${ready.agentDevice.baseUrl.replace(/\/$/, "")}${path}${url.value.search}`,
  ).pipe(HttpClientRequest.setHeaders(headers));
  if (path === "/rpc") {
    const rpc = yield* decodeRpcRequest(yield* request.json);
    if (rpc.params.session !== target.session)
      return HttpServerResponse.text("Forbidden", { status: 403 });
    const flags = yield* decodeObject(rpc.params.flags ?? {});
    if (
      [flags.udid, flags.serial, flags.deviceId].some(
        (id) => id !== undefined && id !== target.deviceId,
      )
    )
      return HttpServerResponse.text("Forbidden", { status: 403 });
    upstream = yield* HttpClientRequest.bodyJson({
      ...rpc,
      params: { ...rpc.params, token: ready.agentDevice.token },
    })(upstream);
  } else if (request.method !== "GET") {
    upstream = upstream.pipe(HttpClientRequest.bodyStream(request.stream));
  }
  const client = HttpClient.withScope(yield* HttpClient.HttpClient);
  const response = yield* client.execute(upstream);
  if (path === "/upload/preflight" && response.status >= 200 && response.status < 300) {
    const descriptor = yield* decodeUploadDescriptor(yield* response.json);
    if (descriptor.upload) {
      const direct = new URL(descriptor.upload.url);
      if (!/^\/upload\/direct\/[^/]+$/.test(direct.pathname))
        return HttpServerResponse.text("Invalid upload descriptor", { status: 502 });
      const proxyUrl = new URL(
        `${DeviceAgentAccess.AGENT_DEVICE_ROUTE_PREFIX}${direct.pathname}`,
        url.value.origin,
      ).toString();
      return yield* HttpServerResponse.json({
        ...descriptor,
        upload: {
          url: proxyUrl,
          headers: {
            "content-type": descriptor.upload.headers["content-type"] ?? "application/octet-stream",
            authorization: `Bearer ${token}`,
            "x-agent-device-token": token,
          },
        },
      });
    }
    return yield* HttpServerResponse.json(descriptor);
  }
  const responseHeaders: Record<string, string> = { "cache-control": "no-store" };
  for (const name of ["content-type", "content-disposition", "range", "x-upload-offset"]) {
    const value = response.headers[name];
    if (value !== undefined) responseHeaders[name] = value;
  }
  return HttpServerResponse.stream(response.stream, {
    status: response.status,
    headers: responseHeaders,
  });
}).pipe(
  Effect.catchTags({
    DeviceAgentAccessDenied: () =>
      Effect.succeed(HttpServerResponse.text("Forbidden", { status: 403 })),
  }),
);

export const layer = HttpRouter.add(
  "*",
  `${DeviceAgentAccess.AGENT_DEVICE_ROUTE_PREFIX}/*`,
  handler,
);
