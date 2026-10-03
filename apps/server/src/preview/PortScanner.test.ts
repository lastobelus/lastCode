// @effect-diagnostics nodeBuiltinImport:off - This fixture exercises a real self-signed Node TLS server and certificate files.
import * as NodeNet from "node:net";
import * as NodeHttps from "node:https";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeChildProcess from "node:child_process";

import { it as effectIt } from "@effect/vitest";
import {
  CONFIGURED_LOCAL_SERVER_URLS_MAX_ITEMS,
  PREVIEW_URL_MAX_LENGTH,
  type DiscoveredLocalServer,
} from "@t3tools/contracts";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Net from "@t3tools/shared/Net";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as PlatformError from "effect/PlatformError";
import * as Scope from "effect/Scope";
import * as TestClock from "effect/testing/TestClock";
import * as Tracer from "effect/Tracer";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import { expect } from "vite-plus/test";
import { FetchHttpClient, HttpClient } from "effect/unstable/http";

import * as ProcessRunner from "../processRunner.ts";
import * as PortScanner from "./PortScanner.ts";
const processProbeFailure: ProcessRunner.ProcessRunner["Service"]["run"] = (input) =>
  Effect.fail(
    new ProcessRunner.ProcessSpawnError({
      command: input.command,
      argumentCount: input.args.length,
      cwd: input.cwd,
      cause: PlatformError.systemError({
        _tag: "NotFound",
        module: "ChildProcess",
        method: "spawn",
        description: "PowerShell is not installed in the test environment",
      }),
    }),
  );

const TestProcessRunner = Layer.succeed(ProcessRunner.ProcessRunner, {
  run: processProbeFailure,
});

let integrationListeningPort: number | null = null;

const TestIntegrationNet = Layer.succeed(Net.NetService, {
  canListenOnHost: () => Effect.succeed(true),
  isPortAvailableOnLoopback: (port) => Effect.sync(() => port !== integrationListeningPort),
  hasListenerOnHost: (port) => Effect.sync(() => port === integrationListeningPort),
  reserveLoopbackPort: () => Effect.succeed(40_000),
  findAvailablePort: (preferred) => Effect.succeed(preferred),
});

const makeProbeFailureLayer = (
  run: ProcessRunner.ProcessRunner["Service"]["run"],
  fetch: typeof globalThis.fetch = globalThis.fetch,
) =>
  PortScanner.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.succeed(ProcessRunner.ProcessRunner, { run }),
        Layer.succeed(Net.NetService, {
          canListenOnHost: () => Effect.succeed(true),
          isPortAvailableOnLoopback: () => Effect.succeed(true),
          hasListenerOnHost: () => Effect.succeed(false),
          reserveLoopbackPort: () => Effect.succeed(40_000),
          findAvailablePort: (preferred) => Effect.succeed(preferred),
        }),
        Layer.succeed(HostProcessPlatform, "linux"),
        FetchHttpClient.layer.pipe(Layer.provide(Layer.succeed(FetchHttpClient.Fetch, fetch))),
      ),
    ),
  );

const TestPortDiscoveryLive = PortScanner.layer.pipe(
  Layer.provide(
    Layer.mergeAll(
      TestProcessRunner,
      TestIntegrationNet,
      Layer.succeed(HostProcessPlatform, "win32"),
      FetchHttpClient.layer,
    ),
  ),
);

const LSOF_TEST_PORT = 43_123;

const makeLsofScannerLayer = (input: {
  readonly pid: () => number;
  readonly output?: () => string;
  readonly run?: ProcessRunner.ProcessRunner["Service"]["run"];
  readonly platform?: "linux" | "win32";
  readonly fetch: typeof globalThis.fetch;
}) =>
  PortScanner.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.succeed(ProcessRunner.ProcessRunner, {
          run:
            input.run ??
            (() =>
              Effect.succeed({
                stdout: input.output?.() ?? `p${input.pid()}\ncnode\nn*:${LSOF_TEST_PORT}\n`,
                stderr: "",
                code: ChildProcessSpawner.ExitCode(0),
                timedOut: false,
                stdoutTruncated: false,
                stderrTruncated: false,
                stdoutInvalidUtf8: false,
                stderrInvalidUtf8: false,
              })),
        }),
        Layer.succeed(Net.NetService, {
          canListenOnHost: () => Effect.succeed(true),
          isPortAvailableOnLoopback: () => Effect.succeed(true),
          hasListenerOnHost: () => Effect.succeed(false),
          reserveLoopbackPort: () => Effect.succeed(40_000),
          findAvailablePort: (preferred) => Effect.succeed(preferred),
        }),
        Layer.succeed(HostProcessPlatform, input.platform ?? "linux"),
        FetchHttpClient.layer.pipe(
          Layer.provide(Layer.succeed(FetchHttpClient.Fetch, input.fetch)),
        ),
      ),
    ),
  );

const makeLinuxSsScannerLayer = (input: {
  readonly ssOutput: string;
  readonly fetch: typeof globalThis.fetch;
}) =>
  PortScanner.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.succeed(ProcessRunner.ProcessRunner, {
          run: (request) =>
            request.command === "lsof"
              ? processProbeFailure(request)
              : Effect.succeed({
                  stdout: input.ssOutput,
                  stderr: "",
                  code: null,
                  timedOut: false,
                  stdoutTruncated: false,
                  stderrTruncated: false,
                  stdoutInvalidUtf8: false,
                  stderrInvalidUtf8: false,
                }),
        }),
        Layer.succeed(Net.NetService, {
          canListenOnHost: () => Effect.succeed(true),
          isPortAvailableOnLoopback: () => Effect.succeed(true),
          hasListenerOnHost: () => Effect.succeed(false),
          reserveLoopbackPort: () => Effect.succeed(40_000),
          findAvailablePort: (preferred) => Effect.succeed(preferred),
        }),
        Layer.succeed(HostProcessPlatform, "linux"),
        FetchHttpClient.layer.pipe(
          Layer.provide(Layer.succeed(FetchHttpClient.Fetch, input.fetch)),
        ),
      ),
    ),
  );

