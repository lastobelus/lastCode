import { type LastCodeSettingsImportPreview } from "@t3tools/contracts";
import { msg, T, useGT, Var } from "gt-react";
import { DownloadIcon } from "lucide-react";
import { Button } from "../ui/button";
import { useEffect, useState } from "react";
import { isElectron } from "../../env";
import { m } from "../../i18n/messages";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { useSearchableSetting } from "./settingsSearch";
import { SettingsRow, SettingsSection } from "./settingsLayout";

function useT3SettingsImport() {
  const [importPreview, setImportPreview] = useState<LastCodeSettingsImportPreview | null>(null);
  const [isImporting, setIsImporting] = useState(false);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- reads the native desktop settings-import preview when this settings control mounts
  useEffect(() => {
    const bridge = window.desktopBridge;
    if (!bridge || typeof bridge.previewT3SettingsImport !== "function") return;
    void bridge
      .previewT3SettingsImport()
      .then(setImportPreview)
      .catch((error: unknown) => {
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: m(msg("Could not inspect {t3Code} settings", { t3Code: "T3 Code" })),
            description:
              error instanceof Error ? error.message : m(msg("Settings preview failed.")),
          }),
        );
      });
  }, []);

  const importSettings = async () => {
    const bridge = window.desktopBridge;
    if (!bridge || typeof bridge.importT3Settings !== "function") return;
    setIsImporting(true);
    try {
      const result = await bridge.importT3Settings();
      toastManager.add(
        stackedThreadToast({
          type: "success",
          title: m(msg("{t3Code} settings imported", { t3Code: "T3 Code" })),
          description: m(
            msg(
              "Backed up the previous {lastCode} settings to {backupDirectory}. Restarting {lastCode}…",
              { lastCode: "LastCode", backupDirectory: result.backupDirectory },
            ),
          ),
        }),
      );
    } catch (error) {
      setIsImporting(false);
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: m(msg("Could not import {t3Code} settings", { t3Code: "T3 Code" })),
          description: error instanceof Error ? error.message : m(msg("Settings import failed.")),
        }),
      );
    }
  };

  return { importPreview, isImporting, importSettings };
}

function ImportPreview({ preview }: { preview: LastCodeSettingsImportPreview | null }) {
  const gt = useGT();
  if (!isElectron) {
    return gt("Open this page in the {lastCode} desktop app to import settings.", {
      lastCode: "LastCode",
    });
  }
  if (!preview) return gt("Inspecting {sourceDirectory}…", { sourceDirectory: "~/.t3/userdata" });
  return (
    <div className="space-y-1.5">
      <p>
        <T>
          Source: <Var>{preview.sourceDirectory}</Var>
        </T>
      </p>
      {preview.message ? <p>{preview.message}</p> : null}
      <ul className="space-y-0.5">
        {preview.categories.map((category) => (
          <li key={category.id}>
            <span className="text-foreground/80">{category.label}</span>{" "}
            <span>
              ({category.sourceFile}): {category.status}
            </span>
            {category.status === "ready" ? <span>: {category.detail}</span> : null}
          </li>
        ))}
      </ul>
      <p>
        <T>
          Not imported: <Var>{preview.excluded.join("; ")}</Var>.
        </T>
      </p>
    </div>
  );
}

export function LastCodeImportSettings() {
  const searchableSetting = useSearchableSetting();
  const gt = useGT();
  const { importPreview, isImporting, importSettings } = useT3SettingsImport();
  return (
    <SettingsSection
      title={gt("Import from {t3Code}", { t3Code: "T3 Code" })}
      icon={<DownloadIcon className="size-5" />}
    >
      <SettingsRow
        {...searchableSetting("import-t3-settings")}
        description={gt(
          "Copy selected preferences into {lastCode} once, back up the current {lastCode} files, then restart. The two apps remain independent after the import.",
          { lastCode: "LastCode" },
        )}
        status={<ImportPreview preview={importPreview} />}
        control={
          <Button
            size="sm"
            variant="outline"
            disabled={!importPreview?.canImport || isImporting}
            onClick={() => void importSettings()}
          >
            {isImporting ? <T>Importing…</T> : <T>Import and restart</T>}
          </Button>
        }
      />
    </SettingsSection>
  );
}
