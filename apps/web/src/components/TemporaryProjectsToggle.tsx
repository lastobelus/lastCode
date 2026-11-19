import { useAtom } from "@effect/atom-react";
import {
  isTemporaryProject,
  showTemporaryProjectsAtom,
} from "@t3tools/client-runtime/state/temporary-projects";
import { useGT } from "gt-react";
import { useProjects } from "../state/entities";
import { Button } from "./ui/button";
import { MenuCheckboxItem } from "./ui/menu";

export function TemporaryProjectsToggle({ menu = false }: { readonly menu?: boolean }) {
  const gt = useGT();
  const projects = useProjects();
  const [showTemporary, setShowTemporary] = useAtom(showTemporaryProjectsAtom);
  if (!projects.some(isTemporaryProject)) return null;
  const label = gt("Show temporary projects");
  if (menu) {
    return (
      <MenuCheckboxItem checked={showTemporary} onCheckedChange={setShowTemporary}>
        {label}
      </MenuCheckboxItem>
    );
  }
  return (
    <Button variant="ghost" size="xs" onClick={() => setShowTemporary(!showTemporary)}>
      {showTemporary ? gt("Hide temporary projects") : label}
    </Button>
  );
}
