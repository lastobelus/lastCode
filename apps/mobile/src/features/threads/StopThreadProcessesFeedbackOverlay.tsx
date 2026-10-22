import { useAtomValue } from "@effect/atom-react";

import { stopThreadProcessesFeedbackAtom } from "../../state/stop-thread-processes-feedback";
import { GitActionProgressOverlay } from "./GitActionProgressOverlay";

const keepFeedbackVisible = () => {};

export function StopThreadProcessesFeedbackOverlay() {
  const progress = useAtomValue(stopThreadProcessesFeedbackAtom);
  return <GitActionProgressOverlay progress={progress} onDismiss={keepFeedbackVisible} />;
}
