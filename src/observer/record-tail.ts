// Hardened, read-only JSONL record tail for activity observation (6.1). Improves on jsonl-tail (usage) where the
// activity view needs more (Astra's review):
//  - source identity: device+inode+birthtime plus a hash of the file's head, so a *replacement* (even at the same
//    or a larger size) is detected as a rotation, not just a shrink;
//  - per-record byte offsets (stable identity for dedup and item ids);
//  - bounded oversized-line handling: a line longer than `maxLineBytes` is skipped *to its terminating newline*,
//    even across reads, so the next record is never parsed from the middle of one;
//  - counts of malformed and oversized records, and a backlog flag, for honest coverage.
// Never writes anything; never returns raw line text.
import { createHash } from 'node:crypto';
import { open, stat } from 'node:fs/promises';

export interface SourceIdentity {
  dev: string;
  ino: string;
  birthtimeMs: number;
  /** sha256 of the first HEAD_BYTES bytes (or the whole file if shorter) at the time identity was taken. */
  head: string;
  headLength: number;
}

export interface RecordCursor {
  path: string;
  /** Byte offset of the first unconsumed byte. */
  offset: number;
  source: SourceIdentity | null;
  /** Mid-way through skipping an oversized line: discard up to and including the next newline first. */
  skipping: boolean;
}

export interface TailRecord {
  value: unknown;
  /** Byte offset of the record's line start. */
  offset: number;
}

export interface RecordRead {
  records: TailRecord[];
  /** The source was replaced/rotated/truncated since the cursor was taken: reading restarted at 0. */
  rotated: boolean;
  malformed: number;
  oversized: number;
  exists: boolean;
  /** Unread bytes remain after this call (the read window was full). */
  backlog: boolean;
}

export const HEAD_BYTES = 256;

export function newCursor(path: string): RecordCursor {
  return { path, offset: 0, source: null, skipping: false };
}

async function identify(path: string, size: number): Promise<SourceIdentity> {
  const st = await stat(path, { bigint: true });
  const headLength = Math.min(HEAD_BYTES, size);
  const buf = Buffer.alloc(headLength);
  const handle = await open(path, 'r');
  try {
    await handle.read(buf, 0, headLength, 0);
  } finally {
    await handle.close();
  }
  return { dev: String(st.dev), ino: String(st.ino), birthtimeMs: Number(st.birthtimeMs), head: createHash('sha256').update(buf).digest('hex'), headLength };
}

/** Same file? Identity fields must match, and the head bytes we hashed must be unchanged (compare over the old length). */
async function sameSource(path: string, known: SourceIdentity, size: number): Promise<boolean> {
  const now = await identify(path, Math.min(size, known.headLength));
  return now.dev === known.dev && now.ino === known.ino && now.birthtimeMs === known.birthtimeMs && now.head === known.head;
}

export async function readRecords(
  cursor: RecordCursor,
  opts: { maxBytes?: number; maxLineBytes?: number } = {},
): Promise<RecordRead> {
  const maxBytes = opts.maxBytes ?? 8 * 1024 * 1024;
  const maxLineBytes = Math.min(opts.maxLineBytes ?? 1024 * 1024, maxBytes);
  const empty = (exists: boolean, rotated = false): RecordRead => ({ records: [], rotated, malformed: 0, oversized: 0, exists, backlog: false });

  let size: number;
  try {
    size = (await stat(cursor.path)).size;
  } catch {
    return empty(false);
  }

  let rotated = false;
  try {
    if (cursor.source === null) {
      cursor.source = await identify(cursor.path, size);
    } else if (size < cursor.offset || size < cursor.source.headLength || !(await sameSource(cursor.path, cursor.source, size))) {
      cursor.offset = 0;
      cursor.skipping = false;
      cursor.source = await identify(cursor.path, size);
      rotated = true;
    }
  } catch {
    return empty(false); // vanished or locked between stat and open: not readable now, cursor untouched
  }
  // The head grows while the file is short: refresh the hash once more bytes exist (same file, longer head).
  if (cursor.source.headLength < HEAD_BYTES && size > cursor.source.headLength) {
    try {
      cursor.source = await identify(cursor.path, size);
    } catch {
      return empty(false, rotated);
    }
  }
  if (size === cursor.offset) return empty(true, rotated);

  const length = Math.min(size - cursor.offset, maxBytes);
  const buf = Buffer.alloc(length);
  let got: number;
  try {
    const handle = await open(cursor.path, 'r');
    try {
      ({ bytesRead: got } = await handle.read(buf, 0, length, cursor.offset));
    } finally {
      await handle.close();
    }
  } catch {
    return empty(false, rotated);
  }
  const data = buf.subarray(0, got);
  const records: TailRecord[] = [];
  let malformed = 0;
  let oversized = 0;
  let pos = 0;

  if (cursor.skipping) {
    const nl = data.indexOf(0x0a);
    if (nl === -1) {
      cursor.offset += got; // still inside the oversized line
      return { records, rotated, malformed, oversized, exists: true, backlog: size > cursor.offset };
    }
    pos = nl + 1;
    cursor.skipping = false;
  }

  while (pos < got) {
    const nl = data.indexOf(0x0a, pos);
    if (nl === -1) {
      const pending = got - pos;
      if (pending >= maxLineBytes) {
        // An unterminated line already beyond the cap: count it once and skip to its newline on later reads.
        oversized++;
        cursor.skipping = true;
        pos = got;
      }
      break; // otherwise a partial trailing line: re-read next time
    }
    const lineLen = nl - pos;
    if (lineLen > maxLineBytes) {
      oversized++;
    } else {
      const text = data.subarray(pos, nl).toString('utf8').trim();
      if (text !== '') {
        try {
          records.push({ value: JSON.parse(text), offset: cursor.offset + pos });
        } catch {
          malformed++;
        }
      }
    }
    pos = nl + 1;
  }
  cursor.offset += pos;
  return { records, rotated, malformed, oversized, exists: true, backlog: size > cursor.offset };
}
