import type { Line } from './format.js';
/** Poll until the frame satisfies `pattern` (rendering speed varies by machine); fails with the last frame. */
export async function waitFor(frame: () => string, pattern: RegExp, timeoutMs = 2000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  let last = frame();
  while (!pattern.test(last)) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${pattern}; last frame:\n${last}`);
    await new Promise((r) => setTimeout(r, 15));
    last = frame();
  }
  return last;
}

/**
 * A line's text as MONOCHROME draws it (6.15): bar track cells show as "░" (in colour the track is a flat dim background,
 * so its plain text is blank — see the colour frame tests). Fill cells are spaces; label glyphs show as themselves.
 */
export function barText(line: Line): string {
  return line.map((s) => (s.surface?.kind === 'track' ? s.text.replace(/ /g, '░') : s.text)).join('');
}
