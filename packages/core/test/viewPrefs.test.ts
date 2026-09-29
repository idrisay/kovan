import { describe, expect, it } from 'vitest';
import { choiceFrom, facetsFromJson, facetsToJson, withSelected } from '../src';

const keys = ['status', 'issueType', 'priority', 'assignee'] as const;

describe('facets round trip', () => {
  it('stores and restores the selections', () => {
    const filters = {
      status: new Set(['Ready For Implementation', 'In Development', 'Ready for Tech Analysis']),
      issueType: new Set<string>(), priority: new Set(['High']), assignee: new Set<string>()
    };
    const stored = JSON.parse(JSON.stringify(facetsToJson(filters)));
    expect(facetsFromJson(stored, keys)).toEqual(filters);
  });

  it('trusts nothing it reads back', () => {
    const restored = facetsFromJson(
      { status: ['QA', 7, '', null, 'x'.repeat(500)], issueType: 'Bug', unknown: ['y'] },
      keys
    );
    expect(restored).toEqual({ status: new Set(['QA']), issueType: new Set(), priority: new Set(), assignee: new Set() });
    expect(facetsFromJson(undefined, keys).status.size).toBe(0);
    expect(facetsFromJson('garbage', keys).assignee.size).toBe(0);
  });
});

describe('choiceFrom', () => {
  it('keeps an allowed choice, falls back otherwise', () => {
    expect(choiceFrom('priority', ['updated', 'priority', 'key'], 'updated')).toBe('priority');
    expect(choiceFrom('removed-sort', ['updated', 'priority', 'key'], 'updated')).toBe('updated');
    expect(choiceFrom(3, ['updated'], 'updated')).toBe('updated');
  });
});

describe('withSelected', () => {
  it('shows a selection the data no longer has, so it can be unticked', () => {
    expect(withSelected(['Alice', 'Bob'], new Set(['Bob', 'Zed', 'Carol']))).toEqual(['Alice', 'Bob', 'Carol', 'Zed']);
    expect(withSelected(['Alice'], new Set())).toEqual(['Alice']);
  });
});
