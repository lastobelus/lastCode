// @effect-diagnostics nodeBuiltinImport:off - This fixture exercises a real self-signed Node TLS server and certificate files.
import * as NodeNet from "node:net";
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem";
import * as NodeServices from "@effect/platform-node/NodeServices";
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
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as PlatformError from "effect/PlatformError";
import * as Scope from "effect/Scope";
import * as TestClock from "effect/testing/TestClock";
import * as Tracer from "effect/Tracer";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import { expect } from "vite-plus/test";
import { FetchHttpClient, HttpClient } from "effect/http";

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

const layerTestProcessRunner = Layer.succeed(ProcessRunner.ProcessRunner, {
  run: processProbeFailure,
});

/** A host without `/proc`, so a missing `lsof` leaves only configured URLs. */
const layerNoProc = FileSystem.layerNoop({});

const layerProbeFailure = (
  run: ProcessRunner.ProcessRunner["Service"]["run"],
  fetch: typeof globalThis.fetch = globalThis.fetch,
  fileSystem: Layer.Layer<FileSystem.FileSystem> = layerNoProc,
) =>
  PortScanner.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        fileSystem,
        Layer.succeed(ProcessRunner.ProcessRunner, { run }),
        Layer.succeed(HostProcess.Platform, "linux"),
        FetchHttpClient.layer.pipe(Layer.provide(Layer.succeed(FetchHttpClient.Fetch, fetch))),
      ),
    ),
  );

const layerTestPortDiscovery = PortScanner.layer.pipe(
  Layer.provide(
    Layer.mergeAll(
      layerNoProc,
      layerTestProcessRunner,
      Layer.succeed(HostProcess.Platform, "win32"),
      FetchHttpClient.layer,
    ),
  ),
);

const LSOF_TEST_PORT = 43_123;

/** The scanner with `processIds` registered to a T3 terminal, so their listeners get probes. */
const ownedScanner = (processIds: ReadonlyArray<number> = [1234]) =>
  Effect.tap(PortScanner.PortDiscovery, (scanner) =>
    scanner.registerTerminalProcesses({
      threadId: "scanner-thread",
      terminalId: "scanner-terminal",
      processIds,
    }),
  );

const layerLsofScanner = (input: {
  readonly pid: () => number;
  readonly stdout?: () => string;
  readonly run?: ProcessRunner.ProcessRunner["Service"]["run"];
  readonly platform?: "linux" | "win32" | "darwin";
  readonly fileSystem?: Layer.Layer<FileSystem.FileSystem>;
  readonly fetch: typeof globalThis.fetch;
}) =>
  PortScanner.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        input.fileSystem ?? layerNoProc,
        Layer.succeed(ProcessRunner.ProcessRunner, {
          run:
            input.run ??
            (() =>
              Effect.succeed({
                stdout: input.stdout?.() ?? `p${input.pid()}\ncnode\nn*:${LSOF_TEST_PORT}\n`,
                stderr: "",
                code: ChildProcessSpawner.ExitCode(0),
                timedOut: false,
                stdoutTruncated: false,
                stderrTruncated: false,
                stdoutInvalidUtf8: false,
                stderrInvalidUtf8: false,
              })),
        }),
        Layer.succeed(HostProcess.Platform, input.platform ?? "linux"),
        FetchHttpClient.layer.pipe(
          Layer.provide(Layer.succeed(FetchHttpClient.Fetch, input.fetch)),
        ),
      ),
    ),
  );

