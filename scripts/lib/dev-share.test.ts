import { assert, describe, it } from "@effect/vitest";
import * as NetService from "@t3tools/shared/Net";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { ChildProcessSpawner } from "effect/process";

import {
  type DevShareError,
  DevServeFailedError,
  DevServePortTakenError,
  shareDevServer,
  unshareDevServer,
} from "./dev-share.ts";

const TAILNET_STATUS = JSON.stringify({ Self: { DNSName: "host.example.ts.net." } });
const EMPTY_SERVE_STATUS = JSON.stringify({ TCP: {}, Web: {} });
const serveStatus = (proxy: string, mount = "/") =>
  JSON.stringify({
    TCP: { 5788: { HTTPS: true } },
    Web: { "host.example.ts.net:5788": { Handlers: { [mount]: { Proxy: proxy } } } },
  });

interface CallResult {
  readonly exitCode: number;
  readonly stderr?: string;
}

const encode = (value: string) => Stream.make(new TextEncoder().encode(value));

const serveStatusWithRoot = (webPort: number, proxy: string) =>
  JSON.stringify({
    TCP: { [webPort]: { HTTPS: true } },
    Web: { [`host.example.ts.net:${String(webPort)}`]: { Handlers: { "/": { Proxy: proxy } } } },
  });

/**
 * Answers the two status commands independently and lets each test set the
 * outcome of the mutating `off` and `serve` calls.
 */
const spawnerLayer = (input: {
  readonly off?: CallResult;
  readonly serve?: CallResult;
  readonly serveStatus?: CallResult & { readonly stdout?: string };
  readonly liveLoopbackPorts?: ReadonlyArray<number>;
  readonly calls?: Array<ReadonlyArray<string>>;
}) => {
  const live = new Set(input.liveLoopbackPorts ?? []);
  const unused = Effect.die("unused in dev-share tests");
  const net = Layer.succeed(NetService.NetService, {
    hasListenerOnHost: (port: number) => Effect.succeed(live.has(port)),
    canListenOnHost: () => unused,
    probeListenOnHost: () => unused,
    isPortAvailableOnLoopback: () => unused,
    reserveLoopbackPort: () => unused,
    findAvailablePort: () => unused,
  });
  const spawner = Layer.succeed(
    ChildProcessSpawner.ChildProcessSpawner,
    ChildProcessSpawner.make((command) => {
      const args = "args" in command ? (command.args as ReadonlyArray<string>) : [];
      input.calls?.push(args);
      const isTailnetStatus = args[0] === "status";
      const isServeStatus = args[0] === "serve" && args[1] === "status";
      const result: CallResult & { readonly stdout?: string } = isServeStatus
        ? (input.serveStatus ?? { exitCode: 0, stdout: EMPTY_SERVE_STATUS })
        : isTailnetStatus
          ? { exitCode: 0, stdout: TAILNET_STATUS }
          : args.includes("off")
            ? (input.off ?? { exitCode: 0 })
            : (input.serve ?? { exitCode: 0 });

      return Effect.succeed(
        ChildProcessSpawner.makeHandle({
          pid: ChildProcessSpawner.ProcessId(1),
          exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(result.exitCode)),
          isRunning: Effect.succeed(false),
          kill: () => Effect.void,
          unref: Effect.succeed(Effect.void),
          stdin: Sink.drain,
          stdout: result.stdout !== undefined ? encode(result.stdout) : Stream.empty,
          stderr: result.stderr ? encode(result.stderr) : Stream.empty,
          all: Stream.empty,
          getInputFd: () => Sink.drain,
          getOutputFd: () => Stream.empty,
        }),
      );
    }),
  );
  return Layer.merge(spawner, net);
};

