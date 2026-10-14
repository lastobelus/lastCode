import { Activity, useEffect, useState, type ReactNode } from "react";

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
  useEffect(() => {
    if (visible && retain) setVisited(true);
  }, [visible, retain]);
  if (!visible && !visited) return null;
  return <Activity mode={visible ? "visible" : "hidden"}>{children}</Activity>;
}
