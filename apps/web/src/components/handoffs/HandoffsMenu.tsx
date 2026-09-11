import type { ScopedThreadRef } from "@t3tools/contracts";
import { useClientSettings } from "~/hooks/useSettings";
import { useThreadHandoffs, handoffDestination, handoffTitle } from "~/handoffs/handoffsStore";
import { useOpenHandoff } from "~/handoffs/useOpenHandoff";
import { MenuItem, MenuSeparator } from "~/components/ui/menu";

export function HandoffsMenu({
  threadRef,
  onShowAll,
}: {
  threadRef: ScopedThreadRef;
  onShowAll: () => void;
}) {
  const entries = useThreadHandoffs(threadRef);
  const limit = useClientSettings((settings) => settings.handoffsMenuLimit);
  const openHandoff = useOpenHandoff();
  const visible = entries.slice(0, limit);
  return (
    <>
      <MenuSeparator />
      <MenuItem disabled>Handoffs</MenuItem>
      {visible.length === 0 ? (
        <MenuItem disabled>No handoffs yet</MenuItem>
      ) : (
        visible.map((entry) => (
          <MenuItem key={entry.id} onClick={() => void openHandoff(threadRef, entry)}>
            <span className="min-w-0">
              <span className="block truncate">{handoffTitle(entry)}</span>
              <span className="block truncate text-xs text-muted-foreground">
                {handoffDestination(entry)}
              </span>
            </span>
          </MenuItem>
        ))
      )}
      {entries.length > limit ? <MenuItem onClick={onShowAll}>Show all…</MenuItem> : null}
    </>
  );
}
