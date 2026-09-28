// Raw key identity (6.13). Ink's useInput collapses keys the composer must tell apart: both BS (0x08) and DEL (0x7F)
// become `backspace` with ctrl=false, and a standalone LF (0x0A) arrives as an unnamed, empty input. Kevin's live
// Windows Terminal probe (Astra, room #233): Enter = CR, Ctrl+Enter = LF, Backspace = DEL, Ctrl+Backspace = BS.
// So the app keeps the raw bytes of the key being handled (from Ink's own input emitter — no node_modules patch, no
// second input path) and classifies them here. CSI-u forms (ESC[13;5u, ESC[127;5u) are already decoded by Ink.
import { useEffect, useRef, type MutableRefObject } from 'react';
import { useStdin } from 'ink';
import type { EventEmitter } from 'node:events';

export type RawKey = 'ctrl-enter' | 'ctrl-backspace' | null;

/**
 * Classify the raw bytes of one key event. LF alone means Ctrl+Enter (terminals send CR for Enter). BS means
 * Ctrl+Backspace only where that's been qualified (Windows Terminal: `bsIsCtrlBackspace`), because other terminals send
 * BS for a plain Backspace. DEL is always a plain Backspace. Multi-character input (a paste) is never a shortcut.
 */
export function classifyRawKey(raw: string | null, opts: { bsIsCtrlBackspace: boolean }): RawKey {
  if (raw === '\n') return 'ctrl-enter';
  if (raw === '\b' && opts.bsIsCtrlBackspace) return 'ctrl-backspace';
  return null;
}

/** Whether BS is Ctrl+Backspace in this terminal: Windows Terminal sets WT_SESSION (qualified by Kevin's probe). */
export function bsIsCtrlBackspaceIn(env: NodeJS.ProcessEnv = process.env): boolean {
  return typeof env.WT_SESSION === 'string' && env.WT_SESSION !== '';
}

/**
 * The raw bytes of the key currently being handled. Call this BEFORE useInput in the same component: listeners run in
 * registration order, so the ref is up to date when the useInput handler reads it.
 */
export function useRawKey(): MutableRefObject<string | null> {
  const last = useRef<string | null>(null);
  const { internal_eventEmitter: emitter } = useStdin() as unknown as { internal_eventEmitter?: EventEmitter };
  useEffect(() => {
    if (!emitter) return;
    const onInput = (data: string) => {
      last.current = data;
    };
    emitter.on('input', onInput);
    return () => {
      emitter.removeListener('input', onInput);
    };
  }, [emitter]);
  return last;
}
