import type { ScopedThreadRef } from "@t3tools/contracts";
import { Search, FileText, Globe2 } from "lucide-react";
import { useGT } from "gt-react";
import { useState } from "react";

import {
  useThreadHandoffs,
  handoffDestination,
  handoffTitle,
  type HandoffEntry,
} from "~/handoffs/handoffsStore";
import { useOpenHandoff } from "~/handoffs/useOpenHandoff";

export function filterHandoffs(
  entries: readonly HandoffEntry[],
  query: string,
): readonly HandoffEntry[] {
  const needle = query.trim().toLocaleLowerCase();
  if (!needle) return entries;
  return entries.filter((entry) =>
    `${handoffTitle(entry)} ${handoffDestination(entry)}`.toLocaleLowerCase().includes(needle),
  );
}

export function HandoffsPanel({ threadRef }: { threadRef: ScopedThreadRef }) {
  const gt = useGT();
  const entries = useThreadHandoffs(threadRef);
  const openHandoff = useOpenHandoff();
  const [query, setQuery] = useState("");
  const filtered = filterHandoffs(entries, query);

  return (
    <section className="flex min-h-0 flex-1 flex-col" aria-label={gt("Handoffs")}>
      <div className="border-b p-3">
        <label className="flex items-center gap-2 rounded-md border px-2 py-1.5 text-sm">
          <Search className="size-4 text-muted-foreground" />
          <input
            className="min-w-0 flex-1 bg-transparent outline-none"
            aria-label={gt("Search handoffs")}
            placeholder={gt("Search handoffs")}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
      </div>
      <div className="min-h-0 flex-1 overflow-auto p-2">
        {filtered.length === 0 ? (
          <p className="p-3 text-sm text-muted-foreground">
            {query.trim() ? gt("No matching handoffs") : gt("No handoffs yet")}
          </p>
        ) : (
          filtered.map((entry) => (
            <HandoffRow
              key={entry.id}
              entry={entry}
              onOpen={() => void openHandoff(threadRef, entry)}
            />
          ))
        )}
      </div>
    </section>
  );
}

function HandoffRow({ entry, onOpen }: { entry: HandoffEntry; onOpen: () => void }) {
  const destination = handoffDestination(entry);
  const isUrl = /^https?:\/\//u.test(destination);
  return (
    <button
      type="button"
      className="flex w-full items-start gap-2 rounded-md p-2 text-left hover:bg-accent"
      onClick={onOpen}
    >
      {isUrl ? (
        <Globe2 className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
      ) : (
        <FileText className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
      )}
      <span className="min-w-0">
        <span className="block truncate text-sm">{handoffTitle(entry)}</span>
        <span className="block truncate text-xs text-muted-foreground">{destination}</span>
        <time className="block text-2xs text-muted-foreground">
          {new Date(entry.lastOpenedAt).toLocaleString()}
        </time>
      </span>
    </button>
  );
}
