import { describe, expect, it } from 'vitest';
import { windowTitle, windowsToRestore, workspaceForNewWindow } from '../src/main/windows';

const all = [{ id: 'acme' }, { id: 'kovan' }, { id: 'notes' }];

describe('workspaceForNewWindow', () => {
  it('opens the first window on the active workspace', () => {
    expect(workspaceForNewWindow(all, [], 'kovan')).toBe('kovan');
    expect(workspaceForNewWindow(all, [], undefined)).toBe('acme');
  });

  it('picks a workspace no window shows yet, in list order', () => {
    expect(workspaceForNewWindow(all, ['acme'], 'acme')).toBe('kovan');
    expect(workspaceForNewWindow(all, ['kovan', 'acme'], 'kovan')).toBe('notes');
  });

  it('falls back to the active one when every workspace has a window', () => {
    expect(workspaceForNewWindow(all, ['acme', 'kovan', 'notes'], 'notes')).toBe('notes');
    expect(workspaceForNewWindow([], [undefined], undefined)).toBeUndefined();
  });
});

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
