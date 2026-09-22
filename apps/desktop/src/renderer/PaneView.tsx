import { Fragment, useCallback, useRef, useState } from 'react';
import { Terminal } from './Terminal';
import { SessionName, type Selection } from './sessionSubject';
import { CloseIcon } from './icons';
import type { DropZone, PaneLeaf, PaneSplit, PaneTree } from './paneTree';
import type { SessionInfo, Snapshot } from './types';

/**
 * A drag in progress — one session id, a pointer position for the ghost
 * label, and, while the pointer sits over a pane, which one and which fifth
 * of it. `undefined` means nothing is being dragged.
 */
export interface DragState {
  sessionId: string;
  x: number;
  y: number;
  hover?: { leafId: string; zone: DropZone };
}

/**
 * `handlers(sessionId, onClick)` turns any element — a sidebar row, a tab —
 * into a drag source: spread the result onto it and it is both clickable and
 * draggable, the same pointer-capture technique `Resizer` uses for its own
 * single-axis drag, generalised to "wherever the pointer ends up."
 */
export interface DragHandlers {
  state: DragState | undefined;
  handlers: (sessionId: string, onClick: () => void) => {
    onPointerDown: (event: React.PointerEvent) => void;
    onPointerMove: (event: React.PointerEvent) => void;
    onPointerUp: (event: React.PointerEvent) => void;
    onPointerCancel: (event: React.PointerEvent) => void;
  };
}

const ZONE_LABEL: Record<DropZone, string> = {
  center: 'Move here', top: 'Split up', bottom: 'Split down', left: 'Split left', right: 'Split right'
};

function DropOverlay({ zone }: { zone: DropZone }) {
  return (
    <div className={`pane-drop zone-${zone}`}>
      <div className="pane-drop-target">
        <span>{ZONE_LABEL[zone]}</span>
      </div>
    </div>
  );
}

function PaneTabStrip({
  leaf, sessions, drag, onFocusTab, onDetachTab
}: {
  leaf: PaneLeaf;
  sessions: SessionInfo[];
  drag: DragHandlers;
  onFocusTab: (leafId: string, sessionId: string) => void;
  onDetachTab: (sessionId: string) => void;
}) {
  return (
    <div className="pane-tabs" role="tablist">
      {leaf.sessions.map((id) => {
        const s = sessions.find((x) => x.id === id);
        if (!s) return null;
        return (
          <div
            key={id}
            role="tab"
            aria-selected={id === leaf.active}
            className={id === leaf.active ? 'pane-tab active' : 'pane-tab'}
            {...drag.handlers(id, () => onFocusTab(leaf.id, id))}
          >
            <span className={s.running ? (s.attention ? 'dot running' : 'dot live') : 'dot'} />
            <span className="pane-tab-title">{s.title}</span>
            <button
              type="button"
              className="pane-tab-close"
              aria-label={`Remove ${s.title} from this pane`}
              title="Remove from this pane (keeps it running — find it again in the list)"
              onPointerDown={(e) => e.stopPropagation()}
              onClick={(e) => { e.stopPropagation(); onDetachTab(id); }}
            >
              <CloseIcon size={10} />
            </button>
          </div>
        );
      })}
    </div>
  );
}

function PaneLeafView({
  leaf, sessions, snapshot, fontSize, onOpenSubject, onRename,
  drag, onFocusTab, onDetachTab
}: {
  leaf: PaneLeaf;
  sessions: SessionInfo[];
  snapshot: Snapshot;
  fontSize: number;
  onOpenSubject: (match: Selection) => void;
  onRename: (id: string, title: string) => void;
  drag: DragHandlers;
  onFocusTab: (leafId: string, sessionId: string) => void;
  onDetachTab: (sessionId: string) => void;
}) {
  const shown = sessions.find((s) => s.id === leaf.active);
  const hoverZone = drag.state?.hover?.leafId === leaf.id ? drag.state.hover.zone : undefined;
  const [renaming, setRenaming] = useState(false);

  return (
    <div className="pane-leaf" data-pane-leaf={leaf.id}>
      {leaf.sessions.length > 1 && (
        <PaneTabStrip leaf={leaf} sessions={sessions} drag={drag} onFocusTab={onFocusTab} onDetachTab={onDetachTab} />
      )}
      {shown ? (
        <>
          <div className="term-head">
            <div className="term-head-name">
              <span className="term-head-title-row">
                <SessionName
                  session={shown} snapshot={snapshot} onOpenSubject={onOpenSubject}
                  editing={renaming} onEdit={setRenaming} onRename={onRename}
                  className="term-title"
                />
              </span>
              <span className="term-cwd">{shown.cwd}</span>
            </div>
            <div className="term-head-actions">
              <button
                type="button" className="icon-button boxed" aria-label="Close session" title="Close session"
                onClick={() => void window.baton.sessionClose(shown.id)}
              >
                <CloseIcon size={11} />
              </button>
            </div>
          </div>
          <Terminal sessionId={shown.id} fontSize={fontSize} />
        </>
      ) : (
        <div className="term-empty">
          <p className="quiet">Nothing in this pane.</p>
        </div>
      )}
      {hoverZone && <DropOverlay zone={hoverZone} />}
    </div>
  );
}

