import {
  AuthAdministrativeScopes,
  AuthPairingCredentialResult,
  ExecutionEnvironmentDescriptor,
} from "@t3tools/contracts";
import { isPrivateNetworkHost } from "@t3tools/shared/hostClassification";
import { isLoopbackHost } from "@t3tools/shared/preview";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import { FetchHttpClient, HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";

export class PreviewHostingAuthError extends Schema.TaggedError<PreviewHostingAuthError>()(
  "PreviewHostingAuthError",
  {
    reason: Schema.Literals(["invalid_configuration", "bootstrap_failed"]),
    boundary: Schema.optional(
      Schema.Literals([
        "local_descriptor",
        "browser_descriptor",
        "environment_identity",
        "credential_issue",
      ]),
    ),
    // HTTP failures can retain authorization headers or a malformed credential response.
    cause: Schema.optional(Schema.Redacted(Schema.Defect(), { disallowJsonEncode: true })),
  },
) {
  override get message() {
    if (this.boundary === "browser_descriptor")
      return "The browser destination did not return a valid development environment descriptor. Relaunch the retained development recipe with --share and use its HTTPS destination for a remote desktop.";
    if (this.boundary === "local_descriptor")
      return "The owned local listener did not return a valid development environment descriptor. Check the retained recipe's local readiness URL before opening its shared HTTPS destination.";
    if (this.boundary === "environment_identity")
      return "The local listener and browser destination describe different development environments. Use the HTTPS destination produced by the retained recipe with --share.";
    if (this.boundary === "credential_issue")
      return "The owned development preview could not issue browser access. Check that the retained recipe still includes its configured development credential.";
    return "Could not prepare browser access to this development preview.";
  }
}

/** Called only after hosting has verified ownership and restored the exact local listener. */
export const prepareBrowserCredential = Effect.fn("PreviewHosting.prepareBrowserCredential")(
  function* (lease: {
    readonly browserAuth?: "t3-dev" | undefined;
    readonly url: string;
    readonly browserUrl?: string | undefined;
    readonly env?: Readonly<Record<string, string>> | undefined;
  }) {
    if (lease.browserAuth !== "t3-dev") return undefined;
    const token = lease.env?.T3CODE_DEV_AUTH_TOKEN;
    const url = new URL(lease.url);
    if (
      !token ||
      !isLoopbackHost(url.hostname) ||
      (url.protocol !== "http:" && url.protocol !== "https:") ||
      url.username !== "" ||
      url.password !== ""
    ) {
      return yield* new PreviewHostingAuthError({ reason: "invalid_configuration" });
    }
    const client = yield* HttpClient.HttpClient;
    const browserUrl = lease.browserUrl;
    if (browserUrl !== undefined) {
      const destination = yield* Effect.try({
        try: () => new URL(browserUrl),
        catch: () => new PreviewHostingAuthError({ reason: "invalid_configuration" }),
      });
      if (
        !isPrivateNetworkHost(destination.hostname) ||
        (destination.protocol !== "http:" && destination.protocol !== "https:") ||
        destination.username !== "" ||
        destination.password !== ""
      )
        return yield* new PreviewHostingAuthError({ reason: "invalid_configuration" });
      if (destination.origin !== url.origin) {
        // Within the trusted development network, this rejects accidental misrouting.
        // Copied userdata or spoofed public descriptors can share an ID; this is not authentication.
        const descriptors = yield* Effect.forEach(
          [
            { origin: url, boundary: "local_descriptor" as const },
            { origin: destination, boundary: "browser_descriptor" as const },
          ],
          ({ origin, boundary }) =>
            client
              .execute(HttpClientRequest.get(new URL("/.well-known/t3/environment", origin).href))
              .pipe(
                Effect.flatMap(HttpClientResponse.filterStatusOk),
                Effect.flatMap(HttpClientResponse.schemaBodyJson(ExecutionEnvironmentDescriptor)),
                Effect.timeout("5 seconds"),
                Effect.mapError(
                  (cause) =>
                    new PreviewHostingAuthError({
                      reason: "bootstrap_failed",
                      boundary,
                      cause: Redacted.make(cause),
                    }),
                ),
              ),
          { concurrency: 2 },
        ).pipe(
          // These probes never use the selected browser context or its profile cookies.
          Effect.provideService(FetchHttpClient.RequestInit, {
            redirect: "manual",
            credentials: "omit",
          }),
        );
        if (descriptors[0]!.environmentId !== descriptors[1]!.environmentId)
          return yield* new PreviewHostingAuthError({
            reason: "bootstrap_failed",
            boundary: "environment_identity",
          });
      }
    }
    const credential = yield* HttpClientRequest.post(
      new URL("/api/auth/pairing-token", url).toString(),
    ).pipe(
      HttpClientRequest.bearerToken(token),
      HttpClientRequest.bodyJson({
        label: "Managed development preview",
        scopes: AuthAdministrativeScopes,
      }),
      Effect.flatMap(client.execute),
      Effect.flatMap(HttpClientResponse.filterStatusOk),
      Effect.flatMap(HttpClientResponse.schemaBodyJson(AuthPairingCredentialResult)),
      // A listener redirect must never forward the retained administrative credential.
      Effect.provideService(FetchHttpClient.RequestInit, { redirect: "manual" }),
      Effect.timeout("5 seconds"),
      Effect.mapError(
        (cause) =>
          new PreviewHostingAuthError({
            reason: "bootstrap_failed",
            boundary: "credential_issue",
            cause: Redacted.make(cause),
          }),
      ),
    );
    return credential.credential;
  },
);
