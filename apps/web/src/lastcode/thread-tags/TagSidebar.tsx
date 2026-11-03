import { useAtomValue } from "@effect/atom-react";
import { Link } from "@tanstack/react-router";
import { scopeThreadRef, scopedThreadKey } from "@t3tools/client-runtime/environment";
import { hiddenThreadKeys } from "@t3tools/client-runtime/state/threads";
import type { EnvironmentId, OrchestrationV2ThreadShell } from "@t3tools/contracts";
import { AsyncResult, Atom } from "effect/reactivity";
import * as Option from "effect/Option";
import { XIcon } from "lucide-react";
import { useState } from "react";
import { useClientSettings } from "../../hooks/useSettings";
import { useProjects } from "../../state/entities";
import { environmentThreadShells } from "../../state/threads";
import { serverEnvironment } from "../../state/server";
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
import { Switch } from "../../components/ui/switch";
import { tagMatches, useTagEnvironmentIds, useTagFilterStore } from "./state";

const matchPages = Atom.family((key: string) => {
  const target = JSON.parse(key) as {
    environmentIds: EnvironmentId[];
    tag: string;
    archived: boolean;
    cursor: number;
  };
  return Atom.make((get) => {
    const entries: { environmentId: EnvironmentId; thread: OrchestrationV2ThreadShell }[] = [];
    const environments = [];
    let loading = false;
    let failed = false;
    let hasMore = false;
    for (const environmentId of target.environmentIds) {
      const pageResult = get(
        tagMatches({
          environmentId,
          input: {
            tag: target.tag,
            archived: target.archived,
            cursor: target.cursor,
            limit: 100,
          },
        }),
      );
      const page = Option.getOrNull(AsyncResult.value(pageResult));
      loading ||= pageResult.waiting || AsyncResult.isInitial(pageResult);
      failed ||= AsyncResult.isFailure(pageResult);
      hasMore ||= page?.nextCursor != null;
      const threads = page?.threads ?? [];
      environments.push({
        environmentId,
        threads,
        hiddenTags: get(serverEnvironment.hiddenThreadTagsAtom(environmentId)),
      });
      entries.push(...threads.map((thread) => ({ environmentId, thread })));
    }
    const hidden = hiddenThreadKeys(
      environments,
      get(environmentThreadShells.hiddenThreadKeysAtom),
      new Set(get(environmentThreadShells.threadRefsAtom).map((ref) => scopedThreadKey(ref))),
    );
    return {
      entries: entries.filter(
        ({ environmentId, thread }) =>
          !hidden.has(scopedThreadKey(scopeThreadRef(environmentId, thread.id))),
      ),
      loading,
      failed,
      hasMore,
    };
  });
});

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
  const [cursor, setCursor] = useState(0);
  const projects = useProjects();
  const { isMobile, setOpenMobile } = useSidebar();
  const key = JSON.stringify({ environmentIds, tag, archived, cursor });
  const result = useAtomValue(matchPages(key));
  return (
    <>
      <SidebarChromeHeader isElectron={isElectron} />
      <SidebarContent
        fixedHeader={
          <SidebarGroup className="z-[1]">
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
              <Switch
                size="sm"
                checked={archived}
                onCheckedChange={(value) => {
                  setArchived(value);
                  setCursor(0);
                }}
              />
            </label>
          </SidebarGroup>
        }
      >
        <SidebarGroup>
          {result.loading ? (
            <p className="px-2 py-2 text-xs text-muted-foreground" role="status">
              Finding threads…
            </p>
          ) : null}
          {result.failed ? (
            <p className="px-2 py-2 text-xs text-destructive" role="alert">
              Could not search every connection. Results may be incomplete.
            </p>
          ) : null}
          {!result.loading && !result.failed && result.entries.length === 0 ? (
            <p className="px-2 py-2 text-xs text-muted-foreground">
              {archived ? "No archived threads with this tag" : "No threads with this tag"}
            </p>
          ) : null}
          <SidebarMenu>
            {result.entries.map(({ environmentId, thread }) => {
              const project = projects.find(
                (project) =>
                  project.environmentId === environmentId && project.id === thread.projectId,
              );
              const label = (
                <span className="flex min-w-0 flex-col">
                  <span className="truncate">{thread.title}</span>
                  <span className="truncate text-xs text-muted-foreground">
                    {project?.title ?? "Unknown project"}
                  </span>
                </span>
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
            {result.hasMore ? (
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
