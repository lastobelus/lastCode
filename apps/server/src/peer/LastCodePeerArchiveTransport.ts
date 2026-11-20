import {
  type EnvironmentId,
  PEER_ARCHIVE_ROUTE,
  PeerArchiveInventory,
  PeerArchiveInventoryInput,
  PeerArchiveUnavailable,
  type PeerLinkError,
  ProviderInteractionMode,
  RuntimeMode,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import {
  FetchHttpClient,
  HttpClient,
  HttpClientRequest,
  HttpRouter,
  HttpServerRequest,
  HttpServerResponse,
} from "effect/http";

import { McpClientAuthenticator } from "../mcp/McpHttpServer.ts";
import {
  type ClientModes,
  type McpClientCaller,
  MODE_LIMIT_HEADER,
  clientModeCeiling,
  withRuntimeModeCeiling,
} from "../mcp/McpInvocationContext.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import * as PeerLinks from "./PeerLinks.ts";

export class PeerArchiveHandler extends Context.Service<
  PeerArchiveHandler,
  {
    readonly inventory: (
      client: McpClientCaller,
      input: PeerArchiveInventoryInput,
    ) => Effect.Effect<PeerArchiveInventory, PeerArchiveUnavailable>;
  }
>()("t3/peer/LastCodePeerArchiveTransport/PeerArchiveHandler") {}

export class LastCodePeerArchiveTransport extends Context.Service<
  LastCodePeerArchiveTransport,
  {
    readonly inventory: (
      environmentId: EnvironmentId,
      input: PeerArchiveInventoryInput,
      limits?: ClientModes,
    ) => Effect.Effect<PeerArchiveInventory, PeerArchiveUnavailable>;
  }
>()("t3/peer/LastCodePeerArchiveTransport") {}

interface PeerArchivePost<Input, Output> {
  readonly path: `/${string}`;
  readonly input: Schema.Codec<Input, unknown>;
  readonly output: Schema.Codec<Output, unknown>;
}

const inventoryPost = {
  path: PEER_ARCHIVE_ROUTE,
  input: PeerArchiveInventoryInput,
  output: PeerArchiveInventory,
} satisfies PeerArchivePost<PeerArchiveInventoryInput, PeerArchiveInventory>;

const decodeModeLimit = Schema.decodeUnknownOption(
  Schema.Struct({ runtimeMode: RuntimeMode, interactionMode: ProviderInteractionMode }),
);

const noStore = { "cache-control": "no-store" };
const emptyResponse = (status: number) => HttpServerResponse.empty({ status, headers: noStore });
const unavailableStatus = 409;
const encodeUnavailable = HttpServerResponse.schemaJson(PeerArchiveUnavailable);

const peerArchivePostRoute = <Input, Output, Service>(
  post: PeerArchivePost<Input, Output>,
  handler: Effect.Effect<
    (client: McpClientCaller, input: Input) => Effect.Effect<Output, PeerArchiveUnavailable>,
    never,
    Service
  >,
) =>
  Layer.unwrap(
    Effect.gen(function* () {
      const auth = yield* McpClientAuthenticator;
      const settings = yield* ServerSettingsService;
      const handle = yield* handler;
      const decodeInput = HttpServerRequest.schemaBodyJson(post.input);
      const encodeOutput = HttpServerResponse.schemaJson(post.output);
      const linksEnabled = settings.getSettings.pipe(
        Effect.map(({ linkedEnvironmentsEnabled }) => linkedEnvironmentsEnabled),
        Effect.orElseSucceed(() => false),
      );
      return HttpRouter.add(
        "POST",
        post.path,
        Effect.gen(function* () {
          const request = yield* HttpServerRequest.HttpServerRequest;
          if (request.headers.origin !== undefined) return emptyResponse(403);
          const invocation = yield* auth.authenticate(request);
          if (invocation === undefined) return emptyResponse(401);
          const { client } = invocation;
          if (
            invocation.thread !== undefined ||
            client?.linked !== true ||
            client.access === "read-only" ||
            !invocation.capabilities.has("orchestration") ||
            !(yield* linksEnabled)
          ) {
            return emptyResponse(403);
          }

          let asked = client;
          const header = request.headers[MODE_LIMIT_HEADER];
          if (header !== undefined) {
            const [runtimeMode, interactionMode, ...rest] = header.trim().split("/");
            const limit = decodeModeLimit({ runtimeMode, interactionMode });
            if (rest.length !== 0 || Option.isNone(limit)) return emptyResponse(400);
            asked = { ...client, narrowedTo: limit.value };
          }
          const limited = withRuntimeModeCeiling(
            { ...invocation, client: asked },
            settings.managedPolicy?.limits?.maxRuntimeMode,
          );
          const input = yield* Effect.result(decodeInput);
          if (input._tag === "Failure") return emptyResponse(400);

          const admitted = { ...client, narrowedTo: clientModeCeiling(limited.client) };
          return yield* handle(admitted, input.success).pipe(
            Effect.matchEffect({
              onSuccess: (output) => encodeOutput(output, { headers: noStore }),
              onFailure: (error) =>
                encodeUnavailable(error, { status: unavailableStatus, headers: noStore }),
            }),
            Effect.orElseSucceed(() => emptyResponse(500)),
          );
        }),
      );
    }),
  );

export const routeLayer = peerArchivePostRoute(
  inventoryPost,
  PeerArchiveHandler.pipe(Effect.map((handler) => handler.inventory)),
);

const offline = { status: "pending", reason: "offline" } satisfies PeerArchiveUnavailable;
const denied = { status: "blocked", reason: "denied" } satisfies PeerArchiveUnavailable;
const unsupported = { status: "blocked", reason: "unsupported" } satisfies PeerArchiveUnavailable;
const unlinked = { status: "blocked", reason: "unlinked" } satisfies PeerArchiveUnavailable;
const changed = { status: "blocked", reason: "changed" } satisfies PeerArchiveUnavailable;

const fromLinkError = ({ reason }: PeerLinkError): PeerArchiveUnavailable => {
  switch (reason) {
    case "unknown_link":
    case "self":
      return unlinked;
    case "expired":
    case "pairing_rejected":
    case "disabled":
      return denied;
    case "incompatible":
    case "not_a_t3_environment":
      return unsupported;
    case "unreachable":
    case "storage":
      return offline;
  }
};

const decodeUnavailable = Schema.decodeUnknownEffect(Schema.fromJsonString(PeerArchiveUnavailable));

const makePeerArchivePost = (
  links: PeerLinks.PeerLinks["Service"],
  http: HttpClient.HttpClient,
) => {
  const client = HttpClient.withScope(http);
  return <Input, Output>(post: PeerArchivePost<Input, Output>) => {
    const encodeInput = HttpClientRequest.schemaBodyJson(post.input);
    const decodeOutput = Schema.decodeUnknownEffect(Schema.fromJsonString(post.output));
    return Effect.fn("LastCodePeerArchiveTransport.post")(function* (
      environmentId: EnvironmentId,
      input: Input,
      limits?: ClientModes,
    ) {
      if (!(yield* links.enabled)) return yield* Effect.fail(denied);
      const { url, token } = yield* links
        .resolve(environmentId, { refreshLabel: false })
        .pipe(Effect.mapError(fromLinkError));
      const request = yield* HttpClientRequest.post(`${url}${post.path}`).pipe(
        HttpClientRequest.acceptJson,
        HttpClientRequest.bearerToken(token),
        encodeInput(input),
        Effect.mapError(() => unsupported),
      );
      const limited =
        limits === undefined
          ? request
          : HttpClientRequest.setHeader(
              request,
              MODE_LIMIT_HEADER,
              `${limits.runtimeMode}/${limits.interactionMode}`,
            );

      return yield* Effect.gen(function* () {
        const response = yield* client.execute(limited).pipe(
          // The resolved origin is the only destination allowed to receive the credential.
          Effect.provideService(FetchHttpClient.RequestInit, { redirect: "manual" }),
          Effect.mapError(() => offline),
        );
        const { status } = response;
        if (status === 401 || status === 403) return yield* Effect.fail(denied);
        if (status === 408 || status === 429 || status >= 500) return yield* Effect.fail(offline);
        if (status !== 200 && status !== unavailableStatus) return yield* Effect.fail(unsupported);

        const body = yield* response.text.pipe(Effect.mapError(() => offline));
        if (status === unavailableStatus) {
          const unavailable = yield* decodeUnavailable(body).pipe(
            Effect.mapError(() => unsupported),
          );
          return yield* Effect.fail(unavailable);
        }
        return yield* decodeOutput(body).pipe(Effect.mapError(() => unsupported));
      }).pipe(Effect.scoped);
    });
  };
};

export const layer = Layer.effect(
  LastCodePeerArchiveTransport,
  Effect.gen(function* () {
    const links = yield* PeerLinks.PeerLinks;
    const http = yield* HttpClient.HttpClient;
    const inventory = makePeerArchivePost(links, http)(inventoryPost);
    return LastCodePeerArchiveTransport.of({
      inventory: Effect.fn("LastCodePeerArchiveTransport.inventory")(
        (environmentId: EnvironmentId, input: PeerArchiveInventoryInput, limits?: ClientModes) =>
          inventory(environmentId, input, limits).pipe(
            Effect.filterOrFail(
              (result) => result.environmentId === environmentId,
              () => changed,
            ),
            Effect.timeoutOrElse({ duration: "1 second", orElse: () => Effect.fail(offline) }),
          ),
      ),
    });
  }),
);
