import { describe, expect, it } from 'vitest';
import { windowTitle, windowsToRestore } from '../src/main/windows';

const all = [{ id: 'acme' }, { id: 'kovan' }, { id: 'notes' }];

describe('windowsToRestore', () => {
  it('reopens the saved workspaces that still exist, once each', () => {
    expect(windowsToRestore(all, ['kovan', 'gone', 'acme', 'kovan'], 'notes')).toEqual(['kovan', 'acme']);
  });

  it('opens one window on the active workspace when nothing usable was saved', () => {
    expect(windowsToRestore(all, [], 'notes')).toEqual(['notes']);
    expect(windowsToRestore(all, 'junk', 'notes')).toEqual(['notes']);
    expect(windowsToRestore(all, ['gone'], undefined)).toEqual([undefined]);
  });
});

describe('windowTitle', () => {
  it('is the workspace name, or Kovan without one', () => {
    expect(windowTitle({ name: 'acme' })).toBe('acme');
    expect(windowTitle(undefined)).toBe('Kovan');
  });
});
