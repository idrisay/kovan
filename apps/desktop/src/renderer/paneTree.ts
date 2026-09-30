/**
 * The Sessions tab's layout: a tree of splits and tab groups, the same shape
 * VS Code's editor groups use — drag a tab onto the center of another group
 * to move it there, onto an edge to split that group in that direction.
 *
 * Kept as pure data + pure functions, no DOM and no React, so the tricky part
 * (what a drop actually does to the tree) can be tested directly rather than
 * through pointer events on a rendered page. `PaneView.tsx` is the only thing
 * that reads DOM geometry; everything here just rearranges an object.
 *
 * Nothing here is persisted across a restart — session ids do not survive
 * one anyway, so there is nothing a saved layout could still be pointing at.
 */

export type PaneOrientation = 'row' | 'column';
export type DropZone = 'center' | 'top' | 'bottom' | 'left' | 'right';

export interface PaneLeaf {
  type: 'leaf';
  id: string;
  /** Tab order. */
  sessions: string[];
  /** Always one of `sessions` — the tab actually showing. */
  active: string;
}

export interface PaneSplit {
  type: 'split';
  id: string;
  orientation: PaneOrientation;
  /** Fractions of the split's own box, summing to 1. */
  children: { node: PaneTree; size: number }[];
}

export type PaneTree = PaneLeaf | PaneSplit;

/** The smallest share a split child is allowed to shrink to — below this a
 *  pane stops being usable regardless of how much room the window has. */
const MIN_SIZE = 0.1;

let counter = 0;
function newId(): string {
  counter += 1;
  return `pane-${Date.now().toString(36)}-${counter}`;
}

export function createLeaf(sessionId: string): PaneLeaf {
  return { type: 'leaf', id: newId(), sessions: [sessionId], active: sessionId };
}

export function findLeaf(tree: PaneTree, sessionId: string): PaneLeaf | undefined {
  if (tree.type === 'leaf') {
    return tree.sessions.includes(sessionId) ? tree : undefined;
  }
  for (const child of tree.children) {
    const found = findLeaf(child.node, sessionId);
    if (found) return found;
  }
  return undefined;
}

export function findLeafById(tree: PaneTree, leafId: string): PaneLeaf | undefined {
  if (tree.type === 'leaf') {
    return tree.id === leafId ? tree : undefined;
  }
  for (const child of tree.children) {
    const found = findLeafById(child.node, leafId);
    if (found) return found;
  }
  return undefined;
}

/** The tab showing in each pane: what is on screen. */
export function shownSessions(tree: PaneTree | undefined): string[] {
  if (!tree) return [];
  return tree.type === 'leaf' ? [tree.active] : tree.children.flatMap((c) => shownSessions(c.node));
}

/** Left-to-right, top-to-bottom — used only to pick somewhere to land a
 *  session that was not dropped anywhere specific (a plain sidebar click). */
export function firstLeaf(tree: PaneTree): PaneLeaf {
  return tree.type === 'leaf' ? tree : firstLeaf(tree.children[0]!.node);
}

function withoutSession(node: PaneTree, sessionId: string): PaneTree | undefined {
  if (node.type === 'leaf') {
    if (!node.sessions.includes(sessionId)) return node;
    const sessions = node.sessions.filter((id) => id !== sessionId);
    if (sessions.length === 0) return undefined;
    const active = node.active === sessionId ? sessions[Math.min(node.sessions.indexOf(sessionId), sessions.length - 1)]! : node.active;
    return { ...node, sessions, active };
  }
  const kept = node.children
    .map((c) => ({ size: c.size, node: withoutSession(c.node, sessionId) }))
    .filter((c): c is { size: number; node: PaneTree } => Boolean(c.node));
  if (kept.length === 0) return undefined;
  if (kept.length === 1) return kept[0]!.node;
  const total = kept.reduce((sum, c) => sum + c.size, 0) || 1;
  return { ...node, children: kept.map((c) => ({ node: c.node, size: c.size / total })) };
}

