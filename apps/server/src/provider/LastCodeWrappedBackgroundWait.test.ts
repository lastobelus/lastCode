import { describe, expect, it } from "vite-plus/test";

import { isLastCodeWrappedCommand } from "./LastCodeWrappedBackgroundWait.ts";

const upstream = "1234567890abcdef1234567890abcdef12345678";
const tag = "lastcode/checkpoint/v0.1.0-nightly.20261122.1";

describe("wrapped LastCode commands", () => {
  it.each([
    "./scripts/lc-run prepare",
    "sh ./scripts/lc-run prepare",
    "pnpm exec sh ./scripts/lc-run prepare",
    "/bin/zsh -lc 'cd /worktree && /bin/sh ./scripts/lc-run ci --quick'",
    "node scripts/lastcode-run.ts ci --quick",
    "node ./scripts/lastcode-run.ts ci --full",
    "pnpm exec ./scripts/lc-run wait-checkpoint",
    "npm exec -- node ./scripts/lastcode-run.ts prepare",
    `vp exec ./scripts/lc-run prepare-checkpoint --upstream ${upstream}`,
    `/bin/zsh -lc 'cd "/path with spaces" && CI=1 pnpm exec ./scripts/lc-run package --tag ${tag}'`,
    "/bin/bash -c 'cd -- /worktree && env CI=true MODE=\"space separated\" ./scripts/lc-run prepare'",
    "MISE_ACTIVATE_AGGRESSIVE=1 mise exec node@26.13.1 -- node /checkout/scripts/lastcode-run.ts prepare",
    "/bin/zsh -lc \"/bin/bash -c 'cd /worktree && ./scripts/lc-run ci --quick'\"",
  ])("recognizes %s", (command) => {
    expect(isLastCodeWrappedCommand(command)).toBe(true);
  });

  it.each([
    "vp run dev",
    "sh ./scripts/unrelated.sh ./scripts/lc-run prepare",
    "node scripts/service.ts --watch",
    "./scripts/lc-run watch",
    "./scripts/lc-run package",
    "./scripts/lc-run prepare-checkpoint",
    "pnpm run ./scripts/lc-run prepare",
    "echo './scripts/lc-run prepare'",
    "echo ./scripts/lc-run prepare",
    "'./scripts/lc-run prepare'",
    "printf %s 'node scripts/lastcode-run.ts prepare'",
    "node -e 'console.log(\"scripts/lastcode-run.ts\")' prepare",
    "node OTHERscripts/lastcode-run.ts prepare",
    "node scripts/lastcode-run.ts.backup prepare",
    "./scripts/lc-run prepare && vp run dev",
    "./scripts/lc-run prepare | tee output",
    "cd /worktree; ./scripts/lc-run prepare",
    'cd "$PWD" && ./scripts/lc-run prepare',
    "cd -P /worktree && ./scripts/lc-run prepare",
    "echo cd /worktree && ./scripts/lc-run prepare",
    "cd '/worktree && ./scripts/lc-run prepare'",
    "sh -c './scripts/lc-run prepare; vp run dev'",
    'sh -c "$(cat script)"',
  ])("ignores %s", (command) => {
    expect(isLastCodeWrappedCommand(command)).toBe(false);
  });
});
