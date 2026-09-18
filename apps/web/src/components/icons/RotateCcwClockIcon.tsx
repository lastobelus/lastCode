import { forwardRef, type SVGProps } from "react";

import { cn } from "~/lib/utils";

/** Lucide-compatible RotateCcwClock glyph for the icon version bundled by LastCode. */
export const RotateCcwClockIcon = forwardRef<SVGSVGElement, SVGProps<SVGSVGElement>>(
  function RotateCcwClockIcon({ className, ...props }, ref) {
    return (
      <svg
        ref={ref}
        aria-hidden="true"
        className={cn("lucide lucide-rotate-ccw-clock", className)}
        fill="none"
        height="24"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="2"
        viewBox="0 0 24 24"
        width="24"
        xmlns="http://www.w3.org/2000/svg"
        {...props}
      >
        <path d="M3 12a9 9 0 1 0 3-6.7L3 8" />
        <path d="M3 3v5h5" />
        <path d="M12 7v5l3 2" />
      </svg>
    );
  },
);
