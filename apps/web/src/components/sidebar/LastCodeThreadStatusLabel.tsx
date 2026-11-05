import type { ComponentProps } from "react";
import { useClientSetting } from "../../hooks/useSettings";
import { lastCodeStatusIcon } from "../../lastcodeStatusIcons";
import { ThreadStatusLabel } from "../ThreadStatusIndicators";

export function LastCodeThreadStatusLabel(props: ComponentProps<typeof ThreadStatusLabel>) {
  const overrides = useClientSetting("lastcodeStatusIcons");
  return <ThreadStatusLabel {...props} icon={lastCodeStatusIcon(props.status.label, overrides)} />;
}
