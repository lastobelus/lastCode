import type { ComponentProps } from "react";
import { LastCodeCurrentWork, type LastCodeCurrentWorkProps } from "./LastCodeCurrentWork";
import { ThreadNow } from "./ThreadNow";

export function LastCodeThreadNow({
  attention,
  syncPhase,
  goal,
  ...work
}: ComponentProps<typeof ThreadNow> & LastCodeCurrentWorkProps) {
  const stopWork = work.work?.id.startsWith("run-stop:") ? work.work : null;
  return (
    <>
      <ThreadNow attention={attention} work={stopWork} syncPhase={null} goal={null} />
      <LastCodeCurrentWork {...work} work={stopWork === null ? work.work : null} />
      <ThreadNow attention={null} work={null} syncPhase={syncPhase} goal={goal} />
    </>
  );
}
