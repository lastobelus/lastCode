import { useAtom, useAtomValue } from "@effect/atom-react";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import {
  discoverableProjects,
  isTemporaryProject,
  showTemporaryProjectsAtom,
} from "@t3tools/client-runtime/state/temporary-projects";
import { useGT } from "gt-react-native";
import { useMemo } from "react";
import { useProjects } from "./entities";

export function useDiscoverableProjects(projects: readonly EnvironmentProject[]) {
  const showTemporary = useAtomValue(showTemporaryProjectsAtom);
  return useMemo(() => discoverableProjects(projects, showTemporary), [projects, showTemporary]);
}

export function useTemporaryProjectsMenuItem() {
  const gt = useGT();
  const projects = useProjects();
  const [showTemporary, setShowTemporary] = useAtom(showTemporaryProjectsAtom);
  if (!projects.some(isTemporaryProject)) return null;
  return {
    id: "toggle-temporary-projects",
    title: showTemporary ? gt("Hide temporary projects") : gt("Show temporary projects"),
    onPress: () => setShowTemporary(!showTemporary),
  };
}
