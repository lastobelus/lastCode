import { useAtom } from "@effect/atom-react";
import {
  isTemporaryProject,
  showTemporaryProjectsAtom,
} from "@t3tools/client-runtime/state/temporary-projects";
import { useGT } from "gt-react";
import type { ReactNode } from "react";
import { useProjects } from "../state/entities";
import { Button } from "./ui/button";
import { MenuCheckboxItem } from "./ui/menu";

export function TemporaryProjectsToggle({
  menu = false,
  children,
}: {
  readonly menu?: boolean;
  readonly children?: ReactNode;
}) {
  const gt = useGT();
  const projects = useProjects();
  const [showTemporary, setShowTemporary] = useAtom(showTemporaryProjectsAtom);
  if (!projects.some(isTemporaryProject)) return children ?? null;
  const label = gt("Show temporary projects");
  if (menu) {
    return (
      <MenuCheckboxItem checked={showTemporary} onCheckedChange={setShowTemporary}>
        {label}
      </MenuCheckboxItem>
    );
  }
  return (
    <div className="flex items-center gap-2">
      <Button
        variant={showTemporary ? "secondary" : "ghost"}
        size="xs"
        aria-pressed={showTemporary}
        onClick={() => setShowTemporary(!showTemporary)}
      >
        {label}
      </Button>
      {children}
    </div>
  );
}
