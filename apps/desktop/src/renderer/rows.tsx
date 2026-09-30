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

import {
  formatAge, isBlocked, isMerged, primaryFlag, pullFlags, type PullFlagId, type PullSummary
} from '@kovan/core';
import { ChevronIcon } from './icons';

/** Which status colour a flag gets. The four are fixed by the design. */
export const TONE: Record<PullFlagId, 'pass' | 'running' | 'fail' | 'waiting' | 'merged' | ''> = {
  merged: 'merged',
  conflict: 'fail',
  'changes-requested': 'fail',
  'checks-failing': 'fail',
  unresolved: 'running',
  approved: 'pass',
  'checks-pending': 'running',
  'awaiting-review': 'waiting',
  draft: '',
  open: ''
};

/**
 * The repository, as a row shows it: the name without its owner, which is
 * nearly always the same one. The whole `owner/name` is in the tooltip.
 */
export function repoName(repo: string): string {
  return repo.split('/').pop() || repo;
}

export function RepoLabel({ repo }: { repo: string }) {
  if (!repo) return null;
  return <span className="row-repo" title={repo}>{repoName(repo)}</span>;
}

export function States({ pull, max = 2, skip }: { pull: PullSummary; max?: number; skip?: string }) {
  // A pull request with nothing to report still says "Open" rather than
  // leaving its second line empty.
  const all = pullFlags(pull);
  const flags = (all.length > 0 ? all : [primaryFlag(pull)])
    .filter((flag) => flag.id !== skip)
    .slice(0, max);
  return (
    <>
      {flags.map((flag) => (
        <span key={flag.id} className="state" title={flag.hint}>
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

  // Merged work gets one line, not two.
  //
  // The second line exists to say what state a pull request is in, and every
  // merged row would say the same word under a header that has just said it.
  // Dated by `mergedAt`, because `updatedAt` on something merged in March
  // reads "2d" the moment anybody comments on it — the one fact about a
  // merged pull request you are least likely to want.
  if (isMerged(pull)) {
    return (
      <li>
        <button className={`row shipped${selected ? ' selected' : ''}`} onClick={onSelect}>
          <span className="row-top">
            <span className="row-num">{pull.number}</span>
            <span className="row-title">{pull.title}</span>
            <RepoLabel repo={pull.repo} />
            <span className="row-age">{formatAge(pull.mergedAt!)}</span>
          </span>
        </button>
      </li>
    );
  }

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
          <RepoLabel repo={pull.repo} />
          <span className="row-age">{formatAge(pull.updatedAt)}</span>
        </span>
      </button>
    </li>
  );
}

/**
 * A section header you can fold.
 *
 * The rule between the words and the count fills whatever the label leaves, so
 * every header in the sidebar terminates on the same vertical line however
 * long its title is — which is what makes four of them read as one list rather
 * than four unrelated blocks. Borrowed from devhub-mac, where the same rule
 * does the same job.
 *
 * Only the section that is actually waiting on you is tinted. A sidebar where
 * every header is orange says exactly as much as one where none of them is.
 */
export function GroupHead({
  label, count, total, open, tint = false, note, onToggle
}: {
  label: string;
  count: number;
  /** The full size of a windowed list, when the count is only part of it. */
  total?: number;
  open: boolean;
  tint?: boolean;
  note?: string;
  onToggle: () => void;
}) {
  // "20" over a list of 34 is not a count, it is a wrong one.
  const shown = total !== undefined && total > count ? `${count} of ${total}` : String(count);
  return (
    <button
      type="button"
      className={`group-head${tint ? ' tint' : ''}`}
      aria-expanded={open}
      onClick={onToggle}
    >
      <ChevronIcon size={11} open={open} />
      <span className="group-label">{label}</span>
      {note && <span className="group-note">{note}</span>}
      <span className="group-rule" />
      <span className="count">{shown}</span>
    </button>
  );
}
