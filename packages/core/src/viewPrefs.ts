/**
 * Filters and sorts that survive closing Kovan (improvements item 93): the
 * pull requests' and tickets' filter selections and sort order. Stored per
 * window in localStorage; these turn them into JSON and back, trusting
 * nothing that comes back.
 */

/** A facet filter as JSON: each facet's selected values, sorted so the stored form is stable. */
export function facetsToJson<K extends string>(facets: Record<K, ReadonlySet<string>>): Record<K, string[]> {
  const out = {} as Record<K, string[]>;
  for (const key of Object.keys(facets) as K[]) out[key] = [...facets[key]].sort();
  return out;
}

/** Most values a facet keeps, and the longest a value may be — a guard against a mangled store. */
const MAX_VALUES = 100;
const MAX_LENGTH = 200;

/**
 * A stored facet filter back as sets, for exactly `keys`: unknown facets are
 * dropped, missing ones are empty, and only short strings are kept.
 */
export function facetsFromJson<K extends string>(stored: unknown, keys: readonly K[]): Record<K, Set<string>> {
  const source = stored && typeof stored === 'object' ? (stored as Record<string, unknown>) : {};
  const out = {} as Record<K, Set<string>>;
  for (const key of keys) {
    const values = Array.isArray(source[key]) ? (source[key] as unknown[]) : [];
    out[key] = new Set(
      values.filter((v): v is string => typeof v === 'string' && v.length > 0 && v.length <= MAX_LENGTH).slice(0, MAX_VALUES)
    );
  }
  return out;
}

/** A stored choice (a sort), when it's still one of the allowed ones. */
export function choiceFrom<T extends string>(stored: unknown, allowed: readonly T[], fallback: T): T {
  return typeof stored === 'string' && (allowed as readonly string[]).includes(stored) ? (stored as T) : fallback;
}

/**
 * A menu's options plus whatever is selected but no longer among them — an
 * assignee with no tickets left, a repository you've stopped watching. A
 * remembered selection that the menu didn't show would filter the list
 * invisibly, with no box to untick.
 */
export function withSelected(options: readonly string[], selected: ReadonlySet<string>): string[] {
  return [...options, ...[...selected].filter((v) => !options.includes(v)).sort()];
}