describe("unshareDevServer", () => {
  it.effect("removes only the selected built-client target", () =>
    Effect.gen(function* () {
      const calls: Array<ReadonlyArray<string>> = [];
      const result = yield* unshareDevServer(5788, { port: 7733, host: "127.0.0.1" }).pipe(
        Effect.provide(
          spawnerLayer({
            calls,
            serveStatus: { exitCode: 0, stdout: serveStatus("http://127.0.0.1:7733") },
          }),
        ),
      );
      assert.isTrue(result.cleared);
      assert.deepEqual(calls, [
        ["serve", "status", "--json"],
        ["serve", "--https=5788", "--set-path=/", "off"],
      ]);
    }),
  );

  it.effect("treats a removed mapping as cleared", () =>
    Effect.gen(function* () {
      const result = yield* unshareDevServer(5788).pipe(
        Effect.provide(
          spawnerLayer({
            off: { exitCode: 0 },
            serveStatus: { exitCode: 0, stdout: serveStatus("http://127.0.0.1:5788") },
          }),
        ),
      );
      assert.isTrue(result.cleared);
    }),
  );

  it.effect("treats a missing handler as cleared", () =>
    Effect.gen(function* () {
      const result = yield* unshareDevServer(5788).pipe(Effect.provide(spawnerLayer({})));
      assert.isTrue(result.cleared);
    }),
  );

  it.effect("treats a handler removed before cleanup as cleared", () =>
    Effect.gen(function* () {
      const result = yield* unshareDevServer(5788).pipe(
        Effect.provide(
          spawnerLayer({
            off: {
              exitCode: 1,
              stderr: "error: failed to remove web serve: handler does not exist",
            },
            serveStatus: { exitCode: 0, stdout: serveStatus("http://127.0.0.1:5788") },
          }),
        ),
      );
      assert.isTrue(result.cleared);
    }),
  );

  it.effect("reports a genuine removal failure as not cleared", () =>
    Effect.gen(function* () {
      const result = yield* unshareDevServer(5788).pipe(
        Effect.provide(
          spawnerLayer({
            off: { exitCode: 1, stderr: "permission denied" },
            serveStatus: { exitCode: 0, stdout: serveStatus("http://127.0.0.1:5788") },
          }),
        ),
      );
      assert.isFalse(result.cleared);
      assert.include(result.explanation, "permission denied");
      assert.equal(result.cause?._tag, "TailscaleCommandExitError");
    }),
  );

  it.effect("does not remove another service's handler", () =>
    Effect.gen(function* () {
      const result = yield* unshareDevServer(5788).pipe(
        Effect.provide(
          spawnerLayer({
            serveStatus: { exitCode: 0, stdout: serveStatus("http://127.0.0.1:39831") },
          }),
        ),
      );
      assert.isFalse(result.cleared);
      assert.include(result.explanation, "different Tailscale Serve handler");
      assert.equal(result.cause?._tag, "TailscaleServePortOccupiedError");
    }),
  );
});