function PaneDivider({
  splitId, index, orientation, onResize
}: {
  splitId: string;
  index: number;
  orientation: 'row' | 'column';
  onResize: (splitId: string, index: number, delta: number) => void;
}) {
  const grab = useRef(0);

  const down = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    const container = event.currentTarget.parentElement;
    if (!container) return;
    const rect = container.getBoundingClientRect();
    grab.current = orientation === 'row' ? rect.width : rect.height;
    event.currentTarget.setPointerCapture(event.pointerId);
    event.currentTarget.classList.add('dragging');
    document.body.classList.add(orientation === 'row' ? 'resizing' : 'resizing-row');
  }, [orientation]);

  const move = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if (!event.currentTarget.hasPointerCapture(event.pointerId) || grab.current === 0) return;
    const delta = orientation === 'row' ? event.movementX : event.movementY;
    onResize(splitId, index, delta / grab.current);
  }, [orientation, splitId, index, onResize]);

  const up = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
    event.currentTarget.releasePointerCapture(event.pointerId);
    event.currentTarget.classList.remove('dragging');
    document.body.classList.remove('resizing', 'resizing-row');
  }, []);

  return (
    <div
      className={orientation === 'row' ? 'pane-divider vertical' : 'pane-divider horizontal'}
      role="separator"
      aria-orientation={orientation === 'row' ? 'vertical' : 'horizontal'}
      onPointerDown={down}
      onPointerMove={move}
      onPointerUp={up}
      onPointerCancel={up}
    />
  );
}

function PaneNodeView(props: {
  node: PaneTree;
  sessions: SessionInfo[];
  snapshot: Snapshot;
  fontSize: number;
  onOpenSubject: (match: Selection) => void;
  onRename: (id: string, title: string) => void;
  drag: DragHandlers;
  onFocusTab: (leafId: string, sessionId: string) => void;
  onDetachTab: (sessionId: string) => void;
  onResize: (splitId: string, index: number, delta: number) => void;
}) {
  const { node } = props;
  if (node.type === 'leaf') {
    return (
      <PaneLeafView
        leaf={node} sessions={props.sessions} snapshot={props.snapshot} fontSize={props.fontSize}
        onOpenSubject={props.onOpenSubject} onRename={props.onRename}
        drag={props.drag} onFocusTab={props.onFocusTab} onDetachTab={props.onDetachTab}
      />
    );
  }
  const split = node as PaneSplit;
  return (
    <div className={split.orientation === 'row' ? 'pane-split row' : 'pane-split column'}>
      {split.children.map((child, i) => (
        <Fragment key={child.node.id}>
          {i > 0 && (
            <PaneDivider splitId={split.id} index={i - 1} orientation={split.orientation} onResize={props.onResize} />
          )}
          <div
            className="pane-split-child"
            style={split.orientation === 'row' ? { width: `${child.size * 100}%` } : { height: `${child.size * 100}%` }}
          >
            <PaneNodeView {...props} node={child.node} />
          </div>
        </Fragment>
      ))}
    </div>
  );
}

/** The Sessions tab's whole right-hand side: a tree of splits and tab groups,
 *  built up entirely by dragging — see `paneTree.ts` for the data model. */
export function PaneView(props: {
  tree: PaneTree;
  sessions: SessionInfo[];
  snapshot: Snapshot;
  fontSize: number;
  onOpenSubject: (match: Selection) => void;
  onRename: (id: string, title: string) => void;
  drag: DragHandlers;
  onFocusTab: (leafId: string, sessionId: string) => void;
  onDetachTab: (sessionId: string) => void;
  onResize: (splitId: string, index: number, delta: number) => void;
}) {
  return (
    <div className="pane-root">
      <PaneNodeView {...props} node={props.tree} />
      {props.drag.state && (
        <div className="pane-drag-ghost" style={{ left: props.drag.state.x, top: props.drag.state.y }}>
          {props.sessions.find((s) => s.id === props.drag.state!.sessionId)?.title}
        </div>
      )}
    </div>
  );
}
