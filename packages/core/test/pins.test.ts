import { describe, expect, it } from 'vitest';
import {
  missingPins, parsePinKey, pullPinKey, readPins, sessionPinKey, ticketPinKey, togglePin, withoutClosedSessions
} from '../src/pins';

const now = new Date('2026-10-07T12:00:00Z');

describe('pin keys', () => {
  it('round-trips each kind', () => {
    expect(parsePinKey(pullPinKey('acme/acme-backend', 861))).toEqual({ kind: 'pull', repo: 'acme/acme-backend', number: 861 });
    expect(parsePinKey(ticketPinKey('ACME-2453'))).toEqual({ kind: 'ticket', key: 'ACME-2453' });
    expect(parsePinKey(sessionPinKey('s-1a2b'))).toEqual({ kind: 'session', id: 's-1a2b' });
  });

  it('rejects what it cannot read', () => {
    expect(parsePinKey('pull:acme-backend#861')).toBeUndefined();
    expect(parsePinKey('pull:a/b#x')).toBeUndefined();
    expect(parsePinKey('ticket:not a key')).toBeUndefined();
    expect(parsePinKey('sentry:123')).toBeUndefined();
    expect(parsePinKey('session:')).toBeUndefined();
    expect(parsePinKey('nonsense')).toBeUndefined();
  });
});

describe('readPins', () => {
  it('keeps good entries and drops malformed and repeated ones', () => {
    const raw = [
      { key: 'ticket:ACME-1', title: 'One', at: '2026-10-01T00:00:00Z' },
      { key: 'ticket:ACME-1', title: 'Again' },
      { key: 'bogus' },
      null,
      'ticket:ACME-2',
      { key: 'session:abc' }
    ];
    expect(readPins(raw)).toEqual([
      { key: 'ticket:ACME-1', title: 'One', at: '2026-10-01T00:00:00Z' },
      { key: 'session:abc', at: new Date(0).toISOString() }
    ]);
  });

  it('reads anything that is not a list as no pins', () => {
    expect(readPins(undefined)).toEqual([]);
    expect(readPins({ key: 'ticket:ACME-1' })).toEqual([]);
  });
});

describe('togglePin', () => {
  it('pins, then unpins', () => {
    const pinned = togglePin([], 'ticket:ACME-1', 'One', now);
    expect(pinned).toEqual([{ key: 'ticket:ACME-1', title: 'One', at: now.toISOString() }]);
    expect(togglePin(pinned, 'ticket:ACME-1', 'One', now)).toEqual([]);
  });
});

describe('missingPins', () => {
  it('lists the pins of one kind the lists do not carry', () => {
    const pins = readPins([
      { key: pullPinKey('a/b', 1) }, { key: pullPinKey('a/b', 2) }, { key: ticketPinKey('X-1') }
    ]);
    const loaded = new Set([pullPinKey('a/b', 1)]);
    expect(missingPins(pins, 'pull', loaded).map((p) => p.key)).toEqual([pullPinKey('a/b', 2)]);
    expect(missingPins(pins, 'ticket', loaded).map((p) => p.key)).toEqual([ticketPinKey('X-1')]);
  });
});

describe('withoutClosedSessions', () => {
  it('drops pins on sessions that are gone and leaves the rest', () => {
    const pins = readPins([{ key: sessionPinKey('live') }, { key: sessionPinKey('gone') }, { key: ticketPinKey('X-1') }]);
    expect(withoutClosedSessions(pins, new Set(['live'])).map((p) => p.key)).toEqual([sessionPinKey('live'), ticketPinKey('X-1')]);
  });

  it('returns the same list when nothing changed', () => {
    const pins = readPins([{ key: sessionPinKey('live') }]);
    expect(withoutClosedSessions(pins, new Set(['live']))).toBe(pins);
  });
});