describe("shareDevServer", () => {
  it.effect("proxies to the shared loopback host Vite binds", () =>
    Effect.gen(function* () {
      const calls: Array<ReadonlyArray<string>> = [];
      yield* shareDevServer({ webPort: 5788 }).pipe(
        Effect.provide(spawnerLayer({ off: { exitCode: 0 }, calls })),
      );

      const serveCall = calls.find((args) => args.includes("--bg"));
      assert.deepEqual(serveCall, ["serve", "--bg", "--https=5788", "http://127.0.0.1:5788"]);
    }),
  );

  it.effect("publishes a built-client target under the selected web port", () =>
    Effect.gen(function* () {
      const calls: Array<ReadonlyArray<string>> = [];
      const result = yield* shareDevServer({
        webPort: 5788,
        localTarget: { port: 7733, host: "[::1]" },
      }).pipe(Effect.provide(spawnerLayer({ calls })));
      assert.equal(result.url, "https://host.example.ts.net:5788/");
      assert.deepEqual(calls, [
        ["status", "--json"],
        ["serve", "status", "--json"],
        ["serve", "status", "--json"],
        ["status", "--json"],
        ["serve", "status", "--json"],
        ["serve", "--bg", "--https=5788", "http://[::1]:7733"],
      ]);
    }),
  );

  it.effect("reports a serve failure without claiming another mapping was removed", () =>
    Effect.gen(function* () {
      const error: DevShareError = yield* shareDevServer({ webPort: 5788 }).pipe(
        Effect.provide(
          spawnerLayer({
            serve: { exitCode: 1, stderr: "port already in use" },
          }),
        ),
        Effect.flip,
      );

      assert.instanceOf(error, DevServeFailedError);
      assert.equal(error.webPort, 5788);
      assert.equal(
        (error.cause as { _tag?: string } | undefined)?._tag,
        "TailscaleCommandExitError",
      );
      assert.notInclude(error.message, "port already in use");
      assert.include(error.message, "run the command by hand");
      assert.notInclude(error.message, "cleared");
      assert.include(error.message, "5788");
    }),
  );

  it.effect("explains a recognized serve failure without quoting stderr", () =>
    Effect.gen(function* () {
      const error: DevShareError = yield* shareDevServer({ webPort: 5788 }).pipe(
        Effect.provide(
          spawnerLayer({
            serve: {
              exitCode: 1,
              stderr: "permission denied for tskey-auth-secret-token-value",
            },
          }),
        ),
        Effect.flip,
      );

      assert.instanceOf(error, DevServeFailedError);
      assert.equal(error.stage, "serve");
      assert.include(error.message, "permission denied");
      assert.include(error.message, "elevated privileges");
      assert.notInclude(error.message, "tskey-auth-secret-token-value");
    }),
  );

  it.effect("refuses to serve when the existing mapping could not be cleared", () =>
    Effect.gen(function* () {
      const error: DevShareError = yield* shareDevServer({ webPort: 5788 }).pipe(
        Effect.provide(
          spawnerLayer({
            off: { exitCode: 1, stderr: "permission denied" },
            serveStatus: { exitCode: 0, stdout: serveStatus("http://127.0.0.1:5788") },
          }),
        ),
        Effect.flip,
      );

      assert.instanceOf(error, DevServeFailedError);
      assert.equal(error.stage, "clear-existing");
      assert.include(error.message, "could not clear the existing mapping");
      assert.include(error.message, "permission denied");
    }),
  );

  it.effect("refuses to replace an occupied Serve port", () =>
    Effect.gen(function* () {
      const error: DevShareError = yield* shareDevServer({ webPort: 5788 }).pipe(
        Effect.provide(
          spawnerLayer({
            serveStatus: { exitCode: 0, stdout: serveStatus("http://127.0.0.1:39831", "/api") },
          }),
        ),
        Effect.flip,
      );

      assert.instanceOf(error, DevServeFailedError);
      assert.include(error.message, "different Tailscale Serve handler");
    }),
  );

  it.effect("leaves a mapping that another running server holds alone", () =>
    Effect.gen(function* () {
      const calls: Array<ReadonlyArray<string>> = [];
      const error: DevShareError = yield* shareDevServer({ webPort: 5788 }).pipe(
        Effect.provide(
          spawnerLayer({
            serveStatus: {
              exitCode: 0,
              stdout: serveStatusWithRoot(5788, "http://127.0.0.1:9555"),
            },
            liveLoopbackPorts: [9555],
            calls,
          }),
        ),
        Effect.flip,
      );

      assert.instanceOf(error, DevServePortTakenError);
      assert.isUndefined(calls.find((args) => args.includes("off") || args.includes("--bg")));
    }),
  );

  it.effect("replaces a mapping that dials a port nothing listens on", () =>
    Effect.gen(function* () {
      const calls: Array<ReadonlyArray<string>> = [];
      yield* shareDevServer({ webPort: 5788 }).pipe(
        Effect.provide(
          spawnerLayer({
            serveStatus: {
              exitCode: 0,
              stdout: serveStatusWithRoot(5788, "http://127.0.0.1:9555"),
            },
            calls,
          }),
        ),
      );

      assert.isDefined(calls.find((args) => args.includes("off")));
      assert.isDefined(calls.find((args) => args.includes("--bg")));
    }),
  );

  it.effect("leaves the port alone when its mapping cannot be read", () =>
    Effect.gen(function* () {
      const calls: Array<ReadonlyArray<string>> = [];
      const error: DevShareError = yield* shareDevServer({ webPort: 5788 }).pipe(
        Effect.provide(
          spawnerLayer({ serveStatus: { exitCode: 1, stderr: "permission denied" }, calls }),
        ),
        Effect.flip,
      );

      assert.instanceOf(error, DevServeFailedError);
      assert.equal(error.stage, "read-existing");
      assert.isUndefined(calls.find((args) => args.includes("off") || args.includes("--bg")));
    }),
  );
});
