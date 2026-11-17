import { useAtomValue } from "@effect/atom-react";
import { Link } from "@tanstack/react-router";
import { scopeThreadRef, scopedThreadKey } from "@t3tools/client-runtime/environment";
import { taggedThreadSearch } from "@t3tools/client-runtime/thread-tag-search";
import { threadSearchMatchKey } from "@t3tools/client-runtime/state/thread-search";
import type { EnvironmentId } from "@t3tools/contracts";
import { XIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { useClientSettings } from "../../hooks/useSettings";
import { useProjects, useQuietThreadShells } from "../../state/entities";
import { useThreadSearch } from "../../state/queries";
import { threadFamilies } from "../../state/threads";
import { appAtomRegistry } from "../../rpc/atomRegistry";
import { useNowMinute } from "../../hooks/useNowMinute";
import { findForMessageMatch, openThreadFindOnQuery } from "../../components/chat/threadFindStore";
import { isElectron } from "../../env";
import { SidebarChromeHeader, SidebarChromeFooter } from "../../components/sidebar/SidebarChrome";
import {
  SidebarContent,
  SidebarGroup,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from "../../components/ui/sidebar";
import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import { Switch } from "../../components/ui/switch";
import { useTagEnvironmentIds, useTagFilterStore } from "./state";
import { tagResultRows, tagResultShells } from "./query";
import { TagThreadRow } from "./TagThreadRow";

export function useActiveTagFilter() {
  const enabled = useClientSettings((settings) => settings.lastcodeThreadTagsSidebarEnabled);
  const tag = useTagFilterStore((state) => state.tag);
  return enabled ? tag : null;
}

export function TagSidebarResults({ tag }: { readonly tag: string }) {
  const archived = useTagFilterStore((state) => state.archived);
  const select = useTagFilterStore((state) => state.select);
  const setArchived = useTagFilterStore((state) => state.setArchived);
  const environmentIds = useTagEnvironmentIds();
  const [query, setQuery] = useState("");
  const key = JSON.stringify({ environmentIds, tag, archived });
  const scopeKey = JSON.stringify({ key, query });
  const [pagination, setPagination] = useState({ scopeKey, cursor: 0 });
  const cursor = pagination.scopeKey === scopeKey ? pagination.cursor : 0;
  if (pagination.scopeKey !== scopeKey) setPagination({ scopeKey, cursor: 0 });
  const setCursor = (cursor: number) => setPagination({ scopeKey, cursor });
  const projects = useProjects();
  const { isMobile, setOpenMobile } = useSidebar();
  const result = useAtomValue(tagResultRows(key));
  const search = useThreadSearch(environmentIds, query);
  const messageMatches = new Map(
    (search.query === query.trim() ? search.matches : []).map((match) => [
      threadSearchMatchKey(match),
      match,
    ]),
  );
  const threads = taggedThreadSearch(
    result.threads,
    query,
    messageMatches,
    Date.parse(useNowMinute()),
  );
  const page = threads.slice(cursor, cursor + 100);
  const titles = new Map(
    useQuietThreadShells().map((thread) => [
      scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id)),
      thread.title,
    ]),
  );
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- retain authoritative query rows in the existing family registry while the tag view is mounted
  useEffect(() => {
    const target = JSON.parse(key) as { environmentIds: EnvironmentId[]; archived: boolean };
    if (target.archived) return;
    const releases = target.environmentIds.map((environmentId) =>
      threadFamilies.mountRows(
        appAtomRegistry,
        environmentId,
        `tags:${key}`,
        tagResultShells(JSON.stringify({ queryKey: key, environmentId })),
      ),
    );
    return () => {
      for (const release of releases) release();
    };
  }, [key]);
  return (
    <>
      <SidebarChromeHeader isElectron={isElectron} />
      <SidebarContent
        fixedHeader={
          <SidebarGroup className="z-[1]">
            <Input
              type="search"
              size="compact"
              aria-label="Search tagged threads"
              placeholder="Search threads…"
              value={query}
              onValueChange={setQuery}
            />
            <div className="flex min-w-0 items-center gap-1">
              <span className="min-w-0 flex-1 truncate font-mono text-xs">#{tag}</span>
              <span className="shrink-0 text-xs text-muted-foreground">and nested tags</span>
              <Button
                size="icon-xs"
                variant="ghost"
                aria-label="Clear tag filter"
                onClick={() => select(null)}
              >
                <XIcon className="size-3.5" />
              </Button>
            </div>
            <label className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
              Archived only
              <Switch size="sm" checked={archived} onCheckedChange={setArchived} />
            </label>
          </SidebarGroup>
        }
      >
        <SidebarGroup>
          {result.loading || search.isPending ? (
            <p className="px-2 py-2 text-xs text-muted-foreground" role="status">
              Finding threads…
            </p>
          ) : null}
          {result.failed ? (
            <p className="px-2 py-2 text-xs text-destructive" role="alert">
              Could not search every connection. Results may be incomplete.
            </p>
          ) : null}
          {!result.loading && !search.isPending && !result.failed && threads.length === 0 ? (
            <p className="px-2 py-2 text-xs text-muted-foreground">
              {query.trim()
                ? "No matching threads."
                : archived
                  ? "No archived threads with this tag"
                  : "No threads with this tag"}
            </p>
          ) : null}
          <SidebarMenu>
            {page.map(({ thread, messageId }) => {
              const environmentId = thread.environmentId;
              const project = projects.find(
                (project) =>
                  project.environmentId === environmentId && project.id === thread.projectId,
              );
              const label = (
                <TagThreadRow
                  thread={thread}
                  projectTitle={project?.title ?? "Unknown project"}
                  parentTitles={titles}
                />
              );
              return (
                <SidebarMenuItem key={`${environmentId}/${thread.id}`}>
                  {archived ? (
                    <div className="px-2 py-1.5 text-sm">{label}</div>
                  ) : (
                    <SidebarMenuButton
                      size="lg"
                      render={
                        <Link
                          to="/$environmentId/$threadId"
                          params={scopeThreadRef(environmentId, thread.id)}
                          onClick={() => {
                            const match = messageId
                              ? messageMatches.get(
                                  threadSearchMatchKey({ environmentId, threadId: thread.id }),
                                )
                              : undefined;
                            if (match)
                              openThreadFindOnQuery(
                                scopedThreadKey(scopeThreadRef(environmentId, thread.id)),
                                findForMessageMatch(match, search.query),
                              );
                            if (isMobile) setOpenMobile(false);
                          }}
                        />
                      }
                    >
                      {label}
                    </SidebarMenuButton>
                  )}
                </SidebarMenuItem>
              );
            })}
          </SidebarMenu>
          <div className="flex gap-1 px-2 py-2">
            {cursor > 0 ? (
              <Button
                size="xs"
                variant="ghost"
                onClick={() => setCursor(Math.max(0, cursor - 100))}
              >
                Previous
              </Button>
            ) : null}
            {threads.length > cursor + 100 ? (
              <Button size="xs" variant="ghost" onClick={() => setCursor(cursor + 100)}>
                Next
              </Button>
            ) : null}
          </div>
          {archived ? (
            <Link className="px-2 text-xs text-muted-foreground underline" to="/settings/archived">
              Manage archived threads
            </Link>
          ) : null}
        </SidebarGroup>
      </SidebarContent>
      <SidebarChromeFooter />
    </>
  );
}
