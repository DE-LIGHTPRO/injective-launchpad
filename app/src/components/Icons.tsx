/**
 * One icon set: 16px, 1.6 stroke, round caps, currentColor.
 *
 * Unicode glyphs (☆ ★ ← +) render in whatever font the platform falls back to, at a
 * weight and baseline nobody chose, which is one of the quickest tells of an
 * unconsidered interface. These are drawn on one grid so they match each other and the
 * text beside them.
 */
type P = { size?: number; className?: string };

function Svg({ size = 16, className, children }: P & { children: React.ReactNode }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={className}
    >
      {children}
    </svg>
  );
}

export const SearchIcon = (p: P) => (
  <Svg {...p}>
    <circle cx="7" cy="7" r="4.5" />
    <path d="M10.5 10.5 14 14" />
  </Svg>
);
export const PlusIcon = (p: P) => (
  <Svg {...p}>
    <path d="M8 3v10M3 8h10" />
  </Svg>
);
export const ArrowLeftIcon = (p: P) => (
  <Svg {...p}>
    <path d="M13 8H3M7 4 3 8l4 4" />
  </Svg>
);
export const StarIcon = ({ filled, ...p }: P & { filled?: boolean }) => (
  <Svg {...p}>
    <path
      d="M8 1.8l1.9 3.9 4.3.6-3.1 3 .7 4.3L8 11.6l-3.8 2 .7-4.3-3.1-3 4.3-.6z"
      fill={filled ? 'currentColor' : 'none'}
    />
  </Svg>
);
export const LinkIcon = (p: P) => (
  <Svg {...p}>
    <path d="M6.5 9.5l3-3M7 4.5l1.2-1.2a2.5 2.5 0 0 1 3.5 3.5L10.5 8M9 11.5l-1.2 1.2a2.5 2.5 0 0 1-3.5-3.5L5.5 8" />
  </Svg>
);
export const ExternalIcon = (p: P) => (
  <Svg {...p}>
    <path d="M9 3h4v4M13 3 7.5 8.5M12 9.5V13H3V4h3.5" />
  </Svg>
);
export const CheckIcon = (p: P) => (
  <Svg {...p}>
    <path d="M3 8.5 6.5 12 13 4.5" />
  </Svg>
);
/**
 * Disconnect, for the header's wallet cluster where the word does not fit a phone.
 *
 * The bracket and the arrow leaving it, which is the one logout convention a reader
 * does not have to be taught. Drawn on the same 16px grid as the rest so it sits on
 * the baseline of the address beside it.
 */
export const SignOutIcon = (p: P) => (
  <Svg {...p}>
    <path d="M6.5 13.5H3.5A1 1 0 0 1 2.5 12.5v-9a1 1 0 0 1 1-1h3" />
    <path d="M10.5 11l3-3-3-3M13.5 8H6" />
  </Svg>
);