const openServer = (
  port: number,
  onConnection: (socket: NodeNet.Socket) => void,
): Effect.Effect<NodeNet.Server | null> =>
  Effect.callback((resume) => {
    const server = NodeNet.createServer(onConnection);
    server.once("error", () => {
      resume(Effect.succeed(null));
    });
    server.listen(port, "127.0.0.1", () => {
      resume(Effect.succeed(server));
    });
    return Effect.sync(() => {
      server.close();
    });
  });

const closeServer = (server: NodeNet.Server): Effect.Effect<void> =>
  Effect.callback((resume) => {
    server.close(() => resume(Effect.void));
  });

const openCommonDevServer = Effect.fn("PortScannerTest.openCommonDevServer")(function* (
  ports: ReadonlyArray<number>,
  onConnection: (socket: NodeNet.Socket) => void,
) {
  for (const port of ports) {
    const server = yield* openServer(port, onConnection);
    if (server !== null) return { port, server };
  }
  return yield* Effect.die(
    new Error("No common development port was available for the preview scanner test"),
  );
});

const commonDevServer = Effect.acquireRelease(
  openCommonDevServer(PortScanner.COMMON_DEV_PORTS, (socket) => {
    socket.once("data", () => {
      socket.end("HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nContent-Length: 5\r\n\r\nhello");
    });
  }).pipe(
    Effect.tap(({ port }) =>
      Effect.sync(() => {
        integrationListeningPort = port;
      }),
    ),
  ),
  ({ server }) =>
    closeServer(server).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          integrationListeningPort = null;
        }),
      ),
    ),
);

const commonNonHttpServer = Effect.acquireRelease(
  openCommonDevServer(PortScanner.COMMON_DEV_PORTS.toReversed(), (socket) => {
    socket.on("error", () => undefined);
    socket.once("data", () => socket.end("MYSQL\r\n\r\n"));
  }).pipe(
    Effect.tap(({ port }) =>
      Effect.sync(() => {
        integrationListeningPort = port;
      }),
    ),
  ),
  ({ server }) =>
    closeServer(server).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          integrationListeningPort = null;
        }),
      ),
    ),
);

effectIt.effect("attributes an owned listener from ss when Linux has no lsof", () => {
  const port = 63_123;
  const threadId = "thread-owned-preview";
  const terminalId = "terminal-owned-preview";
  const processId = 51_321;
  const url = `http://localhost:${port}/preview/index.html`;
  const layer = makeLinuxSsScannerLayer({
    ssOutput: `LISTEN 0 128 127.0.0.1:${port} 0.0.0.0:* users:(("node",pid=${processId},fd=18))\n`,
    fetch: async () => new Response("preview", { headers: { "content-type": "text/html" } }),
  });

  return Effect.gen(function* () {
    const scanner = yield* PortScanner.PortDiscovery;
    yield* scanner.registerTerminalProcesses({ threadId, terminalId, processIds: [processId] });
    const found = yield* scanner.scan([url]);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({
      port,
      url,
      pid: processId,
      terminal: { threadId, terminalId },
    });
  }).pipe(Effect.provide(layer));
});

effectIt.effect("leaves foreign and unattributed ss listeners without terminal ownership", () => {
  const foreignPort = 63_124;
  const unattributedPort = 63_125;
  const sharedPort = 63_126;
  const foreignProcessId = 61_001;
  const url = `http://localhost:${foreignPort}/preview`;
  const layer = makeLinuxSsScannerLayer({
    ssOutput: [
      `LISTEN 0 128 127.0.0.1:${foreignPort} 0.0.0.0:* users:(("node",pid=${foreignProcessId},fd=9))`,
      `LISTEN 0 128 127.0.0.1:${unattributedPort} 0.0.0.0:*`,
      `LISTEN 0 128 127.0.0.1:${sharedPort} 0.0.0.0:* users:(("node",pid=61002,fd=10))`,
      `LISTEN 0 128 127.0.0.1:${sharedPort} 0.0.0.0:* users:(("node",pid=61003,fd=11))`,
    ].join("\n"),
    fetch: async () => new Response("preview", { headers: { "content-type": "text/html" } }),
  });

  return Effect.gen(function* () {
    const scanner = yield* PortScanner.PortDiscovery;
    yield* scanner.registerTerminalProcesses({
      threadId: "thread-owned-preview",
      terminalId: "terminal-owned-preview",
      processIds: [61_002],
    });
    const found = yield* scanner.scan([
      url,
      `http://localhost:${unattributedPort}/preview`,
      `http://localhost:${sharedPort}/preview`,
    ]);
    expect(found).toHaveLength(3);
    expect(found.find((server) => server.port === foreignPort)?.terminal).toBeNull();
    expect(found.find((server) => server.port === unattributedPort)?.terminal).toBeNull();
    expect(found.find((server) => server.port === sharedPort)?.terminal).toBeNull();
  }).pipe(Effect.provide(layer));
});

