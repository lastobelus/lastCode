/** Called only when the incoming original is opened, before the existing Markdown renderer. */
export function formatIncomingMessageOriginal(text: string): string {
  const trimmed = text.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return text;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (parsed !== null && typeof parsed === "object") {
      return `\`\`\`json\n${JSON.stringify(parsed, null, 2)}\n\`\`\``;
    }
  } catch {
    // A partial JSON payload or prose beginning with a bracket stays verbatim.
  }
  return text;
}
