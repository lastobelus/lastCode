import { type LastCodeSettingsImportPreview } from "@t3tools/contracts";
import { DownloadIcon } from "lucide-react";
import { Button } from "../ui/button";
import { useEffect, useState } from "react";
import { isElectron } from "../../env";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { searchableSetting } from "./settingsSearch";
import { SettingsRow, SettingsSection } from "./settingsLayout";

function useT3SettingsImport() {
  const [importPreview, setImportPreview] = useState<LastCodeSettingsImportPreview | null>(null);
  const [isImporting, setIsImporting] = useState(false);

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
            title: "Could not inspect T3 Code settings",
            description: error instanceof Error ? error.message : "Settings preview failed.",
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
          title: "T3 Code settings imported",
          description: `Backed up the previous LastCode settings to ${result.backupDirectory}. Restarting LastCode…`,
        }),
      );
    } catch (error) {
      setIsImporting(false);
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Could not import T3 Code settings",
          description: error instanceof Error ? error.message : "Settings import failed.",
        }),
      );
    }
  };

  return { importPreview, isImporting, importSettings };
}

function ImportPreview({ preview }: { preview: LastCodeSettingsImportPreview | null }) {
  if (!isElectron) return "Open this page in the LastCode desktop app to import settings.";
  if (!preview) return "Inspecting ~/.t3/userdata…";
  return (
    <div className="space-y-1.5">
      <p>Source: {preview.sourceDirectory}</p>
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
      <p>Not imported: {preview.excluded.join("; ")}.</p>
    </div>
  );
}

export function LastCodeImportSettings() {
  const { importPreview, isImporting, importSettings } = useT3SettingsImport();
  return (
    <SettingsSection title="Import from T3 Code" icon={<DownloadIcon className="size-5" />}>
      <SettingsRow
        {...searchableSetting("import-t3-settings")}
        description="Copy selected preferences into LastCode once, back up the current LastCode files, then restart. The two apps remain independent after the import."
        status={<ImportPreview preview={importPreview} />}
        control={
          <Button
            size="sm"
            variant="outline"
            disabled={!importPreview?.canImport || isImporting}
            onClick={() => void importSettings()}
          >
            {isImporting ? "Importing…" : "Import and restart"}
          </Button>
        }
      />
    </SettingsSection>
  );
}