effectIt.effect("requires every lsof listener on a port to have the same terminal owner", () => {
  const port = 63_127;
  const ownedProcessId = 62_001;
  const foreignProcessId = 62_002;
  const layer = makeLsofScannerLayer({
    pid: () => ownedProcessId,
    output: () =>
      [
        `p${ownedProcessId}`,
        "cnode",
        `n*:${port}`,
        `p${foreignProcessId}`,
        "cpython",
        `n[::1]:${port}`,
      ].join("\n"),
    fetch: async () => new Response("preview", { headers: { "content-type": "text/html" } }),
  });

  return Effect.gen(function* () {
    const scanner = yield* PortScanner.PortDiscovery;
    yield* scanner.registerTerminalProcesses({
      threadId: "thread-owned-preview",
      terminalId: "terminal-owned-preview",
      processIds: [ownedProcessId],
    });
    const found = yield* scanner.scan([`http://localhost:${port}/preview`]);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ port, pid: null, terminal: null });
  }).pipe(Effect.provide(layer));
});

effectIt.effect("requires every Windows listener on a port to have the same terminal owner", () => {
  const port = 63_128;
  const ownedProcessId = 62_011;
  const foreignProcessId = 62_012;
  const layer = makeLsofScannerLayer({
    pid: () => ownedProcessId,
    platform: "win32",
    output: () =>
      [`127.0.0.1|${port}|${ownedProcessId}|node`, `::1|${port}|${foreignProcessId}|python`].join(
        "\n",
      ),
    fetch: async () => new Response("preview", { headers: { "content-type": "text/html" } }),
  });

  return Effect.gen(function* () {
    const scanner = yield* PortScanner.PortDiscovery;
    yield* scanner.registerTerminalProcesses({
      threadId: "thread-owned-preview",
      terminalId: "terminal-owned-preview",
      processIds: [ownedProcessId],
    });
    const found = yield* scanner.scan([`http://localhost:${port}/preview`]);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ port, pid: null, terminal: null });
  }).pipe(Effect.provide(layer));
});

const windowsProbeResult = (stdout: string): ProcessRunner.ProcessRunOutput => ({
  stdout,
  stderr: "",
  code: ChildProcessSpawner.ExitCode(0),
  timedOut: false,
  stdoutTruncated: false,
  stderrTruncated: false,
  stdoutInvalidUtf8: false,
  stderrInvalidUtf8: false,
});

for (const failure of ["spawn", "exit", "timeout", "truncated", "invalid-utf8"] as const) {
  effectIt.effect(
    `attributes Windows netstat listeners after PowerShell ${failure} failure`,
    () => {
      const port = 63_129;
      const processId = 62_021;
      const url = `http://localhost:${port}/preview`;
      const commands: string[] = [];
      const layer = makeLsofScannerLayer({
        pid: () => processId,
        platform: "win32",
        run: (request) => {
          commands.push(request.command);
          if (request.command === "powershell.exe") {
            if (failure === "spawn") return processProbeFailure(request);
            return Effect.succeed({
              ...windowsProbeResult(""),
              code: ChildProcessSpawner.ExitCode(failure === "exit" ? 1 : 0),
              timedOut: failure === "timeout",
              stdoutTruncated: failure === "truncated",
              stdoutInvalidUtf8: failure === "invalid-utf8",
            });
          }
          expect(request.command).toBe("netstat.exe");
          expect(request.args).toEqual(["-ano"]);
          return Effect.succeed(
            windowsProbeResult(
              [
                "Active Connections",
                "  Proto  Local Address  Foreign Address  State  PID",
                `  TCP  0.0.0.0:${port}  0.0.0.0:0  LISTENING  ${processId}`,
                `  TCP  [::]:${port}  [::]:0  LISTENING  ${processId}`,
                `  TCP  127.0.0.1:63130  127.0.0.1:50000  ESTABLISHED  ${processId}`,
                `  UDP  0.0.0.0:63131  *:*  ${processId}`,
                `  TCP  192.0.2.1:63132  0.0.0.0:0  LISTENING  ${processId}`,
                `  TCP  127.0.0.1:65536  0.0.0.0:0  LISTENING  ${processId}`,
              ].join("\r\n"),
            ),
          );
        },
        fetch: async () => new Response("preview", { headers: { "content-type": "text/html" } }),
      });

      return Effect.gen(function* () {
        const scanner = yield* PortScanner.PortDiscovery;
        const owner = { threadId: "thread-owned-preview", terminalId: "terminal-owned-preview" };
        yield* scanner.registerTerminalProcesses({ ...owner, processIds: [processId] });
        expect(yield* scanner.scan([url])).toEqual([
          { host: "localhost", port, url, pid: processId, processName: null, terminal: owner },
        ]);
        expect(commands).toEqual(["powershell.exe", "netstat.exe"]);
      }).pipe(Effect.provide(layer));
    },
  );
}

effectIt.effect("requires all Windows netstat listener processes to belong to the terminal", () => {
  const layer = makeLsofScannerLayer({
    pid: () => 62_031,
    platform: "win32",
    run: (request) =>
      request.command === "powershell.exe"
        ? processProbeFailure(request)
        : Effect.succeed(
            windowsProbeResult(
              [
                "TCP 127.0.0.1:63133 0.0.0.0:0 LISTENING 62031",
                "TCP [::1]:63133 [::]:0 LISTENING 62032",
                "TCP 127.0.0.1:63134 0.0.0.0:0 LISTENING 62031",
                "TCP [::]:63134 [::]:0 LISTENING 62033",
                "TCP 127.0.0.1:63135 0.0.0.0:0 LISTENING 62031",
                "TCP [::]:63135 [::]:0 LISTENING 0",
                "TCP [::1]:63136 [::]:0 LISTENING 62033",
              ].join("\n"),
            ),
          ),
    fetch: async () => new Response("preview", { headers: { "content-type": "text/html" } }),
  });
  return Effect.gen(function* () {
    const scanner = yield* PortScanner.PortDiscovery;
    const owner = { threadId: "thread-owned-preview", terminalId: "terminal-owned-preview" };
    yield* scanner.registerTerminalProcesses({ ...owner, processIds: [62_031, 62_032] });
    const found = yield* scanner.scan();
    expect(found.map(({ port, pid, terminal }) => ({ port, pid, terminal }))).toEqual([
      { port: 63_133, pid: null, terminal: owner },
      { port: 63_134, pid: null, terminal: null },
      { port: 63_135, pid: 62_031, terminal: null },
      { port: 63_136, pid: 62_033, terminal: null },
    ]);
  }).pipe(Effect.provide(layer));
});

