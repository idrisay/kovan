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

export function SentryIcon({ size = 19 }: Props) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" {...stroke} aria-hidden="true">
      <path d="M12 4 21 19H3Z" />
      <path d="M12 10v4.2" />
      <circle cx="12" cy="17.2" r="0.15" fill="currentColor" />
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

/** A cog. It used to be a circle with eight rays, which read as a sun — the
 *  theme toggle — not as Settings. */
export function SettingsIcon({ size = 18 }: Props) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" {...stroke} aria-hidden="true">
      <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  );
}

/** A pulse line: agents running anywhere on the Mac, and what they cost. */
export function AgentsIcon({ size = 19 }: Props) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" {...stroke} aria-hidden="true">
      <path d="M3 12h3.5l2.5-6.5 5 13 2.5-6.5H21" />
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

export function FilterIcon({ size = 14 }: Props) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" {...stroke} strokeWidth={1.8} aria-hidden="true">
      <path d="M4 5.5h16" /><path d="M7.5 12h9" /><path d="M10.5 18.5h3" />
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

/** Collapse all: two arrows folding toward a centre line. */
export function CollapseIcon({ size = 14 }: Props) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" {...stroke} strokeWidth={1.8} aria-hidden="true">
      <path d="M9 4 5 8h8Z" />
      <path d="M15 20l4-4h-8Z" />
      <path d="M4 12h16" />
    </svg>
  );
}

/** Add a folder to the workspace. */
export function AddFolderIcon({ size = 14 }: Props) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" {...stroke} aria-hidden="true">
      <path d="M20 13.2V9.4a1.7 1.7 0 0 0-1.7-1.7H9.9L8.1 5.5H4.7A1.7 1.7 0 0 0 3 7.2v10.3a1.7 1.7 0 0 0 1.7 1.7h8.4" />
      <path d="M18 15.2v5.2" /><path d="M15.4 17.8h5.2" />
    </svg>
  );
}

/** The overflow menu: three dots, as every editor draws it. */
export function MoreIcon({ size = 14 }: Props) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true"
      fill="currentColor" stroke="none">
      <circle cx="5" cy="12" r="1.6" /><circle cx="12" cy="12" r="1.6" />
      <circle cx="19" cy="12" r="1.6" />
    </svg>
  );
}

/**
 * Dock position icons: a window frame with one edge filled in, so which side
 * a panel is about to move to reads at a glance rather than from a tooltip.
 */
export function DockBottomIcon({ size = 14 }: Props) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
      <rect x="3.5" y="3.5" width="17" height="17" rx="1.6" {...stroke} strokeWidth={1.5} />
      <rect x="4.3" y="14.8" width="15.4" height="5" rx="0.8" fill="currentColor" opacity="0.55" />
    </svg>
  );
}

export function DockTopIcon({ size = 14 }: Props) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
      <rect x="3.5" y="3.5" width="17" height="17" rx="1.6" {...stroke} strokeWidth={1.5} />
      <rect x="4.3" y="4.2" width="15.4" height="5" rx="0.8" fill="currentColor" opacity="0.55" />
    </svg>
  );
}

export function DockLeftIcon({ size = 14 }: Props) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
      <rect x="3.5" y="3.5" width="17" height="17" rx="1.6" {...stroke} strokeWidth={1.5} />
      <rect x="4.2" y="4.3" width="6.2" height="15.4" rx="0.8" fill="currentColor" opacity="0.55" />
    </svg>
  );
}

export function DockRightIcon({ size = 14 }: Props) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
      <rect x="3.5" y="3.5" width="17" height="17" rx="1.6" {...stroke} strokeWidth={1.5} />
      <rect x="13.6" y="4.3" width="6.2" height="15.4" rx="0.8" fill="currentColor" opacity="0.55" />
    </svg>
  );
}

export function RevertIcon({ size = 13 }: Props) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" {...stroke} aria-hidden="true">
      <path d="M4 9h9.5a5.5 5.5 0 0 1 0 11H8" />
      <path d="M8 4.2 4 9l4 4.8" />
    </svg>
  );
}

export function MinusIcon({ size = 14 }: Props) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" {...stroke} strokeWidth={2} aria-hidden="true">
      <path d="M5 12h14" />
    </svg>
  );
}

/** A pencil, for "rename" — the one place in the app that lets you type over
 *  a name the app generated instead of one you chose. */
export function EditIcon({ size = 13 }: Props) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" {...stroke} aria-hidden="true">
      <path d="M15.2 4.8 19.2 8.8 8 20H4v-4Z" />
      <path d="M13.4 6.6 17.4 10.6" />
    </svg>
  );
}

/** An arrow breaking out of a box — "open the thing this refers to",
 *  standing in for a session's identifier once that stopped being a link
 *  drawn straight into the row's own text. */
export function OpenLinkIcon({ size = 13 }: Props) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" {...stroke} aria-hidden="true">
      <path d="M10 6H5.8A1.8 1.8 0 0 0 4 7.8v10.4A1.8 1.8 0 0 0 5.8 20h10.4A1.8 1.8 0 0 0 18 18.2V14" />
      <path d="M14 4h6v6" />
      <path d="M20 4 11 13" />
    </svg>
  );
}

/** A chevron folding down — "collapse this back", the docked terminal's own
 *  un-kill way of getting it out of the way. */
export function HideIcon({ size = 13 }: Props) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" {...stroke} strokeWidth={2} aria-hidden="true">
      <path d="M6 9.5 12 15l6-5.5" />
    </svg>
  );
}
