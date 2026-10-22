// @effect-diagnostics nodeBuiltinImport:off -- This Vite adapter test executes the emitted startup script in a sandbox.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeVM from "node:vm";
import { expect, it } from "vite-plus/test";
import { previewSettingsPlugin } from "./previewSettings";

it.each([undefined, "", "   "])(
  "ignores an old snapshot when the current launch has no preparation source (%s)",
  (source) => {
    const home = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "preview-settings-"));
    try {
      NodeFS.mkdirSync(NodePath.join(home, "userdata"));
      NodeFS.writeFileSync(
        NodePath.join(home, "userdata", "preview-settings.json"),
        JSON.stringify({
          id: "earlier-launch",
          localStorage: { "t3code:theme": "old-theme" },
        }),
      );
      const values = new Map<string, string>();
      const tags = previewSettingsPlugin(home, source).transformIndexHtml.handler();
      for (const tag of tags ?? []) {
        NodeVM.runInNewContext(tag.children, {
          localStorage: {
            getItem: (key: string) => values.get(key) ?? null,
            setItem: (key: string, value: string) => values.set(key, value),
            removeItem: (key: string) => values.delete(key),
          },
        });
      }
      expect(values.size).toBe(0);
      expect(tags).toBeUndefined();
    } finally {
      NodeFS.rmSync(home, { recursive: true, force: true });
    }
  },
);

it("seeds saved preferences before startup, preserving edits until the next prepared launch", () => {
  const home = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "preview-settings-"));
  try {
    NodeFS.mkdirSync(NodePath.join(home, "userdata"));
    const values = new Map<string, string>([["t3code:theme", "stale-theme"]]);
    const localStorage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key),
    };
    const saved = { lastcodeSidebarEnabled: true, fontSizeInterface: 17, wordWrap: false };
    const snapshot = {
      id: "launch-1",
      localStorage: {
        "t3code:client-settings:v1": JSON.stringify(saved),
        "t3code:theme": null,
        "t3code:theme-halves:v1": '{"light":"custom-light"}',
      },
    };
    const prepare = () => {
      NodeFS.writeFileSync(
        NodePath.join(home, "userdata", "preview-settings.json"),
        JSON.stringify(snapshot),
      );
      const transform = previewSettingsPlugin(home, "/saved-app/userdata").transformIndexHtml;
      if (!transform || typeof transform !== "object" || !transform.handler) {
        throw new Error("Missing preview startup transform");
      }
      const tags = transform.handler();
      if (!Array.isArray(tags) || typeof tags[0]?.children !== "string") {
        throw new Error("Missing preview preference seed");
      }
      return tags[0].children;
    };
    const script = prepare();
    NodeVM.runInNewContext(script, { localStorage });
    expect(JSON.parse(values.get("t3code:client-settings:v1")!)).toEqual(saved);
    expect(values.has("t3code:theme")).toBe(false);
    expect(values.get("t3code:theme-halves:v1")).toBe(
      snapshot.localStorage["t3code:theme-halves:v1"],
    );

    const edited = { ...saved, lastcodeSidebarEnabled: false };
    localStorage.setItem("t3code:client-settings:v1", JSON.stringify(edited));
    NodeVM.runInNewContext(script, { localStorage });
    expect(JSON.parse(values.get("t3code:client-settings:v1")!)).toEqual(edited);

    snapshot.id = "launch-2";
    NodeVM.runInNewContext(prepare(), { localStorage });
    expect(JSON.parse(values.get("t3code:client-settings:v1")!)).toEqual(saved);
  } finally {
    NodeFS.rmSync(home, { recursive: true, force: true });
  }
});
