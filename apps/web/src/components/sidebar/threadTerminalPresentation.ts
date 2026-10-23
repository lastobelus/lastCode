import type { PreviewHostingLeaseMetadata, TerminalSummary } from "@t3tools/contracts";

/** Preview processes sleep at a fixed deadline, shown in the viewer's local time. */
export function formatPreviewExpiry(expiresAt: string): string | null {
  const date = new Date(expiresAt);
  if (!Number.isFinite(date.getTime())) return null;
  const day = date.toLocaleDateString("en-US", { month: "short", day: "numeric" });
  const time = `${String(date.getHours()).padStart(2, "0")}${String(date.getMinutes()).padStart(2, "0")}`;
  return `${day}, ${time}`;
}

export function threadTerminalProcessLabels(
  terminals: ReadonlyArray<TerminalSummary>,
  previews: ReadonlyArray<PreviewHostingLeaseMetadata>,
): ReadonlyArray<{ terminalId: string; label: string }> {
  const previewsByTerminal = new Map(previews.map((preview) => [preview.terminalId, preview]));
  const running = terminals.filter((terminal) => terminal.hasRunningSubprocess);
  const labels = running.map((terminal) => {
    const preview = previewsByTerminal.get(terminal.terminalId);
    const expiry = preview ? formatPreviewExpiry(preview.expiresAt) : null;
    return {
      terminalId: terminal.terminalId,
      label: expiry ? `${terminal.label} (preview sleeps ${expiry})` : terminal.label,
    };
  });
  const runningIds = new Set(running.map((terminal) => terminal.terminalId));
  for (const preview of previews) {
    if (runningIds.has(preview.terminalId)) continue;
    labels.push({
      terminalId: preview.terminalId,
      label: `${new URL(preview.url).host} (preview ${preview.status === "starting" ? "starting" : "reopens when viewed"})`,
    });
  }
  return labels;
}
