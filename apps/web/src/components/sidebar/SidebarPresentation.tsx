import { Activity, useState, type ReactNode } from "react";

/** Mount only after first use; hidden views keep drafts but release their effects. */
export function SidebarPresentation({
  visible,
  retain = true,
  children,
}: {
  visible: boolean;
  retain?: boolean;
  children: ReactNode;
}) {
  const [visited, setVisited] = useState(visible && retain);
  if (visible && retain && !visited) setVisited(true);
  if (!visible && !visited) return null;
  return <Activity mode={visible ? "visible" : "hidden"}>{children}</Activity>;
}
