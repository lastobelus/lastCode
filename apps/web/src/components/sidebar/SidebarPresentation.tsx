import { Activity, useEffect, useState, type ReactNode } from "react";

/** Mount only after first use; hidden views keep drafts but release their effects. */
export function SidebarPresentation({
  visible,
  children,
}: {
  visible: boolean;
  children: ReactNode;
}) {
  const [visited, setVisited] = useState(visible);
  useEffect(() => {
    if (visible) setVisited(true);
  }, [visible]);
  if (!visible && !visited) return null;
  return <Activity mode={visible ? "visible" : "hidden"}>{children}</Activity>;
}
