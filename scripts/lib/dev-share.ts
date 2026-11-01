/** Vite proxies the backend, so only the web port needs a share mapping. */

import {
  buildTailscaleHttpsBaseUrl,
  disableTailscaleServe,
  ensureTailscaleServe,
  readTailscaleStatus,
  type TailscaleServeError,
  type TailscaleStderrDiagnostic,
} from "@t3tools/tailscale";
import { SHARED_DEV_LOOPBACK_HOST } from "@t3tools/shared/devProxy";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type { ChildProcessSpawner } from "effect/process";

/** Log fixed diagnostics; tailscale stderr can contain auth keys and node names. */
const DIAGNOSTIC_EXPLANATIONS: Record<TailscaleStderrDiagnostic, string | undefined> = {
  "no-existing-handler": "no mapping existed for that port",
  "not-logged-in": "this machine is not logged into a tailnet — run `tailscale up`",
  "permission-denied": "permission denied — `tailscale serve` may need elevated privileges",
  unknown: undefined,
};

/**
 * Our own wording for why a tailscale command failed, derived from the
 * classified diagnostic. Never the CLI's text — see `stderrDiagnosticOf`.
 */
const explainCommandFailure = (error: TailscaleServeError): string | undefined =>
  error._tag === "TailscaleCommandExitError" && error.stderrDiagnostic !== undefined
    ? (DIAGNOSTIC_EXPLANATIONS[error.stderrDiagnostic] ?? "run the command by hand to see why")
    : error._tag === "TailscaleServePortOccupiedError"
      ? "the port already belongs to a different Tailscale Serve handler"
      : undefined;

export class TailscaleUnavailableError extends Schema.TaggedError<TailscaleUnavailableError>()(
  "TailscaleUnavailableError",
  { cause: Schema.Defect() },
) {
  override get message(): string {
    return "could not talk to tailscale";
  }

  get hint(): string {
    return "Is Tailscale installed and tailscaled running? Try `tailscale status` — or drop --share and open the printed localhost URL.";
  }
}

export class TailnetNameMissingError extends Schema.TaggedError<TailnetNameMissingError>()(
  "TailnetNameMissingError",
  {},
) {
  override get message(): string {
    return "this machine has no tailnet DNS name";
  }

  get hint(): string {
    return "Run `tailscale up` and make sure MagicDNS is enabled.";
  }
}

export class DevServeFailedError extends Schema.TaggedError<DevServeFailedError>()(
  "DevServeFailedError",
  {
    webPort: Schema.Number,
    explanation: Schema.optional(Schema.String),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    const port = String(this.webPort);
    const base = `could not serve port ${port} on the tailnet`;
    return this.explanation ? `${base}: ${this.explanation}` : base;
  }

  get hint(): undefined {
    return undefined;
  }
}

export type DevShareError =
  | TailscaleUnavailableError
  | TailnetNameMissingError
  | DevServeFailedError;

/** Finalizer cleanup must be uninterruptible or cancellation can leave stale mappings. */
export const unshareDevServer = (
  webPort: number,
  localTarget?: { readonly port: number; readonly host: string },
): Effect.Effect<
  {
    readonly cleared: boolean;
    readonly explanation?: string | undefined;
    // Kept structured so a caller wrapping this can preserve the real error
    // chain rather than a flattened string.
    readonly cause?: TailscaleServeError | undefined;
  },
  never,
  ChildProcessSpawner.ChildProcessSpawner
> =>
  disableTailscaleServe({
    localHost: localTarget?.host ?? SHARED_DEV_LOOPBACK_HOST,
    localPort: localTarget?.port ?? webPort,
    servePort: webPort,
  }).pipe(
    Effect.as({ cleared: true } as const),
    Effect.catch((error: TailscaleServeError) =>
      Effect.succeed(
        error._tag === "TailscaleCommandExitError" &&
          error.stderrDiagnostic === "no-existing-handler"
          ? ({ cleared: true } as const)
          : ({
              cleared: false,
              ...(explainCommandFailure(error) !== undefined
                ? { explanation: explainCommandFailure(error) }
                : {}),
              cause: error,
            } as const),
      ),
    ),
    Effect.uninterruptible,
  );

export interface DevShareResult {
  readonly url: string;
  readonly host: string;
}

/**
 * Publishes `webPort` on the tailnet. The tailnet port always matches the web
 * port so the URL is stable; `localTarget` points it at the backend instead
 * when the backend serves a built client (`--built`).
 */
export const shareDevServer = Effect.fn("devShare.shareDevServer")(function* (input: {
  readonly webPort: number;
  readonly localTarget?: { readonly port: number; readonly host: string };
}) {
  const status = yield* readTailscaleStatus.pipe(
    Effect.mapError((error) => new TailscaleUnavailableError({ cause: error })),
  );
  if (status.magicDnsName === null) {
    return yield* new TailnetNameMissingError();
  }

  yield* ensureTailscaleServe({
    localPort: input.localTarget?.port ?? input.webPort,
    servePort: input.webPort,
    localHost: input.localTarget?.host ?? SHARED_DEV_LOOPBACK_HOST,
  }).pipe(
    Effect.mapError((error) => {
      const explanation = explainCommandFailure(error);
      return new DevServeFailedError({
        webPort: input.webPort,
        ...(explanation !== undefined ? { explanation } : {}),
        cause: error,
      });
    }),
  );

  return {
    url: buildTailscaleHttpsBaseUrl({
      magicDnsName: status.magicDnsName,
      servePort: input.webPort,
    }),
    host: status.magicDnsName,
  } satisfies DevShareResult;
});
