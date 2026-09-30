# Issue #19 update-progress UI evidence

This paired evidence uses the real `SidebarUpdatePill`, tooltip primitives, and
production CSS in isolated Vite/Chromium harnesses. The harness bridge is
in-memory only; it did not start a backend, read or write live T3/LastCode
state, or launch the installed LastCode application.

## Compared revisions

- Before: merged transport/state PR #49 at
  `8aad48d06d07bbb65bd610d63ce708629e677f1d`.
- After: local issue #19-C UI head at
  `1f51cd716da7eb778427553c4a63dd16a2817b32`.

Both surfaces received the same typed `DesktopUpdateState`: a retryable local
packaging failure at `Building DMG · 94% est.` with ANSI CSI, OSC hyperlink,
NUL, target/checkpoint/version, and build-log fixtures.

## Evidence

- `before.png`: the earlier generic blue update control and one-line tooltip.
- `after.png`: the destructive retry control and interactive alert panel with
  phase/estimate, sanitized error, target, and Copy details action.
- `before-interaction.mp4` and `after-interaction.mp4`: browser recordings used
  to derive the stills.

The after-state clipboard was read back from Chromium after activating Copy
details. It contained installed/target versions, checkpoint, last phase and
estimate, packaging context, sanitized error, and exact log path. No CSI, OSC,
C0, or C1 control remained. Activating the red retry control also entered the
in-memory downloading/progress state and then returned to the deterministic
failure fixture.

## Remaining packaged acceptance

This proves the production web component behavior and supplies the PR's paired
visual evidence. It does not replace a real cold local nightly build in a
packaged Apple-Silicon LastCode app. That physical acceptance remains deferred;
the Intel host cannot enter the production arm64-only local-build path, and its
isolated Electron QA app lacked macOS assistive/screen-capture permission.