// This fixture changes only the child probe environment, never the test runner's PATH.
effectIt.live.skipIf(HostProcess.Platform.defaultValue() !== "darwin")(
  "discovers an attributed macOS listener with an empty child PATH",
  () =>
    Effect.gen(function* () {
      const server = yield* Effect.acquireRelease(
        openServer(0, (socket) => {
          socket.once("data", () => {
            socket.end(
              "HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nContent-Length: 5\r\nConnection: close\r\n\r\nhello",
            );
          });
        }).pipe(
          Effect.flatMap((server) =>
            server ? Effect.succeed(server) : Effect.die("Fixture listen failed"),
          ),
        ),
        closeServer,
      );
      const address = server.address();
      if (address === null || typeof address === "string")
        return yield* Effect.die("Missing fixture address");
      const runner = yield* ProcessRunner.ProcessRunner;
      const bare = yield* Effect.result(
        runner.run({ command: "lsof", args: ["-v"], env: { ...process.env, PATH: "" } }),
      );
      expect(bare._tag).toBe("Failure");
      const layer = layerLsofScanner({
        pid: () => process.pid,
        platform: "darwin",
        fileSystem: NodeFileSystem.layer,
        run: (input) => runner.run({ ...input, env: { ...process.env, PATH: "" } }),
        fetch: globalThis.fetch,
      });
      yield* Effect.gen(function* () {
        const scanner = yield* PortScanner.PortDiscovery;
        const owner = { threadId: "restricted-path-thread", terminalId: "fixture-terminal" };
        yield* scanner.registerTerminalProcesses({ ...owner, processIds: [process.pid] });
        const servers = yield* scanner.scan([`http://127.0.0.1:${address.port}/`]);
        const discovered = servers.find((entry) => entry.port === address.port);
        expect(discovered?.pid).toBe(process.pid);
        expect(discovered?.terminal).toEqual(owner);
      }).pipe(Effect.provide(layer));
    }).pipe(
      Effect.scoped,
      Effect.provide(ProcessRunner.layer.pipe(Layer.provide(NodeServices.layer))),
    ),
);

for (const failure of ["missing", "exit", "timeout", "truncated", "invalid-utf8"] as const) {
  effectIt.effect(`keeps macOS HTTP fallback unattributed after ${failure} lsof evidence`, () => {
    const commands: string[] = [];
    const layer = layerLsofScanner({
      pid: () => 62_001,
      platform: "darwin",
      fileSystem: FileSystem.layerNoop({ exists: () => Effect.succeed(failure !== "missing") }),
      run: (input) => {
        commands.push(input.command);
        if (failure === "missing") return processProbeFailure(input);
        return Effect.succeed({
          stdout: `p62001\ncnode\nn*:${LSOF_TEST_PORT}\n`,
          stderr: "",
          code: ChildProcessSpawner.ExitCode(failure === "exit" ? 2 : 0),
          timedOut: failure === "timeout",
          stdoutTruncated: failure === "truncated",
          stderrTruncated: false,
          stdoutInvalidUtf8: failure === "invalid-utf8",
          stderrInvalidUtf8: false,
        });
      },
      fetch: async () =>
        new Response("<html>ready</html>", { headers: { "content-type": "text/html" } }),
    });
    return Effect.gen(function* () {
      const scanner = yield* PortScanner.PortDiscovery;
      yield* scanner.registerTerminalProcesses({
        threadId: "restricted-path-thread",
        terminalId: "fixture-terminal",
        processIds: [62_001],
      });
      const servers = yield* scanner.scan([`http://localhost:${LSOF_TEST_PORT}/`]);
      expect(servers).toHaveLength(1);
      expect(servers[0]?.pid).toBeNull();
      expect(servers[0]?.terminal).toBeNull();
      expect(commands).toEqual([failure === "missing" ? "lsof" : "/usr/sbin/lsof"]);
    }).pipe(Effect.provide(layer));
  });
}

const makeLinuxSsScannerLayer = (input: {
  readonly ssOutput: string;
  readonly fetch: typeof globalThis.fetch;
}) =>
  PortScanner.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        layerNoProc,
        Layer.succeed(ProcessRunner.ProcessRunner, {
          run: (request) =>
            request.command === "lsof"
              ? processProbeFailure(request)
              : Effect.succeed({
                  stdout: input.ssOutput,
                  stderr: "",
                  code: ChildProcessSpawner.ExitCode(0),
                  timedOut: false,
                  stdoutTruncated: false,
                  stderrTruncated: false,
                  stdoutInvalidUtf8: false,
                  stderrInvalidUtf8: false,
                }),
        }),
        Layer.succeed(HostProcess.Platform, "linux"),
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
  onConnection: (socket: NodeNet.Socket) => void,
) {
  const server = yield* openServer(0, onConnection);
  const address = server?.address();
  if (!server || !address || typeof address === "string") {
    return yield* Effect.die(new Error("Could not open the preview scanner test listener"));
  }
  return { port: address.port, server };
});

const commonDevServer = Effect.acquireRelease(
  openCommonDevServer((socket) => {
    socket.once("data", () => {
      socket.end("HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nContent-Length: 5\r\n\r\nhello");
    });
  }),
  ({ server }) => closeServer(server),
);

