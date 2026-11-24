/**
 * Pinned pull requests, tickets and sessions (item 145).
 *
 * A pin marks a row and keeps it: a pinned row stays where its list puts it
 * (nothing moves), but it no longer drops out of the list when it ages out of
 * the merged window, gets reassigned or moves to Done. The app fetches what
 * the lists no longer carry; this file only decides what is pinned and what
 * is missing.
 *
 * Pins are keyed by what the user recognises and what survives a restart:
 * `owner/name#number`, the Jira key, the session id. The title is remembered
 * at pin time so a pin that can't be loaded any more still says what it was.
 */

export type PinKind = 'pull' | 'ticket' | 'session';

export interface Pin {
  key: string;
  /** What the row said when it was pinned. */
  title?: string;
  /** ISO time it was pinned. */
  at: string;
}

export type PinTarget =
  | { kind: 'pull'; repo: string; number: number }
  | { kind: 'ticket'; key: string }
  | { kind: 'session'; id: string };

export function pullPinKey(repo: string, number: number): string {
  return `pull:${repo}#${number}`;
}

export function ticketPinKey(key: string): string {
  return `ticket:${key}`;
}

export function sessionPinKey(id: string): string {
  return `session:${id}`;
}

/** What a key points at, or undefined for one this version can't read. */
export function parsePinKey(key: string): PinTarget | undefined {
  const colon = key.indexOf(':');
  if (colon < 0) return undefined;
  const kind = key.slice(0, colon);
  const rest = key.slice(colon + 1);
  if (!rest) return undefined;
  if (kind === 'pull') {
    const match = /^([^/#\s]+\/[^/#\s]+)#(\d+)$/.exec(rest);
    return match ? { kind: 'pull', repo: match[1]!, number: Number(match[2]) } : undefined;
  }
  if (kind === 'ticket') {
    return /^[A-Z][A-Z0-9_]*-\d+$/.test(rest) ? { kind: 'ticket', key: rest } : undefined;
  }
  if (kind === 'session') return { kind: 'session', id: rest };
  return undefined;
}

export function pinKind(key: string): PinKind | undefined {
  return parsePinKey(key)?.kind;
}

/**
 * The stored setting, as pins. Anything malformed is dropped rather than
 * thrown on: a bad entry must not cost the user every other pin.
 */
export function readPins(raw: unknown): Pin[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const pins: Pin[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue;
    const { key, title, at } = entry as Record<string, unknown>;
    if (typeof key !== 'string' || !parsePinKey(key) || seen.has(key)) continue;
    seen.add(key);
    pins.push({
      key,
      ...(typeof title === 'string' && title ? { title } : {}),
      at: typeof at === 'string' ? at : new Date(0).toISOString()
    });
  }
  return pins;
}

/** Pins it when it isn't, unpins it when it is. */
export function togglePin(pins: readonly Pin[], key: string, title: string | undefined, now: Date): Pin[] {
  if (pins.some((pin) => pin.key === key)) return pins.filter((pin) => pin.key !== key);
  return [...pins, { key, ...(title ? { title } : {}), at: now.toISOString() }];
}

/** The pins of one kind that none of the loaded lists carry. */
export function missingPins(pins: readonly Pin[], kind: PinKind, loaded: ReadonlySet<string>): Pin[] {
  return pins.filter((pin) => pinKind(pin.key) === kind && !loaded.has(pin.key));
}

/**
 * Pins without the sessions that have closed. A session id never comes back,
 * so a pin on a closed session would only ever be a dead row.
 */
export function withoutClosedSessions(pins: readonly Pin[], liveIds: ReadonlySet<string>): Pin[] {
  const next = pins.filter((pin) => {
    const target = parsePinKey(pin.key);
    return target?.kind !== 'session' || liveIds.has(target.id);
  });
  return next.length === pins.length ? (pins as Pin[]) : next;
}
