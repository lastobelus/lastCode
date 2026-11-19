import { useAtomValue } from "@effect/atom-react";
import {
  discoverableProjects,
  showTemporaryProjectsAtom,
} from "@t3tools/client-runtime/state/temporary-projects";
import { useProjects } from "../state/entities";

export function useDiscoverableProjects({ showAll = false } = {}) {
  const projects = useProjects();
  const showTemporary = useAtomValue(showTemporaryProjectsAtom);
  return discoverableProjects(projects, showAll || showTemporary);
}
