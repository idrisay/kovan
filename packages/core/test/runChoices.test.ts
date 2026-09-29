import { describe, expect, it } from 'vitest';
import { FOLDER_MEMORY_LIMIT, folderMemoryFrom, recallFolders, rememberFolders, type FolderMemory } from '../src';

const BE = '/code/acme-backend';
const FE = '/code/acme-frontend';
const INFRA = '/code/acme-infra';
const offered = [BE, FE, INFRA];

describe('run sheet folder memory', () => {
  it("brings back a ticket's own folders, and where it started", () => {
    const m = rememberFolders({ bySubject: {} }, 'ACME-2393', true, { cwd: FE, extras: [BE] }, 1);
    expect(recallFolders(m, 'ACME-2393', true, offered)).toEqual({ cwd: FE, extras: [BE] });
  });

  it("starts a new ticket from the last ticket's folders, not a pull request's", () => {
    let m = rememberFolders({ bySubject: {} }, 'ACME-2393', true, { cwd: FE, extras: [BE] }, 1);
    m = rememberFolders(m, 'acme/acme-infra#40', false, { cwd: INFRA, extras: [] }, 2);
    expect(recallFolders(m, 'ACME-9999', true, offered)).toEqual({ cwd: FE, extras: [BE] });
    // A pull request never borrows another's: its own repository is the default.
    expect(recallFolders(m, 'acme/acme#1', false, offered)).toBeUndefined();
  });

  it('only brings back folders still offered', () => {
    const m = rememberFolders({ bySubject: {} }, 'T-1', true, { cwd: FE, extras: [BE, '/gone'] }, 1);
    expect(recallFolders(m, 'T-1', true, offered)).toEqual({ cwd: FE, extras: [BE] });
    expect(recallFolders(m, 'T-1', true, [BE])).toBeUndefined();
  });

  it('keeps the most recent subjects only', () => {
    let m: FolderMemory = { bySubject: {} };
    for (let i = 0; i < FOLDER_MEMORY_LIMIT + 5; i++) m = rememberFolders(m, `T-${i}`, true, { cwd: FE, extras: [] }, i);
    expect(Object.keys(m.bySubject)).toHaveLength(FOLDER_MEMORY_LIMIT);
    expect(m.bySubject['T-0']).toBeUndefined();
  });

  it('trusts nothing it reads back', () => {
    const m = folderMemoryFrom({ bySubject: { a: { cwd: FE, extras: [BE], at: 1 }, b: { cwd: 3 }, c: 'x' }, lastTicket: { cwd: '' } });
    expect(Object.keys(m.bySubject)).toEqual(['a']);
    expect(m.lastTicket).toBeUndefined();
    expect(folderMemoryFrom(null)).toEqual({ bySubject: {} });
  });
});
