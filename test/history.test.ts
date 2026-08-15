import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {COALESCE_MS, createHistory} from '../src/state/history';

interface Doc {
  text: string;
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('undo and redo', () => {
  it('walks back and forward through changes', () => {
    const h = createHistory<Doc>();
    const a = {text: 'a'};
    const b = {text: 'b'};
    const c = {text: 'c'};

    h.push(a, 'to b');   // a -> b
    h.push(b, 'to c');   // b -> c

    expect(h.undo(c)).toEqual({state: b, label: 'to c'});
    expect(h.undo(b)).toEqual({state: a, label: 'to b'});
    expect(h.canUndo()).toBe(false);

    expect(h.redo(a)).toEqual({state: b, label: 'to b'});
    expect(h.redo(b)).toEqual({state: c, label: 'to c'});
    expect(h.canRedo()).toBe(false);
  });

  it('returns undefined rather than throwing at either end', () => {
    const h = createHistory<Doc>();
    expect(h.undo({text: 'x'})).toBeUndefined();
    expect(h.redo({text: 'x'})).toBeUndefined();
  });

  it('drops the redo branch once a new change lands', () => {
    // Standard editor behaviour: you cannot redo into a future you diverged from.
    const h = createHistory<Doc>();
    h.push({text: 'a'}, 'to b');
    h.undo({text: 'b'});
    expect(h.canRedo()).toBe(true);

    h.push({text: 'a'}, 'to z');
    expect(h.canRedo()).toBe(false);
  });

  it('collapses a burst of edits to the same field', () => {
    // One undo step per keystroke makes undo useless.
    const h = createHistory<Doc>();
    h.push({text: ''}, 'edit path', 'n1:path');
    vi.advanceTimersByTime(100);
    h.push({text: '/u'}, 'edit path', 'n1:path');
    vi.advanceTimersByTime(100);
    h.push({text: '/us'}, 'edit path', 'n1:path');

    expect(h.size().past).toBe(1);
    // …and undo goes back to before the whole burst.
    expect(h.undo({text: '/users'})).toEqual({state: {text: ''}, label: 'edit path'});
  });

  it('starts a new entry once the burst pauses', () => {
    const h = createHistory<Doc>();
    h.push({text: ''}, 'edit path', 'n1:path');
    vi.advanceTimersByTime(COALESCE_MS + 50);
    h.push({text: '/u'}, 'edit path', 'n1:path');

    expect(h.size().past).toBe(2);
  });

  it('does not collapse edits to different fields', () => {
    const h = createHistory<Doc>();
    h.push({text: 'a'}, 'edit path', 'n1:path');
    h.push({text: 'b'}, 'edit body', 'n1:body');
    expect(h.size().past).toBe(2);
  });

  it('never collapses changes with no coalesce key', () => {
    // Structural changes — adding, deleting, an AI edit — are always separate.
    const h = createHistory<Doc>();
    h.push({text: 'a'}, 'add step');
    h.push({text: 'b'}, 'add step');
    expect(h.size().past).toBe(2);
  });

  it('forgets the oldest entries past the limit', () => {
    const h = createHistory<Doc>(3);
    for (let i = 0; i < 6; i++) h.push({text: String(i)}, `change ${i}`);

    expect(h.size().past).toBe(3);
    // The three most recent survived; the oldest were dropped.
    expect(h.undo({text: 'now'})!.state).toEqual({text: '5'});
  });

  it('names what undo and redo would do', () => {
    const h = createHistory<Doc>();
    h.push({text: 'a'}, 'add step');
    expect(h.peek().undo).toBe('add step');

    h.undo({text: 'b'});
    expect(h.peek().redo).toBe('add step');
    expect(h.peek().undo).toBeUndefined();
  });

  it('clears both stacks', () => {
    const h = createHistory<Doc>();
    h.push({text: 'a'}, 'x');
    h.undo({text: 'b'});
    h.clear();
    expect(h.size()).toEqual({past: 0, future: 0});
  });
});
