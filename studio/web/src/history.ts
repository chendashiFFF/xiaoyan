import type { Action } from './types';

const LIMIT = 200;
const COALESCE_MS = 1200;

export interface HistoryState {
  doc: Action | null;
  past: Action[];
  future: Action[];
  /** Bumped on every user change (not on load) so autosave can react to it. */
  revision: number;
  lastKey: string | null;
  lastAt: number;
}

export type HistoryEvent =
  | { type: 'load'; doc: Action }
  | { type: 'edit'; update: (doc: Action) => Action; coalesce?: string }
  | { type: 'undo' }
  | { type: 'redo' };

export const initialHistory: HistoryState = { doc: null, past: [], future: [], revision: 0, lastKey: null, lastAt: 0 };

export function historyReducer(state: HistoryState, event: HistoryEvent): HistoryState {
  switch (event.type) {
    case 'load':
      return { ...initialHistory, doc: event.doc, revision: 0 };
    case 'edit': {
      if (!state.doc) return state;
      const next = event.update(state.doc);
      if (next === state.doc) return state;
      const now = Date.now();
      // Rapid edits with the same key (dragging, typing) collapse into one undo step.
      const merge = Boolean(event.coalesce) && event.coalesce === state.lastKey && now - state.lastAt < COALESCE_MS;
      return {
        doc: next,
        past: merge ? state.past : [...state.past, state.doc].slice(-LIMIT),
        future: [],
        revision: state.revision + 1,
        lastKey: event.coalesce ?? null,
        lastAt: now,
      };
    }
    case 'undo': {
      if (!state.doc || !state.past.length) return state;
      const previous = state.past[state.past.length - 1];
      return {
        doc: previous,
        past: state.past.slice(0, -1),
        future: [state.doc, ...state.future],
        revision: state.revision + 1,
        lastKey: null,
        lastAt: 0,
      };
    }
    case 'redo': {
      if (!state.doc || !state.future.length) return state;
      const [next, ...rest] = state.future;
      return {
        doc: next,
        past: [...state.past, state.doc],
        future: rest,
        revision: state.revision + 1,
        lastKey: null,
        lastAt: 0,
      };
    }
  }
}
