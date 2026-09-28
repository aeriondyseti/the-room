// Incremental, read-only JSONL reader with a restartable byte-offset cursor (proposal "Minimal observation").
// Handles: partial trailing lines (kept until complete), truncation/replacement (size shrinks → restart),
// and unparsable lines (counted, skipped — transcripts are not ours to validate).
import { open, stat } from 'node:fs/promises';

export interface TailCursor {
  path: string;
  /** Byte offset of the first unconsumed byte (always at a line boundary). */
  offset: number;
}

export interface TailRead {
  records: unknown[];
  /** True when the file shrank and reading restarted from 0 (consumers must reset derived state). */
  restarted: boolean;
  skippedLines: number;
  /** False when the file does not exist (or can't be read). */
  exists: boolean;
}

/** Upper bound read per call so a huge transcript can't stall a caller; the rest is read on later calls. */
export const MAX_READ_BYTES = 8 * 1024 * 1024;

export async function readNew(cursor: TailCursor, maxBytes: number = MAX_READ_BYTES): Promise<TailRead> {
  let size: number;
  try {
    size = (await stat(cursor.path)).size;
  } catch {
    return { records: [], restarted: false, skippedLines: 0, exists: false };
  }
  let restarted = false;
  if (size < cursor.offset) {
    cursor.offset = 0;
    restarted = true;
  }
  if (size === cursor.offset) return { records: [], restarted, skippedLines: 0, exists: true };

  const length = Math.min(size - cursor.offset, maxBytes);
  const buffer = Buffer.alloc(length);
  const handle = await open(cursor.path, 'r');
  let bytesRead: number;
  try {
    ({ bytesRead } = await handle.read(buffer, 0, length, cursor.offset));
  } finally {
    await handle.close();
  }
  // Only consume through the last complete line; a partial trailing line is re-read next time.
  const lastNewline = buffer.lastIndexOf(0x0a, bytesRead - 1);
  if (lastNewline === -1) {
    if (bytesRead === maxBytes) {
      // A single line longer than the read window: skip it rather than stall forever.
      cursor.offset += bytesRead;
      return { records: [], restarted, skippedLines: 1, exists: true };
    }
    return { records: [], restarted, skippedLines: 0, exists: true };
  }
  const text = buffer.subarray(0, lastNewline + 1).toString('utf8');
  cursor.offset += lastNewline + 1;

  const records: unknown[] = [];
  let skippedLines = 0;
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    try {
      records.push(JSON.parse(trimmed));
    } catch {
      skippedLines++;
    }
  }
  return { records, restarted, skippedLines, exists: true };
}