effectIt.effect("does not claim ownership from truncated Windows netstat output", () => {
  const port = 63_137;
  const layer = makeLsofScannerLayer({
    pid: () => 62_041,
    platform: "win32",
    run: (request) =>
      request.command === "powershell.exe"
        ? processProbeFailure(request)
        : Effect.succeed({
            ...windowsProbeResult(`TCP 127.0.0.1:${port} 0.0.0.0:0 LISTENING 62041`),
            stdoutTruncated: true,
          }),
    fetch: async () => new Response("preview", { headers: { "content-type": "text/html" } }),
  });
  return Effect.gen(function* () {
    const scanner = yield* PortScanner.PortDiscovery;
    yield* scanner.registerTerminalProcesses({
      threadId: "thread-owned-preview",
      terminalId: "terminal-owned-preview",
      processIds: [62_041],
    });
    const found = yield* scanner.scan([`http://localhost:${port}/preview`]);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ port, pid: null, terminal: null });
  }).pipe(Effect.provide(layer));
});

/**
 * Integration tests against a real TCP listener. We provide the Windows host
 * platform so the tests exercise the TCP-probe fallback without depending on
 * `lsof` being installed.
 */
effectIt.layer(TestPortDiscoveryLive)("PortDiscovery integration (TCP probe fallback)", (it) => {
  it.effect(
    "scan() returns an HTTP server we just opened on a curated dev port",
    Effect.fn("PortScannerTest.scanFindsCommonDevServer")(function* () {
      const { port } = yield* commonDevServer;
      const scanner = yield* PortScanner.PortDiscovery;
      const result = yield* scanner.scan();
      const found = result.find((server) => server.port === port);
      expect(found).toBeDefined();
      expect(found?.host).toBe("localhost");
    }),
  );

  it.effect(
    "scan() excludes a listening port that does not speak HTTP",
    Effect.fn("PortScannerTest.scanExcludesNonHttpServer")(function* () {
      const { port } = yield* commonNonHttpServer;
      const scanner = yield* PortScanner.PortDiscovery;
      const result = yield* scanner.scan();
      expect(result.some((server) => server.port === port)).toBe(false);
    }),
  );

  it.effect(
    "retain drives an immediate broadcast to subscribers",
    Effect.fn("PortScannerTest.retainBroadcastsImmediately")(function* () {
      const { port } = yield* commonDevServer;
      const received: number[] = [];
      const scanner = yield* PortScanner.PortDiscovery;
      yield* scanner.subscribe({ configuredUrls: [], initialSnapshot: [] }, (servers) =>
        Effect.sync(() => {
          for (const server of servers) received.push(server.port);
        }),
      );
      yield* scanner.retain;
      expect(received).toContain(port);
    }),
  );
});

effectIt.effect("revalidates a successful HTML probe after its cache entry expires", () => {
  let responds = true;
  const requests: string[] = [];
  const fetchFn = ((input: Parameters<typeof globalThis.fetch>[0]) => {
    requests.push(String(input));
    return responds
      ? Promise.resolve(new Response("hello", { headers: { "content-type": "text/html" } }))
      : Promise.reject(new TypeError("not HTTP"));
  }) as typeof globalThis.fetch;
  const layer = makeLsofScannerLayer({ pid: () => 1234, fetch: fetchFn });

  return Effect.gen(function* () {
    const scanner = yield* PortScanner.PortDiscovery;
    expect(yield* scanner.scan()).toHaveLength(1);
    expect(yield* scanner.scan()).toHaveLength(1);
    expect(requests).toEqual([`http://localhost:${LSOF_TEST_PORT}/`]);

    responds = false;
    yield* TestClock.adjust(Duration.seconds(15));
    expect(yield* scanner.scan()).toHaveLength(0);
    expect(requests).toEqual([
      `http://localhost:${LSOF_TEST_PORT}/`,
      `http://localhost:${LSOF_TEST_PORT}/`,
      `https://localhost:${LSOF_TEST_PORT}/`,
    ]);
  }).pipe(Effect.provide(layer));
});

effectIt.effect("keeps a full configured URL when the discovered server root fails", () => {
  const requests: string[] = [];
  const configuredUrl = `http://localhost:${LSOF_TEST_PORT}/docs`;
  const fetchFn = ((input: Parameters<typeof globalThis.fetch>[0]) => {
    const url = String(input);
    requests.push(url);
    return Promise.resolve(
      url === configuredUrl
        ? new Response("docs", { headers: { "content-type": "text/html" } })
        : new Response("not found", {
            status: 404,
            headers: { "content-type": "text/html" },
          }),
    );
  }) as typeof globalThis.fetch;
  const layer = makeLsofScannerLayer({ pid: () => 1234, fetch: fetchFn });

  return Effect.gen(function* () {
    const scanner = yield* PortScanner.PortDiscovery;
    const servers = yield* scanner.scan([configuredUrl]);
    expect(servers).toHaveLength(1);
    expect(servers[0]?.url).toBe(configuredUrl);
    expect(requests).toContain(configuredUrl);
  }).pipe(Effect.provide(layer));
});

