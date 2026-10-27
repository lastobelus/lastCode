import type { LastCodeStatusIcon } from "@t3tools/contracts/settings";

export const DEFAULT_STATUS_ICON: LastCodeStatusIcon = { shape: "circle", style: "solid" };

const TRIANGLE = {
  solid: '<path d="M3 -1.5 7.098076 6H-1.098076Z"/>',
  open: '<path d="M3 -0.457243 6.255098 5.5H-0.255098Z"/>',
};

const GEOMETRY = {
  triangle: TRIANGLE,
  "triangle-right": {
    solid: `<g transform="rotate(90 3 3)">${TRIANGLE.solid}</g>`,
    open: `<g transform="rotate(90 3 3)">${TRIANGLE.open}</g>`,
  },
  square: {
    solid: '<rect width="6" height="6"/>',
    open: '<rect x=".5" y=".5" width="5" height="5"/>',
  },
  diamond: {
    solid: '<path d="M3 -1.242641 7.242641 3 3 7.242641 -1.242641 3Z"/>',
    open: '<path d="M3 -.535534 6.535534 3 3 6.535534 -.535534 3Z"/>',
  },
  circle: {
    solid: '<circle cx="3" cy="3" r="3"/>',
    open: '<circle cx="3" cy="3" r="2.5"/>',
  },
};

function maskImage(icon: LastCodeStatusIcon) {
  const paint =
    icon.style === "solid"
      ? 'fill="black"'
      : `fill="${icon.style === "open" ? "none" : "black"}" fill-opacity="0.5" stroke="black" stroke-width="1"`;
  // The padded SVG viewport preserves the approved corners beyond the 6px box.
  // Masking the existing background classes keeps dot and label colors distinct.
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="-1.5 -1.5 9 9" ${paint} stroke-linejoin="miter">${GEOMETRY[icon.shape][icon.style === "solid" ? "solid" : "open"]}</svg>`;
  return `url("data:image/svg+xml,${encodeURIComponent(svg)}")`;
}

function masksFor(shape: LastCodeStatusIcon["shape"]) {
  return {
    open: maskImage({ shape, style: "open" }),
    solid: maskImage({ shape, style: "solid" }),
    "outline-fill": maskImage({ shape, style: "outline-fill" }),
  };
}

const MASKS = {
  triangle: masksFor("triangle"),
  "triangle-right": masksFor("triangle-right"),
  square: masksFor("square"),
  diamond: masksFor("diamond"),
  circle: masksFor("circle"),
};

export function ThreadStatusGlyph({
  icon = DEFAULT_STATUS_ICON,
  dotClass,
  pulse = false,
  size = 6,
}: {
  icon?: LastCodeStatusIcon | undefined;
  dotClass: string;
  pulse?: boolean | undefined;
  size?: number | undefined;
}) {
  return (
    <span
      aria-hidden="true"
      data-lastcode-sidebar-unscaled-content
      data-status-shape={icon.shape}
      data-status-style={icon.style}
      className="relative inline-flex shrink-0"
      style={{ width: size, height: size }}
    >
      <span
        className={`${dotClass} ${pulse ? "motion-safe:animate-status-pulse" : ""}`}
        style={
          icon.shape === "circle" && icon.style === "solid"
            ? { width: "100%", height: "100%", borderRadius: "50%" }
            : {
                position: "absolute",
                width: "150%",
                height: "150%",
                left: "-25%",
                top: "-25%",
                maskImage: MASKS[icon.shape][icon.style],
                maskSize: "100% 100%",
                maskRepeat: "no-repeat",
              }
        }
      />
    </span>
  );
}
