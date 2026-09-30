import { describe, expect, it } from 'vitest';
import { withPlugin } from '../src/main/agentStatus';
import { createLeaf, moveSession, shownSessions } from '../src/renderer/paneTree';

describe('withPlugin', () => {
  it('starts an inline OpenCode config when there is none', () => {
    expect(JSON.parse(withPlugin(undefined, 'file:///p.js'))).toEqual({ plugin: ['file:///p.js'] });
  });

  it('keeps what was already set, and the plugins already there', () => {
    const existing = JSON.stringify({ model: 'x/y', plugin: ['a'] });
    expect(JSON.parse(withPlugin(existing, 'file:///p.js'))).toEqual({ model: 'x/y', plugin: ['a', 'file:///p.js'] });
  });

  it('replaces an inline config it cannot read', () => {
    expect(JSON.parse(withPlugin('{not json', 'file:///p.js'))).toEqual({ plugin: ['file:///p.js'] });
  });
});

describe('shownSessions', () => {
  it('is nothing without panes', () => {
    expect(shownSessions(undefined)).toEqual([]);
  });

  it('is the showing tab of every pane, not the hidden tabs', () => {
    const one = { ...createLeaf('a'), sessions: ['a', 'b', 'c'], active: 'a' };
    expect(shownSessions(one)).toEqual(['a']);
    // Drag c out to the right: two panes, each showing one tab; b stays hidden.
    const two = moveSession(one, 'c', one.id, 'right');
    expect(shownSessions(two).sort()).toEqual(['a', 'c']);
  });
});