for (const contentType of ["image/png", "application/pdf", "video/mp4"]) {
  effectIt.effect(`publishes an owned configured ${contentType} resource as ready`, () => {
    const configuredUrl = `http://localhost:${LSOF_TEST_PORT}/media`;
    const layer = makeLsofScannerLayer({
      pid: () => 1234,
      fetch: async () => new Response("media", { headers: { "content-type": contentType } }),
    });
    return Effect.gen(function* () {
      const scanner = yield* PortScanner.PortDiscovery;
      yield* scanner.registerTerminalProcesses({
        threadId: "media-thread",
        terminalId: "media-terminal",
        processIds: [1234],
      });
      const ready = yield* Deferred.make<ReadonlyArray<DiscoveredLocalServer>>();
      yield* scanner.subscribe(
        { configuredUrls: [configuredUrl], initialSnapshot: [] },
        (servers) => Deferred.succeed(ready, servers).pipe(Effect.asVoid),
      );
      yield* scanner.retain;
      expect(yield* Deferred.await(ready)).toMatchObject([
        {
          url: configuredUrl,
          terminal: { threadId: "media-thread", terminalId: "media-terminal" },
        },
      ]);
      // The same cached response does not turn a media server root into an automatically discovered document.
      expect(yield* scanner.scan()).toEqual([]);
      expect(yield* scanner.scan([configuredUrl])).toHaveLength(1);
    }).pipe(Effect.provide(layer), Effect.scoped);
  });
}

effectIt.effect("rejects failed or empty configured resource responses", () => {
  let status = 404;
  let pid = 1234;
  const layer = makeLsofScannerLayer({
    pid: () => pid,
    fetch: async () =>
      new Response(status === 404 ? "missing" : null, {
        status,
        headers: { "content-type": "image/png" },
      }),
  });
  return Effect.gen(function* () {
    const scanner = yield* PortScanner.PortDiscovery;
    for (const nextStatus of [404, 204, 205]) {
      status = nextStatus;
      pid++;
      expect(yield* scanner.scan([`http://localhost:${LSOF_TEST_PORT}/media`])).toEqual([]);
    }
  }).pipe(Effect.provide(layer));
});

effectIt.effect("probes configured custom ports through a canonical loopback host", () => {
  const customPort = 43_124;
  const configuredUrl = `http://0.0.0.0:${customPort}/docs`;
  const expectedUrl = `http://localhost:${customPort}/docs`;
  const requests: string[] = [];
  const fetchFn = ((input: Parameters<typeof globalThis.fetch>[0]) => {
    requests.push(String(input));
    return Promise.resolve(new Response("docs", { headers: { "content-type": "text/html" } }));
  }) as typeof globalThis.fetch;
  const layer = makeProbeFailureLayer(processProbeFailure, fetchFn);

  return Effect.gen(function* () {
    const scanner = yield* PortScanner.PortDiscovery;
    const servers = yield* scanner.scan([configuredUrl]);
    expect(servers).toHaveLength(1);
    expect(servers[0]?.host).toBe("localhost");
    expect(servers[0]?.port).toBe(customPort);
    expect(servers[0]?.url).toBe(expectedUrl);
    expect(requests).toEqual([expectedUrl]);
  }).pipe(Effect.provide(layer));
});

effectIt.effect("preserves explicit loopback hosts and bounds wildcard rewrites", () => {
  const ipv4Url = "https://127.0.0.1:43125/docs";
  const ipv6Url = "http://[::1]:43126/docs";
  const wildcardPrefix = "http://0.0.0.0/";
  const maximumWildcardUrl = `${wildcardPrefix}${"a".repeat(
    PREVIEW_URL_MAX_LENGTH - wildcardPrefix.length,
  )}`;
  const requests: string[] = [];
  const fetchFn = ((input: Parameters<typeof globalThis.fetch>[0]) => {
    requests.push(String(input));
    return Promise.resolve(new Response("docs", { headers: { "content-type": "text/html" } }));
  }) as typeof globalThis.fetch;
  const layer = makeProbeFailureLayer(processProbeFailure, fetchFn);

  return Effect.gen(function* () {
    const scanner = yield* PortScanner.PortDiscovery;
    const servers = yield* scanner.scan([ipv4Url, ipv6Url, maximumWildcardUrl]);
    expect(servers.map((server) => server.url)).toEqual([ipv4Url, ipv6Url]);
    expect(requests).toEqual([ipv4Url, ipv6Url]);
  }).pipe(Effect.provide(layer));
});

effectIt.effect("projects configured paths independently for simultaneous subscribers", () => {
  const docsUrl = `http://localhost:${LSOF_TEST_PORT}/docs`;
  const adminUrl = `http://localhost:${LSOF_TEST_PORT}/admin`;
  const fetchFn = ((input: Parameters<typeof globalThis.fetch>[0]) => {
    const url = String(input);
    return Promise.resolve(
      url === docsUrl || url === adminUrl
        ? new Response("app", { headers: { "content-type": "text/html" } })
        : new Response("not found", { status: 404 }),
    );
  }) as typeof globalThis.fetch;
  const layer = makeLsofScannerLayer({ pid: () => 1234, fetch: fetchFn });

  return Effect.gen(function* () {
    const scanner = yield* PortScanner.PortDiscovery;
    const docsSnapshots: ReadonlyArray<DiscoveredLocalServer>[] = [];
    const adminSnapshots: ReadonlyArray<DiscoveredLocalServer>[] = [];
    yield* scanner.subscribe({ configuredUrls: [docsUrl], initialSnapshot: [] }, (servers) =>
      Effect.sync(() => docsSnapshots.push(servers)),
    );
    yield* scanner.subscribe({ configuredUrls: [adminUrl], initialSnapshot: [] }, (servers) =>
      Effect.sync(() => adminSnapshots.push(servers)),
    );
    yield* scanner.retain;

    expect(docsSnapshots.at(-1)?.[0]?.url).toBe(docsUrl);
    expect(adminSnapshots.at(-1)?.[0]?.url).toBe(adminUrl);
  }).pipe(Effect.scoped, Effect.provide(layer));
});

