import { type CSSProperties } from "react";

export function LastCodeSettingsSlider({
  id,
  label,
  min,
  max,
  value,
  onChange,
  unit = "px",
}: {
  id: string;
  label: string;
  min: number;
  max: number;
  value: number;
  onChange: (value: number) => void;
  unit?: "px" | "%";
}) {
  const ratio = (value - min) / (max - min);
  const sliderStyle = {
    "--settings-slider-progress": `${ratio * 100}%`,
    "--settings-slider-fill-offset": `${0.5 - ratio}rem`,
  } as CSSProperties;

  return (
    <div className="flex w-full items-center gap-3 sm:w-64">
      <output
        className="min-w-12 rounded-md bg-muted px-2 py-1 text-center font-mono text-xs font-medium tabular-nums text-foreground"
        htmlFor={id}
      >
        {value}
        {unit}
      </output>
      <input
        aria-label={label}
        className="settings-slider block min-w-0 flex-1"
        id={id}
        max={max}
        min={min}
        onChange={(event) => {
          const nextValue = Number(event.currentTarget.value);
          if (!Number.isInteger(nextValue)) return;
          if (nextValue < min) return;
          if (nextValue > max) return;
          onChange(nextValue);
        }}
        step={1}
        style={sliderStyle}
        type="range"
        value={value}
      />
    </div>
  );
}
