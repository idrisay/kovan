/**
 * The filters and sorts that come back when Kovan is reopened (item 93):
 * Pull requests' filter and sort, Tickets' filter and sort. Per window, so
 * localStorage (DESIGN.md: preferences vs settings) — every read and write in
 * try, and the defaults when it isn't there. The text in the Filter box
 * isn't kept: it's a search you're doing now, and coming back to a list
 * narrowed by yesterday's search would look like missing tickets.
 */

import { choiceFrom, facetsFromJson, facetsToJson } from '@kovan/core';

const KEY = 'kovan.view-prefs';

interface Stored {
  pullFilters?: unknown;
  pullSort?: unknown;
  ticketFilters?: unknown;
  ticketSort?: unknown;
}

function read(): Stored {
  try {
    const raw = localStorage.getItem(KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : {};
    return parsed && typeof parsed === 'object' ? (parsed as Stored) : {};
  } catch {
    return {};
  }
}

export function loadViewPrefs<PK extends string, PS extends string, TK extends string, TS extends string>(shape: {
  pullKeys: readonly PK[]; pullSorts: readonly PS[]; pullSortDefault: PS;
  ticketKeys: readonly TK[]; ticketSorts: readonly TS[]; ticketSortDefault: TS;
}) {
  const stored = read();
  return {
    pullFilters: facetsFromJson(stored.pullFilters, shape.pullKeys),
    pullSort: choiceFrom(stored.pullSort, shape.pullSorts, shape.pullSortDefault),
    ticketFilters: facetsFromJson(stored.ticketFilters, shape.ticketKeys),
    ticketSort: choiceFrom(stored.ticketSort, shape.ticketSorts, shape.ticketSortDefault)
  };
}

export function saveViewPrefs(prefs: {
  pullFilters: Record<string, ReadonlySet<string>>;
  pullSort: string;
  ticketFilters: Record<string, ReadonlySet<string>>;
  ticketSort: string;
}): void {
  try {
    localStorage.setItem(KEY, JSON.stringify({
      pullFilters: facetsToJson(prefs.pullFilters),
      pullSort: prefs.pullSort,
      ticketFilters: facetsToJson(prefs.ticketFilters),
      ticketSort: prefs.ticketSort
    }));
  } catch {
    // Private mode or a full store: they just won't come back next time.
  }
}
