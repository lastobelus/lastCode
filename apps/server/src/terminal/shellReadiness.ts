import type { TerminalEvent } from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as TerminalManager from "./Manager.ts";

// Line editors (zsh, fish, bash 5.1+) enable bracketed paste when they start reading a command.
const BRACKETED_PASTE_ON = "\x1b[?2004h";
const BRACKETED_PASTE_OFF = "\x1b[?2004l";
// Longer than one subprocess poll plus its ps timeout, so a startup prompt is seen as busy first.
const SHELL_READINESS_INTERVAL = "3 seconds";

function lineEditorReading(text: string, previous: boolean): boolean {
  const on = text.lastIndexOf(BRACKETED_PASTE_ON);
  const off = text.lastIndexOf(BRACKETED_PASTE_OFF);
  return on === off ? previous : on > off;
}

export const make = Effect.gen(function* () {
  const terminalManager = yield* TerminalManager.TerminalManager;
  // Opening may replace a shell; discard that shell's buffered readiness and exit events.
  const stageTerminalEvents = Effect.fn("ProjectSetupScriptRunner.stageTerminalEvents")(
    function* (input: { readonly threadId: string; readonly terminalId: string }) {
      const listeners = new Set<(event: TerminalEvent) => Effect.Effect<void>>();
      const pending: TerminalEvent[] = [];
      let opened = false;
      const emit = (event: TerminalEvent) =>
        Effect.forEach([...listeners], (listener) => listener(event), { discard: true });
      const unsubscribe = yield* terminalManager.subscribe((event) => {
        if (event.threadId !== input.threadId || event.terminalId !== input.terminalId)
          return Effect.void;
        if (opened) return emit(event);
        if (event.type === "started" || event.type === "restarted") pending.length = 0;
        pending.push(event);
        return Effect.void;
      });
      const subscribe: TerminalManager.TerminalManager["Service"]["subscribe"] = (listener) =>
        Effect.sync(() => {
          listeners.add(listener);
          return () => {
            listeners.delete(listener);
            if (listeners.size === 0) unsubscribe();
          };
        });
      const activate = Effect.gen(function* () {
        while (pending.length > 0) {
          const batch = pending.splice(0);
          yield* Effect.forEach(batch, emit, { discard: true });
        }
        opened = true;
      });
      return { subscribe, activate, unsubscribe };
    },
  );

  // Input typed during shell startup can be read by an rc-file prompt (fnm, nvm) instead of the
  // shell, which loses the command. Subscribe before the terminal opens so no activity is missed.
  const watchShellReadiness = Effect.fn("ProjectSetupScriptRunner.watchShellReadiness")(
    function* (input: {
      readonly threadId: string;
      readonly terminalId: string;
      readonly onStartupPrompt: Effect.Effect<void>;
      readonly subscribe: TerminalManager.TerminalManager["Service"]["subscribe"];
    }) {
      const outcome = yield* Deferred.make<"ready" | "exited">();
      let reading = false;
      let carry = "";
      let readinessRevision = 0;
      const unsubscribe = yield* input.subscribe((event) => {
        if (event.threadId !== input.threadId || event.terminalId !== input.terminalId) {
          return Effect.void;
        }
        if (event.type !== "output") readinessRevision += 1;
        // A new shell process starts idle; the manager resets its subprocess state without an event.
        if (event.type === "started" || event.type === "restarted") {
          reading = false;
          carry = "";
        }
        if (event.type === "output") {
          const text = carry + event.data;
          // Background output can continue at the prompt; editor signals still invalidate foreground checks.
          if (text.includes(BRACKETED_PASTE_ON) || text.includes(BRACKETED_PASTE_OFF))
            readinessRevision += 1;
          carry = text.slice(-(BRACKETED_PASTE_ON.length - 1));
          reading = lineEditorReading(text, reading);
        }
        if (event.type === "exited" || event.type === "closed") {
          return Deferred.succeed(outcome, "exited").pipe(Effect.asVoid);
        }
        return reading ? Deferred.succeed(outcome, "ready").pipe(Effect.asVoid) : Effect.void;
      });
      // Background jobs remain owned, but only foreground programs can hold startup input.
      const foregroundReady = Effect.gen(function* () {
        while (true) {
          const seen = readinessRevision;
          yield* Effect.sleep(SHELL_READINESS_INTERVAL);
          if (readinessRevision !== seen) continue;
          const busy = yield* terminalManager.hasForegroundSubprocess({
            threadId: input.threadId,
            terminalId: input.terminalId,
          });
          if (readinessRevision !== seen) continue;
          if (!busy) return "ready" as const;
          yield* input.onStartupPrompt;
        }
      });
      // Restored history can hold a previous shell's line editor state, so only live output counts.
      const wait = Deferred.await(outcome).pipe(Effect.raceFirst(foregroundReady));
      return { wait, unsubscribe };
    },
  );

  return { stageTerminalEvents, watchShellReadiness };
});
