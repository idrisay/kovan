/**
 * Back and forward (item 116), as in a browser: every place you go — a view,
 * the pull request, ticket or Sentry issue open in it, the session on screen —
 * is a step, and Back returns to the one before. Going somewhere new after
 * going back drops the steps ahead, as a browser does.
 *
 * Returning to a place changes the state that makes it up, so the place it
 * produces matches the step already current and nothing new is recorded:
 * there is no "restoring" flag to get out of step.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

const LIMIT = 100;

export interface NavHistory<P> {
  canBack: boolean;
  canForward: boolean;
  /** The step Back / Forward would return to, for the buttons' tooltips. */
  previous?: P;
  next?: P;
  back(): void;
  forward(): void;
}

export function useNavHistory<P>(
  place: P,
  key: (p: P) => string,
  go: (p: P) => void,
  /** Whether `next` refines `current` rather than leaving it — replaced, not added. */
  refines: (current: P, next: P) => boolean = () => false
): NavHistory<P> {
  const steps = useRef<P[]>([]);
  const [index, setIndex] = useState(-1);
  const at = useRef(-1);
  const current = key(place);

  useEffect(() => {
    const here = steps.current[at.current];
    if (here && key(here) === current) return;
    // Replaces what was ahead, the way following a link after Back does.
    const kept = here && refines(here, place) ? at.current : at.current + 1;
    steps.current = [...steps.current.slice(0, kept), place].slice(-LIMIT);
    at.current = steps.current.length - 1;
    setIndex(at.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current]);

  const move = useCallback((delta: -1 | 1) => {
    const target = at.current + delta;
    const step = steps.current[target];
    if (!step) return;
    at.current = target;
    setIndex(target);
    go(step);
  }, [go]);

  return {
    canBack: index > 0,
    canForward: index < steps.current.length - 1,
    previous: steps.current[index - 1],
    next: steps.current[index + 1],
    back: () => move(-1),
    forward: () => move(1)
  };
}
