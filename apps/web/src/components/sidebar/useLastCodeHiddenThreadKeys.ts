import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId } from "@t3tools/contracts";
import { useServerConfigs } from "../../state/entities";
import { environmentThreadShells } from "../../state/threads";
import type { SidebarThreadSummary } from "../../types";
import { lastcodeSidebarThreadKey } from "../lastcodeSidebarFamilies.logic";

const NO_HIDDEN_THREADS: ReadonlySet<string> = new Set();

export function useLastCodeTagHiddenThreadKeys(threads: readonly SidebarThreadSummary[]) {
  const configs = useServerConfigs();
  const tagsByEnvironment = new Map<EnvironmentId, ReadonlySet<string>>();
  for (const [environmentId, config] of configs) {
    const { settings } = config;
    if (!settings.hideTaggedThreads) continue;
    const tags = new Set(settings.hiddenThreadTags.map((tag) => tag.trim()).filter(Boolean));
    if (tags.size) tagsByEnvironment.set(environmentId, tags);
  }
  if (!tagsByEnvironment.size) return NO_HIDDEN_THREADS;
  const hidden = new Set<string>();
  for (const thread of threads) {
    const tags = tagsByEnvironment.get(thread.environmentId);
    if (tags && thread.source.tags?.some((tag) => tags.has(tag)))
      hidden.add(lastcodeSidebarThreadKey(thread));
  }
  return hidden;
}

/** LastCode has a fallback group for visible children of a hidden owner. */
export function useLastCodeHiddenThreadKeys(threads: readonly SidebarThreadSummary[]) {
  const tagHidden = useLastCodeTagHiddenThreadKeys(threads);
  const annotationHidden = useAtomValue(environmentThreadShells.annotationHiddenThreadKeysAtom);
  if (tagHidden.size === 0) return annotationHidden;
  return annotationHidden.size === 0 ? tagHidden : new Set([...tagHidden, ...annotationHidden]);
}