const commonNonHttpServer = Effect.acquireRelease(
  openCommonDevServer((socket) => {
    socket.on("error", () => undefined);
    socket.once("data", () => socket.end("MYSQL\r\n\r\n"));
  }),
  ({ server }) => closeServer(server),
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
  const layer = layerLsofScanner({
    pid: () => ownedProcessId,
    stdout: () =>
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
  const layer = layerLsofScanner({
    pid: () => ownedProcessId,
    platform: "win32",
    stdout: () =>
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
      const layer = layerLsofScanner({
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
  const layer = layerLsofScanner({
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
    const found = yield* scanner.scan(
      [63_133, 63_134, 63_135, 63_136].map((port) => `http://localhost:${port}/preview`),
    );
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
  const layer = layerLsofScanner({
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
 * platform with a failing listener probe so the tests exercise configured URLs
 * without depending on `lsof` being installed.
 */
effectIt.layer(layerTestPortDiscovery)("PortDiscovery integration (configured URLs)", (it) => {
  it.effect(
    "scan() returns a configured HTTP server we just opened",
    Effect.fn("PortScannerTest.scanFindsCommonDevServer")(function* () {
      const { port } = yield* commonDevServer;
      const scanner = yield* PortScanner.PortDiscovery;
      const result = yield* scanner.scan([`http://localhost:${port}`]);
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
      const result = yield* scanner.scan([`http://localhost:${port}`]);
      expect(result.some((server) => server.port === port)).toBe(false);
    }),
  );

  it.effect(
    "retain drives an immediate broadcast to subscribers",
    Effect.fn("PortScannerTest.retainBroadcastsImmediately")(function* () {
      const { port } = yield* commonDevServer;
      const received: number[] = [];
      const scanner = yield* PortScanner.PortDiscovery;
      yield* scanner.subscribe(
        { configuredUrls: [`http://localhost:${port}`], initialSnapshot: [] },
        (servers) =>
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
  const layer = layerLsofScanner({ pid: () => 1234, fetch: fetchFn });

  return Effect.gen(function* () {
    const scanner = yield* ownedScanner();
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
  const layer = layerLsofScanner({ pid: () => 1234, fetch: fetchFn });

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
    const layer = layerLsofScanner({
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
  const layer = layerLsofScanner({
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
  const layer = layerProbeFailure(processProbeFailure, fetchFn);

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
  const layer = layerProbeFailure(processProbeFailure, fetchFn);

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
  const layer = layerLsofScanner({ pid: () => 1234, fetch: fetchFn });

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
    const layer = layerLsofScanner({ pid: () => 1234, fetch: fetchFn });

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
  const layer = layerLsofScanner({ pid: () => 1234, fetch: fetchFn });

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
  const layer = layerProbeFailure(processProbeFailure);

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
  const layer = layerLsofScanner({ pid: () => 1234, fetch: fetchFn });
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
  const layer = layerLsofScanner({ pid: () => 1234, fetch: fetchFn });

  return Effect.gen(function* () {
    const scanner = yield* ownedScanner();
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
    const layer = layerLsofScanner({ pid: () => 1234, fetch: fetchFn });

    yield* Effect.gen(function* () {
      const scanner = yield* ownedScanner();
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
  const layer = layerLsofScanner({ pid: () => 1234, fetch: fetchFn });

  return Effect.gen(function* () {
    const scanner = yield* ownedScanner();
    expect(yield* scanner.scan()).toHaveLength(0);
    expect(yield* scanner.scan()).toHaveLength(0);
    expect(requests).toHaveLength(2);

    responds = true;
    yield* TestClock.adjust(Duration.seconds(15));
    expect(yield* scanner.scan()).toHaveLength(1);
    expect(requests).toHaveLength(3);
  }).pipe(Effect.provide(layer));
});

effectIt.effect(
  "retries failed configured previews on the next scan without losing ownership",
  () => {
    let responds = false;
    const requests: string[] = [];
    const rootUrl = `http://localhost:${LSOF_TEST_PORT}/`;
    const fetchFn = ((input: Parameters<typeof globalThis.fetch>[0]) => {
      requests.push(String(input));
      return responds
        ? Promise.resolve(new Response("app", { headers: { "content-type": "text/html" } }))
        : Promise.reject(new TypeError("starting up"));
    }) as typeof globalThis.fetch;
    const layer = layerLsofScanner({ pid: () => 1234, fetch: fetchFn });

    return Effect.gen(function* () {
      const scanner = yield* PortScanner.PortDiscovery;
      yield* scanner.registerTerminalProcesses({
        threadId: "preview-thread",
        terminalId: "preview-terminal",
        processIds: [1234],
      });
      expect(yield* scanner.scan([rootUrl, rootUrl])).toHaveLength(0);
      expect(requests).toEqual([rootUrl, `https://localhost:${LSOF_TEST_PORT}/`]);

      responds = true;
      yield* TestClock.adjust(Duration.seconds(3));
      expect(yield* scanner.scan()).toHaveLength(0);
      expect(requests).toHaveLength(2);

      const servers = yield* scanner.scan([rootUrl]);
      expect(servers).toHaveLength(1);
      expect(servers[0]?.terminal).toEqual({
        threadId: "preview-thread",
        terminalId: "preview-terminal",
      });
      expect(requests).toEqual([rootUrl, `https://localhost:${LSOF_TEST_PORT}/`, rootUrl]);

      expect(yield* scanner.scan([rootUrl])).toEqual(servers);
      expect(yield* scanner.scan()).toHaveLength(1);
      expect(requests).toHaveLength(3);
    }).pipe(Effect.provide(layer));
  },
);

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
  const layer = layerLsofScanner({ pid: () => 1234, fetch: fetchFn });

  return Effect.gen(function* () {
    const scanner = yield* ownedScanner();
    const servers = yield* scanner.scan();
    expect(servers).toHaveLength(1);
    expect(servers[0]?.url).toBe(`https://localhost:${LSOF_TEST_PORT}`);
    expect(redirects).toEqual(["manual", "manual"]);
  }).pipe(Effect.provide(layer));
});

effectIt.effect("probes a port only while T3 terminals own every listener on it", () => {
  const owned = `p1234\ncnode\nn[::1]:${LSOF_TEST_PORT}\n`;
  const unowned = `p5678\ncrpc\nn127.0.0.1:${LSOF_TEST_PORT}\n`;
  let stdout = unowned;
  const requests: string[] = [];
  const fetchFn = ((input: Parameters<typeof globalThis.fetch>[0]) => {
    requests.push(String(input));
    return Promise.resolve(new Response("app", { headers: { "content-type": "text/html" } }));
  }) as typeof globalThis.fetch;
  const layer = layerLsofScanner({ pid: () => 1234, fetch: fetchFn, stdout: () => stdout });

  return Effect.gen(function* () {
    const scanner = yield* ownedScanner();
    expect(yield* scanner.scan()).toHaveLength(0);
    stdout = `${owned}${unowned}`;
    expect(yield* scanner.scan()).toHaveLength(0);
    expect(requests).toEqual([]);

    stdout = owned;
    expect(yield* scanner.scan()).toHaveLength(1);
    expect(requests).toEqual([`http://localhost:${LSOF_TEST_PORT}/`]);

    yield* scanner.unregisterTerminal({
      threadId: "scanner-thread",
      terminalId: "scanner-terminal",
    });
    expect(yield* scanner.scan()).toHaveLength(0);
    expect(requests).toHaveLength(1);
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
    const layer = layerLsofScanner({ pid: () => pid, fetch: fetchFn });

    return Effect.gen(function* () {
      const scanner = yield* ownedScanner([1, 2, 3, 4, 5, 6, 7]);
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
  const layer = layerLsofScanner({ pid: () => 1234, fetch: fetchFn });

  return Effect.gen(function* () {
    const scanner = yield* ownedScanner();
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
    const layer = layerProbeFailure(() => Effect.die(defect));

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

// /proc/net/tcp: 127.0.0.1:8765 and 0.0.0.0:22 listening, an established
// connection, and a non-loopback listener; /proc/net/tcp6 adds [::]:3001.
const PROC_NET_TCP = `  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode
   0: 0100007F:223D 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 5001 1 0000000000000000 100 0 0 10 0
   1: 00000000:0016 00000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 5002 1 0000000000000000 100 0 0 10 0
   2: 0100007F:223D 0100007F:C350 01 00000000:00000000 00:00000000 00000000  1000        0 5003 1 0000000000000000 20 4 30 10 -1
   3: 0A00000F:1F90 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 5005 1 0000000000000000 100 0 0 10 0
`;
const PROC_NET_TCP6 = `  sl  local_address                         remote_address                        st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode
   0: 00000000000000000000000000000000:0BB9 00000000000000000000000000000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 5004 1 0000000000000000 100 0 0 10 0
`;

effectIt.effect(
  "reads Linux listeners from /proc when lsof is missing, and stops spawning it",
  () => {
    let lsofSpawns = 0;
    const fdWalks: string[] = [];
    const procFiles: Record<string, string> = {
      "/proc/net/tcp": PROC_NET_TCP,
      "/proc/net/tcp6": PROC_NET_TCP6,
      "/proc/4242/comm": "python3\n",
    };
    const procFds: Record<string, Record<string, string>> = {
      "4242": { "0": "/dev/null", "3": "socket:[5001]" },
      "77": { "5": "socket:[9999]" },
    };
    const missing = FileSystem.makeNoop({});
    const fileSystem = FileSystem.layerNoop({
      readFileString: (path) => {
        const content = procFiles[path];
        return content === undefined ? missing.readFileString(path) : Effect.succeed(content);
      },
      readDirectory: (path) => {
        if (path === "/proc") return Effect.succeed(["self", "77", "4242"]);
        const pid = /^\/proc\/(\d+)\/fd$/.exec(path)?.[1];
        const fds = pid === undefined ? undefined : procFds[pid];
        if (pid === undefined || fds === undefined) return missing.readDirectory(path);
        fdWalks.push(pid);
        return Effect.succeed(Object.keys(fds));
      },
      readLink: (path) => {
        const [, pid, fd] = /^\/proc\/(\d+)\/fd\/(\d+)$/.exec(path) ?? [];
        const target = pid && fd ? procFds[pid]?.[fd] : undefined;
        return target === undefined ? missing.readLink(path) : Effect.succeed(target);
      },
    });
    const fetchFn = (() =>
      Promise.resolve(
        new Response("hello", { headers: { "content-type": "text/html" } }),
      )) as typeof globalThis.fetch;
    const layer = layerProbeFailure(
      (input) => {
        lsofSpawns += 1;
        return processProbeFailure(input);
      },
      fetchFn,
      fileSystem,
    );

    return Effect.gen(function* () {
      const scanner = yield* ownedScanner([4242]);
      const first = yield* scanner.scan();
      // Ports 22 and 3001 have no known owner, so they never receive probes.
      expect(first.map(({ port, pid, processName }) => ({ port, pid, processName }))).toEqual([
        { port: 8765, pid: 4242, processName: "python3" },
      ]);
      yield* scanner.scan();
      expect(lsofSpawns).toBe(1);
      // Ports 22 and 3001 have no readable owner, so the second scan walks
      // again; it stops at 77, which holds no listener, once nothing is left.
      expect(fdWalks).toEqual(["77", "4242", "77", "4242"]);
      yield* scanner.scan();
      yield* scanner.scan();
      // Unresolved owners are retried a bounded number of times.
      expect(fdWalks).toEqual(["77", "4242", "77", "4242", "77", "4242"]);
    }).pipe(Effect.provide(layer));
  },
);

effectIt.effect("keeps spawning lsof after a spawn failure that is not a missing command", () => {
  let lsofSpawns = 0;
  const layer = layerProbeFailure((input) => {
    if (input.command === "lsof") lsofSpawns += 1;
    return Effect.fail(
      new ProcessRunner.ProcessSpawnError({
        command: input.command,
        argumentCount: input.args.length,
        cwd: input.cwd,
        cause: PlatformError.systemError({
          _tag: "Unknown",
          module: "ChildProcess",
          method: "spawn",
          description: "EAGAIN",
        }),
      }),
    );
  });
  return Effect.gen(function* () {
    const scanner = yield* PortScanner.PortDiscovery;
    yield* scanner.scan();
    yield* scanner.scan();
    expect(lsofSpawns).toBe(2);
  }).pipe(Effect.provide(layer));
});

effectIt.effect("does not swallow process probe interruption", () =>
  Effect.gen(function* () {
    const layer = layerProbeFailure(() => Effect.interrupt);

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
    const layer = layerLsofScanner({
      pid: () => process.pid,
      stdout: () => `p${process.pid}\ncnode\nn127.0.0.1:${address.port}\n`,
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
