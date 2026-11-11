// @effect-diagnostics nodeBuiltinImport:off -- Vite initializes browser storage before the app runtime starts.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import type { Plugin } from "vite-plus";

export function previewSettingsPlugin(
  homeDir: string | undefined,
  settingsSource: string | undefined,
) {
  return {
    name: "lastcode-preview-settings",
    apply: "serve",
    transformIndexHtml: {
      order: "pre",
      handler() {
        if (!homeDir || !settingsSource?.trim()) return;
        const path = NodePath.join(homeDir, "userdata", "preview-settings.json");
        if (!NodeFS.existsSync(path)) return;
        const snapshot: unknown = JSON.parse(NodeFS.readFileSync(path, "utf8"));
        const serialized = JSON.stringify(snapshot).replaceAll("<", "\\u003c");
        return [
          {
            tag: "script",
            injectTo: "head-prepend",
            children: `(() => {
              const snapshot = ${serialized};
              const marker = "t3code:preview-settings-seed";
              if (localStorage.getItem(marker) === snapshot.id) return;
              for (const [key, value] of Object.entries(snapshot.localStorage)) {
                if (value === null) localStorage.removeItem(key);
                else localStorage.setItem(key, value);
              }
              localStorage.setItem(marker, snapshot.id);
            })();`,
          },
        ];
      },
    },
  } satisfies Plugin;
}
