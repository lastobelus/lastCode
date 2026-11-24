import type { ComponentProps } from "react";
import { ThreadHoverCardPopup } from "./ThreadHoverCard";
import "./lastcode-thread-hover-card.css";

export function LastCodeThreadHoverCardPopup(props: ComponentProps<typeof ThreadHoverCardPopup>) {
  return <ThreadHoverCardPopup {...props} data-lastcode-thread-hover-card />;
}