/** Removes a session from wherever it currently sits, collapsing an emptied
 *  leaf and, in turn, a split left with only one child. */
export function removeSession(tree: PaneTree, sessionId: string): PaneTree | undefined {
  return withoutSession(tree, sessionId);
}

/**
 * Every session id actually still live gets to stay; anything else (a
 * session that has since exited and been closed, or was never placed here)
 * is pruned the same way a manual removal is. Called whenever the Sessions
 * list itself changes, so a closed session's tab cannot linger as a dead end.
 */
export function pruneTree(tree: PaneTree | undefined, liveIds: ReadonlySet<string>): PaneTree | undefined {
  if (!tree) return undefined;
  if (tree.type === 'leaf') {
    const sessions = tree.sessions.filter((id) => liveIds.has(id));
    if (sessions.length === 0) return undefined;
    const active = liveIds.has(tree.active) ? tree.active : sessions[0]!;
    return sessions.length === tree.sessions.length && active === tree.active ? tree : { ...tree, sessions, active };
  }
  const kept = tree.children
    .map((c) => ({ size: c.size, node: pruneTree(c.node, liveIds) }))
    .filter((c): c is { size: number; node: PaneTree } => Boolean(c.node));
  if (kept.length === 0) return undefined;
  if (kept.length === 1) return kept[0]!.node;
  const total = kept.reduce((sum, c) => sum + c.size, 0) || 1;
  return { ...tree, children: kept.map((c) => ({ node: c.node, size: c.size / total })) };
}

function insertIntoLeaf(node: PaneTree, leafId: string, sessionId: string): PaneTree {
  if (node.type === 'leaf') {
    if (node.id !== leafId) return node;
    const sessions = node.sessions.includes(sessionId) ? node.sessions : [...node.sessions, sessionId];
    return { ...node, sessions, active: sessionId };
  }
  return { ...node, children: node.children.map((c) => ({ ...c, node: insertIntoLeaf(c.node, leafId, sessionId) })) };
}

/** Switches which tab is showing in a leaf that already has it — a plain
 *  click on a tab, as opposed to `moveSession`, which is what a drag does
 *  and treats "already there" as a no-op rather than a tab switch. */
export function activateTab(tree: PaneTree, leafId: string, sessionId: string): PaneTree {
  return insertIntoLeaf(tree, leafId, sessionId);
}

/**
 * Splits `leafId` in `edge`'s direction and puts `extra` on that side.
 *
 * When the target already sits inside a split running the same direction
 * (dropping on the right edge of a pane that is already the middle column of
 * a row, say), the new pane joins that row as another sibling instead of
 * nesting a second row-split one level deeper for no visual reason — the same
 * flattening a real editor's split view does.
 */
function insertSplit(node: PaneTree, leafId: string, extra: PaneLeaf, edge: DropZone): PaneTree {
  const orientation: PaneOrientation = edge === 'left' || edge === 'right' ? 'row' : 'column';
  const before = edge === 'left' || edge === 'top';

  if (node.type === 'leaf') {
    if (node.id !== leafId) return node;
    return {
      type: 'split', id: newId(), orientation,
      children: before
        ? [{ node: extra, size: 0.5 }, { node, size: 0.5 }]
        : [{ node, size: 0.5 }, { node: extra, size: 0.5 }]
    };
  }

  const idx = node.children.findIndex((c) => c.node.type === 'leaf' && c.node.id === leafId);
  if (idx !== -1) {
    if (node.orientation === orientation) {
      const n = node.children.length + 1;
      const shrink = (n - 1) / n;
      const children = node.children.map((c) => ({ ...c, size: c.size * shrink }));
      children.splice(before ? idx : idx + 1, 0, { node: extra, size: 1 / n });
      return { ...node, children };
    }
    const target = node.children[idx]!;
    const nested: PaneSplit = {
      type: 'split', id: newId(), orientation,
      children: before
        ? [{ node: extra, size: 0.5 }, { node: target.node, size: 0.5 }]
        : [{ node: target.node, size: 0.5 }, { node: extra, size: 0.5 }]
    };
    const children = [...node.children];
    children[idx] = { node: nested, size: target.size };
    return { ...node, children };
  }

  return { ...node, children: node.children.map((c) => ({ ...c, node: insertSplit(c.node, leafId, extra, edge) })) };
}

