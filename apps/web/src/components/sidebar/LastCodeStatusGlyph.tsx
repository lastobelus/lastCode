import { useClientSetting } from "../../hooks/useSettings";
import { lastCodeStatusIcon } from "../../lastcodeStatusIcons";
import { ThreadStatusGlyph } from "../ThreadStatusGlyph";

export function LastCodeStatusGlyph({
  status,
  size,
}: {
  status: { label: string; dotClass: string; pulse?: boolean | undefined };
  size?: number;
}) {
  const overrides = useClientSetting("lastcodeStatusIcons");
  return (
    <ThreadStatusGlyph
      icon={lastCodeStatusIcon(status.label, overrides)}
      dotClass={status.dotClass}
      pulse={status.pulse}
      size={size}
    />
  );
}
