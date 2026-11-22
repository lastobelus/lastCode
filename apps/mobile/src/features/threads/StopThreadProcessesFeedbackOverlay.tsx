import { useStopThreadProcessesFeedback } from "../../state/stop-thread-processes-feedback";
import { GitActionProgressOverlay } from "./GitActionProgressOverlay";

const keepFeedbackVisible = () => {};

export function StopThreadProcessesFeedbackOverlay() {
  const progress = useStopThreadProcessesFeedback();
  return <GitActionProgressOverlay progress={progress} onDismiss={keepFeedbackVisible} />;
}
