/**
 * The queue row, and how a pull request's state becomes words.
 *
 * The design canvas is explicit about this one: "Number, title, then the state
 * in words on a second line — never a row you have to decode." Icons and
 * coloured bars alone were the thing it replaced.
 *
 * Only "blocked on you" is tinted. Everything else states itself in grey,
 * because red is reserved for something having actually failed.
 */

import { formatAge, isBlocked, pullFlags, type PullFlagId, type PullSummary } from '@baton/core';

/** Which status colour a flag gets. The four are fixed by the design. */
const TONE: Record<PullFlagId, 'pass' | 'running' | 'fail' | 'waiting' | ''> = {
  conflict: 'fail',
  'changes-requested': 'fail',
  'checks-failing': 'fail',
  unresolved: 'running',
  approved: 'pass',
  'checks-pending': 'running',
  'awaiting-review': 'waiting',
  draft: ''
};

export function States({ pull, max = 2 }: { pull: PullSummary; max?: number }) {
  const flags = pullFlags(pull).slice(0, max);
  return (
    <>
      {flags.map((flag) => (
        <span key={flag.id} className="state">
          <span className={`dot ${TONE[flag.id]}`} />
          {flag.label}
        </span>
      ))}
    </>
  );
}

export function PullRow({
  pull,
  selected,
  onSelect,
  tint = true
}: {
  pull: PullSummary;
  selected: boolean;
  onSelect: () => void;
  /** Whether this row's group is the tinted one. */
  tint?: boolean;
}) {
  // Tinting is a property of the *group*, not the row: a pull request that is
  // blocked still appears in "awaiting your review" as somebody else's
  // problem, and colouring it there would say the wrong thing.
  const blocked = tint && isBlocked(pull);
  return (
    <li>
      <button
        className={`row${blocked ? ' blocked' : ''}${selected ? ' selected' : ''}`}
        onClick={onSelect}
      >
        <span className="row-top">
          <span className="row-num">{pull.number}</span>
          <span className="row-title">{pull.title}</span>
        </span>
        <span className="row-state">
          <States pull={pull} />
          <span className="spacer" />
          <span className="row-age">{formatAge(pull.updatedAt)}</span>
        </span>
      </button>
    </li>
  );
}

export function GroupHead({ label, count }: { label: string; count: number }) {
  return (
    <div className="group-head">
      <span>{label}</span>
      <span className="spacer" />
      <span className="count">{count}</span>
    </div>
  );
}