effectIt.effect(
  "keeps each subscriber's candidates when their combined union exceeds the per-client cap",
  () => {
    const firstSubscriberUrls = Array.from(
      { length: CONFIGURED_LOCAL_SERVER_URLS_MAX_ITEMS },
      (_, index) => `http://localhost:${LSOF_TEST_PORT}/app-${index}`,
    );
    const secondSubscriberUrl = `http://localhost:${LSOF_TEST_PORT}/app-${CONFIGURED_LOCAL_SERVER_URLS_MAX_ITEMS}`;
    const fetchFn = ((input: Parameters<typeof globalThis.fetch>[0]) =>
      Promise.resolve(
        String(input) === secondSubscriberUrl
          ? new Response("app", { headers: { "content-type": "text/html" } })
          : new Response("not found", { status: 404 }),
      )) as typeof globalThis.fetch;
    const layer = makeLsofScannerLayer({ pid: () => 1234, fetch: fetchFn });

    return Effect.gen(function* () {
      const scanner = yield* PortScanner.PortDiscovery;
      const secondSnapshots: ReadonlyArray<DiscoveredLocalServer>[] = [];
      yield* scanner.subscribe(
        { configuredUrls: firstSubscriberUrls, initialSnapshot: [] },
        () => Effect.void,
      );
      yield* scanner.subscribe(
        { configuredUrls: [secondSubscriberUrl], initialSnapshot: [] },
        (servers) => Effect.sync(() => secondSnapshots.push(servers)),
      );
      yield* scanner.retain;

      expect(secondSnapshots.at(-1)?.[0]?.url).toBe(secondSubscriberUrl);
    }).pipe(Effect.scoped, Effect.provide(layer));
  },
);

effectIt.effect("stops probing a subscriber's configured paths after its scope closes", () => {
  const docsUrl = `http://localhost:${LSOF_TEST_PORT}/docs`;
  const adminUrl = `http://localhost:${LSOF_TEST_PORT}/admin`;
  const requests: string[] = [];
  const fetchFn = ((input: Parameters<typeof globalThis.fetch>[0]) => {
    const url = String(input);
    requests.push(url);
    return Promise.resolve(
      url === docsUrl || url === adminUrl
        ? new Response("app", { headers: { "content-type": "text/html" } })
        : new Response("not found", { status: 404 }),
    );
  }) as typeof globalThis.fetch;
  const layer = makeLsofScannerLayer({ pid: () => 1234, fetch: fetchFn });

  return Effect.gen(function* () {
    const scanner = yield* PortScanner.PortDiscovery;
    const docsScope = yield* Scope.make();
    yield* scanner
      .subscribe({ configuredUrls: [docsUrl], initialSnapshot: [] }, () => Effect.void)
      .pipe(Effect.provideService(Scope.Scope, docsScope));
    yield* scanner.subscribe(
      { configuredUrls: [adminUrl], initialSnapshot: [] },
      () => Effect.void,
    );
    yield* scanner.retain;
    yield* Scope.close(docsScope, Exit.void);

    requests.length = 0;
    yield* TestClock.adjust(Duration.seconds(15));
    expect(requests).toContain(adminUrl);
    expect(requests).not.toContain(docsUrl);
  }).pipe(Effect.scoped, Effect.provide(layer));
});

effectIt.effect("writes no poll span while no client retains the scanner", () => {
  let pollSpans = 0;
  const tracer = Tracer.make({
    span: (options) => {
      if (options.name === "PortDiscovery.pollTick") pollSpans += 1;
      return new Tracer.NativeSpan(options);
    },
  });
  const layer = makeProbeFailureLayer(processProbeFailure);

  return Effect.gen(function* () {
    const scanner = yield* PortScanner.PortDiscovery;
    yield* TestClock.adjust(Duration.seconds(15));
    expect(pollSpans).toBe(0);

    yield* scanner.retain;
    expect(pollSpans).toBe(1);
  }).pipe(Effect.scoped, Effect.provide(layer), Effect.withTracer(tracer));
});

effectIt.effect("uses the current configured fragment when readiness comes from cache", () => {
  const requests: string[] = [];
  const fetchFn = ((input: Parameters<typeof globalThis.fetch>[0]) => {
    requests.push(String(input));
    return Promise.resolve(new Response("docs", { headers: { "content-type": "text/html" } }));
  }) as typeof globalThis.fetch;
  const layer = makeLsofScannerLayer({ pid: () => 1234, fetch: fetchFn });
  const oldUrl = `http://localhost:${LSOF_TEST_PORT}/docs#old`;
  const newUrl = `http://localhost:${LSOF_TEST_PORT}/docs#new`;

  return Effect.gen(function* () {
    const scanner = yield* PortScanner.PortDiscovery;
    expect((yield* scanner.scan([oldUrl]))[0]?.url).toBe(oldUrl);
    const requestCount = requests.length;
    expect((yield* scanner.scan([newUrl]))[0]?.url).toBe(newUrl);
    expect(requests).toHaveLength(requestCount);
  }).pipe(Effect.provide(layer));
});

