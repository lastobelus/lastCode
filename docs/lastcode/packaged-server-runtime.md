# Packaged Server Runtime Foundation

LastCode's macOS headless service must run the server shipped inside an exact LastCode desktop
artifact. It must never resolve `t3` from npm or reuse the upstream service's
`node_modules/t3/dist/bin.mjs` convention.

This document describes the preparation boundary implemented for the Intel service. It does not
activate a LaunchAgent. Pending-DMG activation and the live-service handoff remain a separate
update step.

## Runtime identity

Preparation starts from an extracted `LastCode.app` and the durable `build-manifest.json` beside
the selected x64 DMG. The manifest supplies the immutable checkpoint or revision tag, build tag,
LastCode commit, version, platform, and architecture.

The preparer requires all of the following before publishing a runtime:

- product `LastCode` and bundle ID `codes.lastobelus.lastcode`;
- the exact manifest version, checkpoint or revision tag, build tag, and 40-character commit;
- macOS x64, with no universal, arm64, or translated fallback;
- a valid code signature on the copied application;
- matching bundle and embedded `app.asar/package.json` identity, including the embedded
  12-character prefix of the full manifest commit;
- the packaged Electron executable and `apps/server/dist/bin.mjs` entry;
- an `ELECTRON_RUN_AS_NODE=1` server version preflight (recording the bundled server package
  version independently from the desktop build version); and
- SHA-256 checksums for the Electron executable, `app.asar`, and server entry.

The runtime is copied to a staging directory below the caller-provided runtime root, validated
again after the copy, and atomically renamed into:

```text
versions/<version>-<commit-prefix>-build-<number>/
  LastCode.app/
  lastcode-packaged-runtime.json
  .lastcode-packaged-runtime-complete.json
supervisors/<supervisor-sha256>/
  lastcode-packaged-server-supervisor.mjs
```

The completion sentinel is written last and contains the descriptor's SHA-256. Loading the
runtime repeats identity, signature, preflight, payload checksum, and sentinel validation. Copied
payload files and directories are synced before the descriptor and sentinel. A directory,
descriptor, or sentinel by itself is not a runnable candidate. The separately managed,
content-addressed LastCode supervisor is also copied, synced, and validated without placing it
inside any candidate directory. Its published file is read-only; changing it requires an explicit
permission change and causes the content-address validation to fail before a new service plan can
be rendered.

The implementation lives in
`scripts/lib/lastcode-packaged-server-runtime.ts`. It deliberately has no npm install path and no
fallback to an upstream T3 Code package.

## LaunchAgent candidate

`scripts/lib/lastcode-packaged-server-service.ts` renders a LaunchAgent only from a validated
runtime value. Its contract is:

- label `codes.lastobelus.lastcode.server`, distinct from both the LastCode desktop bundle ID and
  the upstream T3 Code service label;
- `LimitLoadToSessionType=Aqua`, `RunAtLoad`, and `KeepAlive`, so availability remains scoped to a
  signed-in graphical user session;
- an independently managed Node executable running the content-addressed LastCode supervisor,
  both outside the versioned candidate; the supervisor revalidates the descriptor, sentinel,
  signature, embedded identity, and payload at every login or KeepAlive restart before it starts
  the candidate Electron executable with `ELECTRON_RUN_AS_NODE=1` and the packaged server's
  `--no-browser` command, so no renderer or GPU process is needed;
- the existing LastCode home (normally `~/.lastcode`) and its existing identity, pairing,
  projects, settings, and private-route configuration;
- loopback binding at `127.0.0.1`; and
- one stable log at `~/.lastcode/userdata/logs/packaged-server-service.log`.

The candidate executable and server entry do not appear in the plist. The supervisor receives only
the validated descriptor path, and the LaunchAgent pins its SHA-256 plus the exact version, tag,
build tag, and commit. Candidate bytes therefore cannot execute before their restart-time
preflight or be replaced by another self-consistent descriptor. The plist contains only fixed
runtime identity, paths, and a bounded provider-discovery `PATH`; it also clears ambient
`NODE_OPTIONS` and `NODE_PATH`. It does not serialize the invoking shell environment, credentials,
tokens, or other secrets. Startup and server failures therefore reach the stable log without
putting credentials in the LaunchAgent definition.

## Activation boundary

The preparer and renderer do not call `launchctl`, write under `~/Library/LaunchAgents`, stop a
running service, replace the desktop app, or consume a pending DMG. The activation owner must use
this order:

1. Validate the build manifest and extracted app.
2. Copy, revalidate, checksum, and publish the immutable runtime descriptor and sentinel.
3. Prepare the content-addressed supervisor and select the independently managed Node executable.
4. Render the complete LaunchAgent candidate from those validated inputs.
5. Only then stop the current service and perform the guarded plist/launchd handoff.

Keeping activation separate makes it possible to add rollback and single-owner coordination
without weakening the invariant that the current service stays up while its replacement is being
prepared.

The external Node executable and supervisor are the LaunchAgent's trust root: they necessarily run
before code can verify the candidate. The activation owner must source the Node executable from
the independently pinned service runtime and install the prepared supervisor from trusted LastCode
code. Candidate validation does not claim to defend against an actor that can replace this trust
root or rewrite the LaunchAgent itself.

## Remaining acceptance work

Activation must still integrate with the pending-DMG updater and service-owner lease. End-to-end
QA remains required on Intel macOS for launchd login/logout behavior, disabled Login Items,
provider discovery through mise, one real read-only thread, private remote reachability, sleep,
TCC attribution, unexpected-exit restart, rollback, and proof that the desktop and headless
service cannot own the same LastCode home concurrently.