/**
 * The one function a drop actually calls: takes `sessionId` out of wherever
 * it was and puts it at `targetLeafId`, either as another tab (`center`) or
 * as a new pane split off in `zone`'s direction.
 */
export function moveSession(tree: PaneTree, sessionId: string, targetLeafId: string, zone: DropZone): PaneTree {
  const source = findLeaf(tree, sessionId);
  if (source?.id === targetLeafId && (zone === 'center' || source.sessions.length === 1)) {
    // Center-drop onto your own tab strip, or an edge-drop with nothing else
    // in the pane to split against — both are no-ops, not a request to
    // destroy and immediately recreate the same single-tab pane.
    return tree;
  }
  const detached = removeSession(tree, sessionId) ?? createLeaf(sessionId);
  if (zone === 'center') {
    return insertIntoLeaf(detached, targetLeafId, sessionId);
  }
  return insertSplit(detached, targetLeafId, createLeaf(sessionId), zone);
}

/**
 * Ensures `sessionId` is visible somewhere — the reconciliation a plain
 * sidebar click or a session opened elsewhere goes through, as opposed to a
 * drag: if it is already placed, just focus it there; otherwise it joins
 * `preferredLeafId` (or the first pane, if that id no longer exists) as a new
 * tab, never a new split — a plain click was never a request to rearrange
 * the layout, only to look at something.
 */
export function focusSession(
  tree: PaneTree | undefined, sessionId: string, preferredLeafId: string | undefined
): { tree: PaneTree; leafId: string } {
  if (!tree) {
    const leaf = createLeaf(sessionId);
    return { tree: leaf, leafId: leaf.id };
  }
  const existing = findLeaf(tree, sessionId);
  if (existing) {
    return { tree: insertIntoLeaf(tree, existing.id, sessionId), leafId: existing.id };
  }
  const target = (preferredLeafId && findLeafById(tree, preferredLeafId)) || firstLeaf(tree);
  return { tree: insertIntoLeaf(tree, target.id, sessionId), leafId: target.id };
}

/** Removes a session from view without touching whether it is still
 *  running — the tab strip's own close button, as opposed to killing it. */
export function detachSession(tree: PaneTree, sessionId: string): PaneTree | undefined {
  return removeSession(tree, sessionId);
}

/**
 * Drags the divider between `children[index]` and `children[index + 1]`.
 * `delta` is a fraction of the split's own box, positive toward the end of
 * the axis. The pair's combined size never changes, so a drag here can never
 * perturb any other pane in the split.
 */
export function resizeSplit(tree: PaneTree, splitId: string, index: number, delta: number): PaneTree {
  if (tree.type === 'leaf') return tree;
  if (tree.id === splitId) {
    const left = tree.children[index];
    const right = tree.children[index + 1];
    if (!left || !right) return tree;
    const pair = left.size + right.size;
    let newLeft = Math.min(pair - MIN_SIZE, Math.max(MIN_SIZE, left.size + delta));
    let newRight = pair - newLeft;
    if (newRight < MIN_SIZE) { newRight = MIN_SIZE; newLeft = pair - newRight; }
    const children = [...tree.children];
    children[index] = { ...left, size: newLeft };
    children[index + 1] = { ...right, size: newRight };
    return { ...tree, children };
  }
  return { ...tree, children: tree.children.map((c) => ({ ...c, node: resizeSplit(c.node, splitId, index, delta) })) };
}