effectIt.effect("shares a configured root probe with discovered-root classification", () => {
  const requests: string[] = [];
  const rootUrl = `http://localhost:${LSOF_TEST_PORT}/`;
  const fetchFn = ((input: Parameters<typeof globalThis.fetch>[0]) => {
    requests.push(String(input));
    return Promise.resolve(new Response("app", { headers: { "content-type": "text/html" } }));
  }) as typeof globalThis.fetch;
  const layer = makeLsofScannerLayer({ pid: () => 1234, fetch: fetchFn });

  return Effect.gen(function* () {
    const scanner = yield* PortScanner.PortDiscovery;
    expect(yield* scanner.scan([rootUrl])).toHaveLength(1);
    expect(requests).toEqual([rootUrl]);

    yield* TestClock.adjust(Duration.seconds(15));
    expect(yield* scanner.scan([rootUrl])).toHaveLength(1);
    expect(requests).toEqual([rootUrl, rootUrl]);
  }).pipe(Effect.provide(layer));
});

effectIt.effect("starts fresh cache entries after the probing batch completes", () =>
  Effect.gen(function* () {
    const baseClock = yield* Clock.Clock;
    const times = [0, 20_000, 20_000, 20_000];
    let timeIndex = 0;
    const currentTimeMillis = () => times[Math.min(timeIndex++, times.length - 1)]!;
    const clock: Clock.Clock = {
      ...baseClock,
      currentTimeMillisUnsafe: currentTimeMillis,
      currentTimeMillis: Effect.sync(currentTimeMillis),
    };
    const requests: string[] = [];
    const fetchFn = ((input: Parameters<typeof globalThis.fetch>[0]) => {
      requests.push(String(input));
      return Promise.resolve(new Response("app", { headers: { "content-type": "text/html" } }));
    }) as typeof globalThis.fetch;
    const layer = makeLsofScannerLayer({ pid: () => 1234, fetch: fetchFn });

    yield* Effect.gen(function* () {
      const scanner = yield* PortScanner.PortDiscovery;
      expect(yield* scanner.scan()).toHaveLength(1);
      expect(yield* scanner.scan()).toHaveLength(1);
      expect(requests).toHaveLength(1);
    }).pipe(Effect.provide(layer), Effect.provideService(Clock.Clock, clock));
  }),
);

effectIt.effect("caches a failed web probe until its bounded cache entry expires", () => {
  let responds = false;
  const requests: string[] = [];
  const fetchFn = ((input: Parameters<typeof globalThis.fetch>[0]) => {
    requests.push(String(input));
    return responds
      ? Promise.resolve(new Response("hello", { headers: { "content-type": "text/html" } }))
      : Promise.reject(new TypeError("not HTTP"));
  }) as typeof globalThis.fetch;
  const layer = makeLsofScannerLayer({ pid: () => 1234, fetch: fetchFn });

  return Effect.gen(function* () {
    const scanner = yield* PortScanner.PortDiscovery;
    expect(yield* scanner.scan()).toHaveLength(0);
    expect(yield* scanner.scan()).toHaveLength(0);
    expect(requests).toHaveLength(2);

    responds = true;
    yield* TestClock.adjust(Duration.seconds(15));
    expect(yield* scanner.scan()).toHaveLength(1);
    expect(requests).toHaveLength(3);
  }).pipe(Effect.provide(layer));
});

effectIt.effect("falls back to HTTPS and does not follow redirects while probing", () => {
  const redirects: Array<string | undefined> = [];
  const fetchFn = (async (
    input: Parameters<typeof globalThis.fetch>[0],
    init?: Parameters<typeof globalThis.fetch>[1],
  ) => {
    redirects.push(init?.redirect);
    if (String(input).startsWith("http:")) throw new TypeError("TLS listener");
    return new Response(null, { status: 302, headers: { location: "https://example.com" } });
  }) as typeof globalThis.fetch;
  const layer = makeLsofScannerLayer({ pid: () => 1234, fetch: fetchFn });

  return Effect.gen(function* () {
    const scanner = yield* PortScanner.PortDiscovery;
    const servers = yield* scanner.scan();
    expect(servers).toHaveLength(1);
    expect(servers[0]?.url).toBe(`https://localhost:${LSOF_TEST_PORT}`);
    expect(redirects).toEqual(["manual", "manual"]);
  }).pipe(Effect.provide(layer));
});

effectIt.effect(
  "excludes HTTP errors, non-navigation responses, and successful non-documents",
  () => {
    let pid = 1;
    let makeResponse = () =>
      new Response("not found", { status: 404, headers: { "content-type": "text/html" } });
    const fetchFn = ((_input: Parameters<typeof globalThis.fetch>[0]) =>
      Promise.resolve(makeResponse())) as typeof globalThis.fetch;
    const layer = makeLsofScannerLayer({ pid: () => pid, fetch: fetchFn });

    return Effect.gen(function* () {
      const scanner = yield* PortScanner.PortDiscovery;
      expect(yield* scanner.scan()).toHaveLength(0);

      pid += 1;
      makeResponse = () =>
        new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
      expect(yield* scanner.scan()).toHaveLength(0);

      pid += 1;
      makeResponse = () =>
        new Response("ready", { status: 200, headers: { "content-type": "text/plain" } });
      expect(yield* scanner.scan()).toHaveLength(0);

      pid += 1;
      makeResponse = () => new Response(null, { status: 304, headers: { location: "/cached" } });
      expect(yield* scanner.scan()).toHaveLength(0);

      pid += 1;
      makeResponse = () =>
        new Response(null, { status: 204, headers: { "content-type": "text/html" } });
      expect(yield* scanner.scan()).toHaveLength(0);

      pid += 1;
      makeResponse = () => new Response(null, { status: 302 });
      expect(yield* scanner.scan()).toHaveLength(0);

      pid += 1;
      makeResponse = () =>
        new Response("<html />", {
          status: 200,
          headers: { "content-type": "application/xhtml+xml; charset=utf-8" },
        });
      expect(yield* scanner.scan()).toHaveLength(1);
    }).pipe(Effect.provide(layer));
  },
);

