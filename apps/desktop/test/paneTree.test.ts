import { describe, expect, it } from 'vitest';
import {
  createLeaf, detachSession, findLeaf, focusSession, moveSession, pruneTree, resizeSplit,
  type PaneSplit, type PaneTree
} from '../src/renderer/paneTree';

describe('focusSession', () => {
  it('starts a leaf from nothing', () => {
    const { tree, leafId } = focusSession(undefined, 'a', undefined);
    expect(tree).toEqual({ type: 'leaf', id: leafId, sessions: ['a'], active: 'a' });
  });

  it('just focuses a session already placed somewhere, without moving it', () => {
    const aLeaf = { ...createLeaf('a'), sessions: ['a', 'x'], active: 'x' };
    const tree: PaneTree = { type: 'split', id: 's1', orientation: 'row', children: [
      { node: aLeaf, size: 0.5 }, { node: createLeaf('b'), size: 0.5 }
    ] };
    const { tree: refocused, leafId } = focusSession(tree, 'a', undefined);
    expect(leafId).toBe(aLeaf.id);
    const leaf = findLeaf(refocused, 'a')!;
    expect(leaf.id).toBe(aLeaf.id);
    expect(leaf.sessions).toEqual(['a', 'x']);
    expect(leaf.active).toBe('a');
  });

  it('adds a new session as a tab on the preferred leaf, not a split', () => {
    const leaf = createLeaf('a');
    const { tree } = focusSession(leaf, 'b', leaf.id);
    expect(tree).toEqual({ type: 'leaf', id: leaf.id, sessions: ['a', 'b'], active: 'b' });
  });

  it('falls back to the first leaf when the preferred one no longer exists', () => {
    const leaf = createLeaf('a');
    const { tree, leafId } = focusSession(leaf, 'b', 'gone');
    expect(leafId).toBe(leaf.id);
    expect((tree as any).sessions).toEqual(['a', 'b']);
  });
});

describe('moveSession: center drop', () => {
  it('moves a session from one leaf into another as a new tab', () => {
    let tree: PaneTree = { type: 'split', id: 's1', orientation: 'row', children: [
      { node: createLeaf('a'), size: 0.5 }, { node: createLeaf('b'), size: 0.5 }
    ] };
    const bLeafId = ((tree as PaneSplit).children[1]!.node as any).id;
    tree = moveSession(tree, 'a', bLeafId, 'center');
    const aLeaf = findLeaf(tree, 'a')!;
    expect(aLeaf.id).toBe(bLeafId);
    expect(aLeaf.sessions).toEqual(['b', 'a']);
    expect(aLeaf.active).toBe('a');
    // The pane 'a' vacated collapses — a two-way split with one side gone is
    // just the remaining side, not a split with an empty child.
    expect(tree.type).toBe('leaf');
  });

  it('is a no-op dropped on its own tab strip', () => {
    const leaf = createLeaf('a');
    const tree = moveSession(leaf, 'a', leaf.id, 'center');
    expect(tree).toEqual(leaf);
  });
});

describe('moveSession: edge drop', () => {
  it('splits a single leaf into two', () => {
    const leaf = createLeaf('a');
    const tree = moveSession(leaf, 'x', leaf.id, 'right') as PaneSplit;
    expect(tree.type).toBe('split');
    expect(tree.orientation).toBe('row');
    expect(tree.children.map((c) => (c.node as any).sessions)).toEqual([['a'], ['x']]);
    expect(tree.children.map((c) => c.size)).toEqual([0.5, 0.5]);
  });

  it('does nothing when the only tab in a pane is dragged onto its own edge', () => {
    const leaf = createLeaf('a');
    const tree = moveSession(leaf, 'a', leaf.id, 'right');
    expect(tree).toEqual(leaf);
  });

  it('flattens into an existing row instead of nesting one more', () => {
    let tree: PaneTree = { type: 'split', id: 'row1', orientation: 'row', children: [
      { node: createLeaf('a'), size: 0.5 }, { node: createLeaf('b'), size: 0.5 }
    ] };
    const bLeafId = ((tree as PaneSplit).children[1]!.node as any).id;
    tree = moveSession(tree, 'c', bLeafId, 'right') as PaneSplit;
    expect(tree.type).toBe('split');
    expect((tree as PaneSplit).id).toBe('row1');
    expect((tree as PaneSplit).children).toHaveLength(3);
    expect((tree as PaneSplit).children.map((c) => (c.node as any).sessions)).toEqual([['a'], ['b'], ['c']]);
    (tree as PaneSplit).children.forEach((c) => expect(c.size).toBeCloseTo(1 / 3));
  });

  it('nests a column split inside a row when the axis differs', () => {
    let tree: PaneTree = { type: 'split', id: 'row1', orientation: 'row', children: [
      { node: createLeaf('a'), size: 0.5 }, { node: createLeaf('b'), size: 0.5 }
    ] };
    const aLeafId = ((tree as PaneSplit).children[0]!.node as any).id;
    tree = moveSession(tree, 'x', aLeafId, 'bottom') as PaneSplit;
    expect(tree.type).toBe('split');
    expect(tree.orientation).toBe('row');
    expect(tree.children).toHaveLength(2);
    const nested = tree.children[0]!.node as PaneSplit;
    expect(nested.type).toBe('split');
    expect(nested.orientation).toBe('column');
    expect(nested.children.map((c) => (c.node as any).sessions)).toEqual([['a'], ['x']]);
    // The row's own second pane, 'b', is untouched by a split that happened
    // entirely inside its sibling.
    expect((tree.children[1]!.node as any).sessions).toEqual(['b']);
  });
});

