import { describe, expect, vi, beforeEach } from "vite-plus/test";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import type { BrowserSession } from "./BrowserSession.ts";
import { resolvePartitionScope } from "./BrowserProfileScope.ts";

const fixture = vi.hoisted(() => ({
  options: [] as Electron.BrowserWindowConstructorOptions[],
  mismatch: false,
  destroyed: 0,
}));
vi.mock("electron", () => ({
  BrowserWindow: class {
    webContents;
    constructor(options: Electron.BrowserWindowConstructorOptions) {
      fixture.options.push(options);
      this.webContents = {
        session: fixture.mismatch ? {} : options.webPreferences?.session,
        setIgnoreMenuShortcuts: () => undefined,
      };
    }
    destroy() {
      fixture.destroyed += 1;
    }
  },
}));
import * as BrowserRootWindow from "./BrowserRootWindow.ts";

beforeEach(() => {
  fixture.options.length = 0;
  fixture.mismatch = false;
  fixture.destroyed = 0;
});

describe("native automation root session ownership", () => {
  it.effect("uses the existing session for each exact environment/profile scope", () =>
    Effect.gen(function* () {
      const calls: Array<{ scope: string; persistent: boolean; namespace: string | undefined }> =
        [];
      const sessions = new Map<string, Electron.Session>();
      const getSession = (scope: string, persistent: boolean, namespace: string | undefined) => {
        calls.push({ scope, persistent, namespace });
        const key = JSON.stringify([scope, persistent, namespace]);
        let selected = sessions.get(key);
        if (!selected) {
          selected = {} as Electron.Session;
          sessions.set(key, selected);
        }
        return Effect.succeed(selected);
      };
      const service = { getSession } as unknown as BrowserSession["Service"];
      for (const [environmentId, profileId] of [
        ["environment-a", "default"],
        ["environment-a", "developer"],
        ["environment-b", "developer"],
        ["environment-a", "incognito"],
        ["environment-a", "developer"],
      ])
        yield* BrowserRootWindow.create(
          service,
          { environmentId: environmentId!, profileId: profileId! },
          resolvePartitionScope(environmentId!, profileId!, "primary-environment"),
        );
      expect(calls).toEqual([
        { scope: "environment-a", persistent: true, namespace: undefined },
        { scope: '["primary-environment","developer"]', persistent: true, namespace: "profile" },
        { scope: '["primary-environment","developer"]', persistent: true, namespace: "profile" },
        { scope: '["environment-a","incognito"]', persistent: false, namespace: "profile" },
        { scope: '["primary-environment","developer"]', persistent: true, namespace: "profile" },
      ]);
      expect(fixture.options[1]?.webPreferences?.session).toBe(
        fixture.options[4]?.webPreferences?.session,
      );
      expect(fixture.options[1]?.webPreferences?.session).toBe(
        fixture.options[2]?.webPreferences?.session,
      );
      for (const options of fixture.options) {
        expect(options.show).toBe(false);
        expect(options.focusable).toBe(false);
        expect(options.webPreferences?.partition).toBeUndefined();
      }
    }),
  );

  it.effect("destroys a root that fails to retain the selected session", () =>
    Effect.gen(function* () {
      fixture.mismatch = true;
      const service = {
        getSession: () => Effect.succeed({} as Electron.Session),
      } as unknown as BrowserSession["Service"];
      const error = yield* BrowserRootWindow.create(
        service,
        { environmentId: "environment-a", profileId: "default" },
        resolvePartitionScope("environment-a", "default", "primary-environment"),
      ).pipe(Effect.flip);
      expect(error.reason).toBe("guest-unavailable");
      expect(fixture.destroyed).toBe(1);
    }),
  );
});
