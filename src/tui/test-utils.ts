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
