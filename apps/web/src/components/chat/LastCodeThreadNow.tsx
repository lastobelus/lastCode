import type { ComponentProps } from "react";
import { LastCodeCurrentWork, type LastCodeCurrentWorkProps } from "./LastCodeCurrentWork";
import { ThreadNow } from "./ThreadNow";

export function LastCodeThreadNow({
  attention,
  syncPhase,
  goal,
  ...work
}: ComponentProps<typeof ThreadNow> & LastCodeCurrentWorkProps) {
  return (
    <>
      <ThreadNow attention={attention} work={null} syncPhase={null} goal={null} />
      <LastCodeCurrentWork {...work} />
      <ThreadNow attention={null} work={null} syncPhase={syncPhase} goal={goal} />
    </>
  );
}