describe('pruneTree', () => {
  it('drops a closed session and collapses the leaf it was alone in', () => {
    let tree: PaneTree = { type: 'split', id: 's1', orientation: 'row', children: [
      { node: createLeaf('a'), size: 0.5 }, { node: createLeaf('b'), size: 0.5 }
    ] };
    const pruned = pruneTree(tree, new Set(['b']));
    expect(pruned).toEqual({ type: 'leaf', id: (tree as PaneSplit).children[1]!.node.id, sessions: ['b'], active: 'b' });
  });

  it('re-normalises sizes after dropping a whole branch, keeping the rest proportional', () => {
    const tree: PaneTree = { type: 'split', id: 's1', orientation: 'row', children: [
      { node: createLeaf('a'), size: 0.2 }, { node: createLeaf('b'), size: 0.3 }, { node: createLeaf('c'), size: 0.5 }
    ] };
    const pruned = pruneTree(tree, new Set(['a', 'c'])) as PaneSplit;
    expect(pruned.children).toHaveLength(2);
    expect(pruned.children[0]!.size).toBeCloseTo(0.2 / 0.7);
    expect(pruned.children[1]!.size).toBeCloseTo(0.5 / 0.7);
  });

  it('reassigns the active tab when it was the one that closed', () => {
    const leaf = createLeaf('a');
    const withB = { ...leaf, sessions: ['a', 'b'], active: 'b' };
    const pruned = pruneTree(withB, new Set(['a']));
    expect(pruned).toEqual({ ...leaf, sessions: ['a'], active: 'a' });
  });

  it('returns undefined once nothing live is left', () => {
    expect(pruneTree(createLeaf('a'), new Set())).toBeUndefined();
  });
});

describe('detachSession', () => {
  it('removes a tab from view without any notion of "closed" — same shape as pruning one id', () => {
    const leaf = { ...createLeaf('a'), sessions: ['a', 'b'], active: 'b' };
    expect(detachSession(leaf, 'b')).toEqual({ ...leaf, sessions: ['a'], active: 'a' });
  });
});

describe('resizeSplit', () => {
  it('moves size between exactly the dragged pair, conserving their sum', () => {
    const tree: PaneTree = { type: 'split', id: 's1', orientation: 'row', children: [
      { node: createLeaf('a'), size: 1 / 3 }, { node: createLeaf('b'), size: 1 / 3 }, { node: createLeaf('c'), size: 1 / 3 }
    ] };
    const resized = resizeSplit(tree, 's1', 0, 0.1) as PaneSplit;
    expect(resized.children[0]!.size).toBeCloseTo(1 / 3 + 0.1);
    expect(resized.children[1]!.size).toBeCloseTo(1 / 3 - 0.1);
    expect(resized.children[2]!.size).toBeCloseTo(1 / 3);
  });

  it('clamps at the minimum pane size without spilling into an uninvolved sibling', () => {
    const tree: PaneTree = { type: 'split', id: 's1', orientation: 'row', children: [
      { node: createLeaf('a'), size: 0.5 }, { node: createLeaf('b'), size: 0.5 }
    ] };
    const resized = resizeSplit(tree, 's1', 0, 0.9) as PaneSplit;
    expect(resized.children[0]!.size).toBeCloseTo(0.9);
    expect(resized.children[1]!.size).toBeCloseTo(0.1);
  });
});
