/**
 * Rail and control icons.
 *
 * Inline stroke SVG at 1.6, matching the design canvas. Not an icon font and
 * not emoji: these have to take `currentColor` so the rail's selected state
 * tints them, and they have to stay crisp at 19px.
 */

const stroke = {
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.6,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const
};

type Props = { size?: number };

export function PullRequestIcon({ size = 19 }: Props) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" {...stroke} aria-hidden="true">
      <circle cx="6.5" cy="6" r="2.6" />
      <circle cx="6.5" cy="18.5" r="2.6" />
      <path d="M6.5 8.6v7.3" />
      <circle cx="17.5" cy="18.5" r="2.6" />
      <path d="M17.5 15.9V9.4a3 3 0 0 0-3-3h-3.6" />
      <path d="M13.4 4.1 10.9 6.4l2.5 2.3" />
    </svg>
  );
}

export function ReviewIcon({ size = 19 }: Props) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" {...stroke} aria-hidden="true">
      <path d="M2.6 12S6 5.8 12 5.8 21.4 12 21.4 12 18 18.2 12 18.2 2.6 12 2.6 12Z" />
      <circle cx="12" cy="12" r="2.6" />
    </svg>
  );
}

export function BranchIcon({ size = 19 }: Props) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" {...stroke} aria-hidden="true">
      <circle cx="7" cy="5.5" r="2.5" />
      <circle cx="7" cy="18.5" r="2.5" />
      <circle cx="17" cy="8.5" r="2.5" />
      <path d="M7 8v8" />
      <path d="M17 11v1.5a3.5 3.5 0 0 1-3.5 3.5H10" />
    </svg>
  );
}

export function TicketIcon({ size = 19 }: Props) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" {...stroke} aria-hidden="true">
      <path d="M4 7.5 5.8 9.3 9 6" />
      <path d="M12 7.6h8" />
      <path d="M4 16.5 5.8 18.3 9 15" />
      <path d="M12 16.6h8" />
    </svg>
  );
}

export function TerminalIcon({ size = 19 }: Props) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" {...stroke} aria-hidden="true">
      <path d="M5 16.5 9.6 12 5 7.5" />
      <path d="M12 17h7" />
    </svg>
  );
}

export function RefreshIcon({ size = 18 }: Props) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" {...stroke} aria-hidden="true">
      <path d="M20 12a8 8 0 1 1-2.5-5.8" />
      <path d="M20 4.5V9h-4.5" />
    </svg>
  );
}

export function SettingsIcon({ size = 18 }: Props) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" {...stroke} aria-hidden="true">
      <circle cx="12" cy="12" r="3" />
      <path d="M12 4v2.4" /><path d="M12 17.6V20" />
      <path d="M4 12h2.4" /><path d="M17.6 12H20" />
      <path d="m6.4 6.4 1.7 1.7" /><path d="m15.9 15.9 1.7 1.7" />
      <path d="m17.6 6.4-1.7 1.7" /><path d="m8.1 15.9-1.7 1.7" />
    </svg>
  );
}

export function SearchIcon({ size = 13 }: Props) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" {...stroke} strokeWidth={1.8} aria-hidden="true">
      <circle cx="11" cy="11" r="6" />
      <path d="m16 16 4 4" />
    </svg>
  );
}

export function SortIcon({ size = 14 }: Props) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" {...stroke} strokeWidth={1.8} aria-hidden="true">
      <path d="M7 4v16" /><path d="m4 17 3 3 3-3" />
      <path d="M17 20V4" /><path d="m14 7 3-3 3 3" />
    </svg>
  );
}

export function WorkspaceIcon({ size = 19 }: Props) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" {...stroke} aria-hidden="true">
      <path d="M3 7.2a1.7 1.7 0 0 1 1.7-1.7h3.4l1.8 2.2h8.4A1.7 1.7 0 0 1 20 9.4v8.1a1.7 1.7 0 0 1-1.7 1.7H4.7A1.7 1.7 0 0 1 3 17.5Z" />
    </svg>
  );
}

export function ChevronIcon({ size = 12, open = false }: Props & { open?: boolean }) {
  return (
    <svg
      width={size} height={size} viewBox="0 0 24 24" {...stroke} strokeWidth={2.2}
      aria-hidden="true"
      style={{ transform: open ? 'rotate(90deg)' : 'none', transition: 'transform 120ms ease' }}
    >
      <path d="m9 5 7 7-7 7" />
    </svg>
  );
}

export function FolderIcon({ size = 14 }: Props) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" {...stroke} aria-hidden="true">
      <path d="M3 7.2a1.7 1.7 0 0 1 1.7-1.7h3.4l1.8 2.2h8.4A1.7 1.7 0 0 1 20 9.4v8.1a1.7 1.7 0 0 1-1.7 1.7H4.7A1.7 1.7 0 0 1 3 17.5Z" />
    </svg>
  );
}

export function FileIcon({ size = 14 }: Props) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" {...stroke} aria-hidden="true">
      <path d="M13.5 3.5H7a1.8 1.8 0 0 0-1.8 1.8v13.4A1.8 1.8 0 0 0 7 20.5h10a1.8 1.8 0 0 0 1.8-1.8V8.8Z" />
      <path d="M13.5 3.5v4.4a1 1 0 0 0 1 1h4.3" />
    </svg>
  );
}

export function CloseIcon({ size = 12 }: Props) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" {...stroke} strokeWidth={2.2} aria-hidden="true">
      <path d="M6 6 18 18" /><path d="M18 6 6 18" />
    </svg>
  );
}

export function PlusIcon({ size = 14 }: Props) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" {...stroke} strokeWidth={2} aria-hidden="true">
      <path d="M12 5v14" /><path d="M5 12h14" />
    </svg>
  );
}

/** Source control: the two-sided compare, not a branch. */
export function ChangesIcon({ size = 14 }: Props) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" {...stroke} aria-hidden="true">
      <circle cx="6" cy="6" r="2.4" />
      <circle cx="18" cy="18" r="2.4" />
      <path d="M6 8.4v5.3a2.3 2.3 0 0 0 2.3 2.3H15" />
      <path d="m12.6 13.4 2.6 2.6-2.6 2.6" />
    </svg>
  );
}
