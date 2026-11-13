---
name: test-t3-mobile
description: Test T3 Code's native iOS and Android app through its Device panel and returned AgentDevice command. Use only when the user explicitly asks for native mobile verification, a native-client build, or mobile pairing; web and desktop QA use test-t3-app.
---

# Test T3 Mobile

Run this skill only on an explicit user request for native mobile verification.
A mobile code change alone gets its integrated pass through `test-t3-app`.

## Open the device

Call `device_list`. Reuse a simulator that is already booted; boot one only when
none is running. Then call `device_open` with the selected host and device IDs.
T3 shows its live stream in the Device panel. Follow its
returned `quickStart`, using the exact `agentDevice.command` and all `targetArgs`
on every operation. Use `device_screenshot` to inspect the screen.

If T3 device tools or the selected device are unavailable, report the blocker
and stop verification. Do not install or switch to another automation system.
If a command fails with `DEVICE_IN_USE`, another thread holds the device: ask
the user, or wait and retry. Never open a second simulator to get around it.

## Use an isolated backend

Reuse this task's healthy backend. Otherwise run `vp run dev` from the
repository root, retain its terminal session, and read the actual backend port
from the dev-runner output. Use the worktree's ignored `.t3` state. Never run
against `~/.t3/userdata`. The Browser panel is not required for this workflow.

Test with meaningful project and thread data. Read the shared
[SQLite fixture reference](../test-t3-app/references/sqlite-fixtures.md) only
when inspecting or seeding SQLite. Stop the test server before fixture writes.

## Launch T3 Code Dev

From the checkout being tested on the selected device host, run:

```bash
vp run mobile:install <ios|android> <device-id>
```

This installs the dev client for the checkout's native fingerprint: from the
device, the local cache, or the shared cache in seconds, building once only
when no machine has that fingerprint yet: in the `Mobile Dev Client` workflow
on Blacksmith when HEAD is pushed and `gh` may dispatch it (the command waits),
otherwise here (5-15 minutes, logged to the file it names). The device id may be omitted when exactly one device is booted. It
prints one JSON line; on failure it names the next command. Mobile verification
includes that step unless the user prohibits it.

For a device you opened in an agent-device session elsewhere (a device pool,
cloud, or remote host), run `vp run mobile:install <ios|android> --session <s>`
from the directory you opened the session in. It installs the cached build into
that session (`--abi arm64-v8a` for an ARM Android device; `--metro <url>` also
opens it against Metro) and never builds.

Start `vp run dev:client` from `apps/mobile`, or reuse a healthy Metro belonging
to this checkout. Open its printed development-client URL with AgentDevice
`open com.t3tools.t3code.dev <url>` and all returned target arguments.
The device must be able to reach both Metro and the isolated backend.
Append `&disableAutoLaunch=1&disableFab=1` to the development-client URL query
when developer chrome would obscure screenshots or taps; the SDK 58 dev client
applies these preferences before the app loads.

## Pair and verify

Use the helper from the repository root, with the returned executable and target
arguments stored in `agent_device_command` and the Bash array
`agent_device_target_args`:

```bash
.agents/skills/test-t3-mobile/scripts/pair-client.sh \
  <server-port> <base-dir> <device-reachable-backend-origin> \
  "$agent_device_command" "${agent_device_target_args[@]}"
```

It issues a fresh credential and opens T3 Code Dev's existing pairing route
through AgentDevice. For a backend on the device host, use
`http://127.0.0.1:<server-port>` on iOS or `http://10.0.2.2:<server-port>`
on Android. For a remote backend, use its reachable origin.

Confirm the intended projects appear, exercise the affected flow, and capture
evidence. Keep the app and environment while you iterate within this task.

## Tear down

Before you hand back, remove the disposable connection, close the AgentDevice
session, and stop only your backend and Metro processes. Then call
`device_close` with `shutdown: true` for every device this thread booted; use a
plain `device_close` only for a device that was already running when you opened
it. Hand back with none of your simulators running, and never pass one to
another thread to keep. T3 Code also shuts down a local simulator an agent
booted after 30 minutes without device commands, but that is a backstop, not
your teardown.