effectIt.effect("aborts HTTP and HTTPS probes when they time out", () => {
  const aborted: string[] = [];
  const fetchFn = ((
    input: Parameters<typeof globalThis.fetch>[0],
    init?: Parameters<typeof globalThis.fetch>[1],
  ) =>
    new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal;
      const onAbort = () => {
        aborted.push(String(input));
        reject(new DOMException("Aborted", "AbortError"));
      };
      if (signal?.aborted) {
        onAbort();
      } else {
        signal?.addEventListener("abort", onAbort, { once: true });
      }
    })) as typeof globalThis.fetch;
  const layer = makeLsofScannerLayer({ pid: () => 1234, fetch: fetchFn });

  return Effect.gen(function* () {
    const scanner = yield* PortScanner.PortDiscovery;
    const scanFiber = yield* Effect.forkChild(scanner.scan());
    yield* TestClock.adjust(Duration.seconds(2));
    expect(yield* Fiber.join(scanFiber)).toHaveLength(0);
    expect(aborted).toEqual([
      `http://localhost:${LSOF_TEST_PORT}/`,
      `https://localhost:${LSOF_TEST_PORT}/`,
    ]);
  }).pipe(Effect.provide(layer));
});

effectIt.effect("does not swallow process probe defects", () =>
  Effect.gen(function* () {
    const defect = new Error("unexpected process probe defect");
    const layer = makeProbeFailureLayer(() => Effect.die(defect));

    const exit = yield* Effect.flatMap(PortScanner.PortDiscovery, (scanner) => scanner.scan()).pipe(
      Effect.provide(layer),
      Effect.exit,
    );

    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      expect(Cause.hasDies(exit.cause)).toBe(true);
      expect(Cause.squash(exit.cause)).toBe(defect);
    }
  }),
);

effectIt.effect("does not swallow process probe interruption", () =>
  Effect.gen(function* () {
    const layer = makeProbeFailureLayer(() => Effect.interrupt);

    const exit = yield* Effect.flatMap(PortScanner.PortDiscovery, (scanner) => scanner.scan()).pipe(
      Effect.provide(layer),
      Effect.exit,
    );

    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      expect(Cause.hasInterruptsOnly(exit.cause)).toBe(true);
    }
  }),
);

effectIt.effect("recognizes a self-signed HTTPS preview only through its loopback probe", () =>
  Effect.gen(function* () {
    const directory = yield* Effect.acquireRelease(
      Effect.sync(() => NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "preview-tls-test-"))),
      (directory) => Effect.sync(() => NodeFS.rmSync(directory, { recursive: true, force: true })),
    );
    const key = NodePath.join(directory, "test.key");
    const certificate = NodePath.join(directory, "test.crt");
    yield* Effect.sync(() =>
      NodeChildProcess.execFileSync(
        "openssl",
        [
          "req",
          "-x509",
          "-newkey",
          "rsa:2048",
          "-nodes",
          "-days",
          "1",
          "-subj",
          "/CN=localhost",
          "-keyout",
          key,
          "-out",
          certificate,
        ],
        { stdio: "ignore" },
      ),
    );
    const server = yield* Effect.acquireRelease(
      Effect.callback<NodeHttps.Server>((resume) => {
        const server = NodeHttps.createServer(
          {
            key: NodeFS.readFileSync(key),
            cert: NodeFS.readFileSync(certificate),
          },
          (_request, response) => {
            response.writeHead(200, { "content-type": "text/html", connection: "close" });
            response.end("<html>local HTTPS QA</html>");
          },
        );
        server.listen(0, "127.0.0.1", () => resume(Effect.succeed(server)));
        return Effect.sync(() => server.close());
      }),
      (server) =>
        Effect.callback<void>((resume) => {
          server.close(() => resume(Effect.void));
        }),
    );
    const address = server.address();
    if (address === null || typeof address === "string")
      return yield* Effect.die("Missing TLS test address");
    const url = `https://127.0.0.1:${address.port}/report`;
    const trustedRequest = Effect.flatMap(HttpClient.HttpClient, (client) => client.get(url)).pipe(
      Effect.scoped,
      Effect.provide(FetchHttpClient.layer),
    );
    const trustedProbe = yield* Effect.result(trustedRequest);
    expect(trustedProbe._tag).toBe("Failure");
    const layer = makeLsofScannerLayer({
      pid: () => process.pid,
      output: () => `p${process.pid}\ncnode\nn127.0.0.1:${address.port}\n`,
      fetch: globalThis.fetch,
    });
    yield* Effect.gen(function* () {
      const scanner = yield* PortScanner.PortDiscovery;
      yield* scanner.registerTerminalProcesses({
        threadId: "tls-thread",
        terminalId: "tls-terminal",
        processIds: [process.pid],
      });
      const servers = yield* scanner.scan([url]);
      expect(servers).toHaveLength(1);
      expect(servers[0]?.url).toBe(url);
      expect(servers[0]?.terminal).toEqual({ threadId: "tls-thread", terminalId: "tls-terminal" });
    }).pipe(Effect.provide(layer));
    // Probe-local trust must not change the certificate policy of other clients.
    expect((yield* Effect.result(trustedRequest))._tag).toBe("Failure");
  }).pipe(Effect.scoped),
);
