import { AuthAdministrativeScopes, AuthPairingCredentialResult } from "@t3tools/contracts";
import { isLoopbackHost } from "@t3tools/shared/preview";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import { FetchHttpClient, HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";

export class PreviewHostingAuthError extends Schema.TaggedError<PreviewHostingAuthError>()(
  "PreviewHostingAuthError",
  {
    reason: Schema.Literals(["invalid_configuration", "bootstrap_failed"]),
    // HTTP failures can retain authorization headers or a malformed credential response.
    cause: Schema.optional(Schema.Redacted(Schema.Defect(), { disallowJsonEncode: true })),
  },
) {
  override get message() {
    return "Could not prepare browser access to this development preview.";
  }
}

/** Called only after hosting has verified ownership and restored the exact local listener. */
export const prepareBrowserCredential = Effect.fn("PreviewHosting.prepareBrowserCredential")(
  function* (lease: {
    readonly browserAuth?: "t3-dev" | undefined;
    readonly url: string;
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
          new PreviewHostingAuthError({ reason: "bootstrap_failed", cause: Redacted.make(cause) }),
      ),
    );
    return credential.credential;
  },
);
