#!/usr/bin/env bun
/**
 * docs-check: checks a repo's docs against the per-repo docs process.
 *
 *   bun tools/docs-check.ts [--write] [--root <repo dir>]
 *
 * Checks decision records and their index files, the link-direction rule, cited
 * paths, the plan/ layout, the .gitignore worktree line and every CHANGELOG.md.
 * Prints findings as `path:line: message` and exits 1 when there are any.
 * --write first regenerates docs/decisions/index.md and history.md from the records.
 * A part the repo has not adopted yet (no docs/decisions/, no plan/) is skipped.
 *
 * Self-contained (Bun and git only): copied into each repo as tools/docs-check.ts.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, posix } from "node:path";

export interface Finding {
  path: string;
  line: number;
  message: string;
  /** warnings are printed but do not fail the check */
  warning?: boolean;
}
export interface CheckResult {
  findings: Finding[]; // errors: any one fails the check
  warnings: Finding[];
  written: string[];
}

// ---------------------------------------------------------------- git

function git(root: string, args: string[], input?: string) {
  const proc = Bun.spawnSync(["git", "-C", root, ...args], {
    stdin: input === undefined ? "ignore" : Buffer.from(input),
    stdout: "pipe",
    stderr: "pipe",
  });
  return { ok: proc.exitCode === 0, out: proc.stdout.toString(), err: proc.stderr.toString() };
}

export function gitTopLevel(dir: string): string | null {
  const r = git(dir, ["rev-parse", "--show-toplevel"]);
  return r.ok ? r.out.trim() : null;
}

function lsFiles(root: string, extra: string[]): string[] {
  const r = git(root, ["ls-files", "-z", ...extra]);
  if (!r.ok) throw new Error(`git ls-files failed: ${r.err.trim()}`);
  return r.out.split("\0").filter(Boolean);
}

/** The web URL of a remote (https://host/owner/repo), or null for a local path or unknown form. */
export function webUrl(remote: string): string | null {
  let r = remote.trim();
  let m: RegExpMatchArray | null;
  if ((m = r.match(/^[\w.-]+@([\w.-]+):(?!\/)(.+)$/))) r = `https://${m[1]}/${m[2]}`;
  else if ((m = r.match(/^(?:ssh|git\+ssh|git):\/\/(?:[^@/]+@)?([^/:]+)(?::\d+)?\/(.+)$/))) r = `https://${m[1]}/${m[2]}`;
  else if ((m = r.match(/^(https?):\/\/(?:[^@/]+@)?(.+)$/))) r = `${m[1]}://${m[2]}`;
  else return null;
  r = r.replace(/\/+$/, "").replace(/\.git$/, "");
  return r;
}

// ---------------------------------------------------------------- semver

export interface SemVer {
  major: number;
  minor: number;
  patch: number;
  pre: string[];
  raw: string;
}
const SEMVER_RE =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/;

export function parseSemver(s: string): SemVer | null {
  const m = s.match(SEMVER_RE);
  if (!m) return null;
  return { major: +m[1], minor: +m[2], patch: +m[3], pre: m[4] ? m[4].split(".") : [], raw: s };
}

export function compareSemver(a: SemVer, b: SemVer): number {
  for (const k of ["major", "minor", "patch"] as const) if (a[k] !== b[k]) return a[k] < b[k] ? -1 : 1;
  if (!a.pre.length || !b.pre.length) return (b.pre.length ? 1 : 0) - (a.pre.length ? 1 : 0);
  for (let i = 0; i < Math.max(a.pre.length, b.pre.length); i++) {
    const x = a.pre[i];
    const y = b.pre[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    if (x === y) continue;
    const xn = /^\d+$/.test(x);
    const yn = /^\d+$/.test(y);
    if (xn && yn) return +x < +y ? -1 : 1;
    if (xn !== yn) return xn ? -1 : 1;
    return x < y ? -1 : 1;
  }
  return 0;
}

/** Tag prefix of a changelog: "" at the root, else its folder's name (tags `<name>-vX.Y.Z`). */
export function componentOf(changelogPath: string): string {
  const dir = posix.dirname(changelogPath);
  return dir === "." ? "" : posix.basename(dir);
}

/** version string -> tag name, for the tags of one component ("" = unprefixed `vX.Y.Z`). */
export function versionTags(tags: string[], component: string): Map<string, string> {
  const out = new Map<string, string>();
  const head = component ? `${component}-v` : "v";
  for (const t of tags) {
    if (!t.startsWith(head)) continue;
    const v = t.slice(head.length);
    if (parseSemver(v)) out.set(v, t);
  }
  return out;
}

// ---------------------------------------------------------------- frontmatter

export type FmValue = string | string[] | null;
export interface Frontmatter {
  data: Map<string, FmValue>;
  lines: Map<string, number>;
  end: number; // 1-based line of the closing ---
  errors: { line: number; message: string }[];
}

function stripComment(s: string): string {
  let q: string | null = null;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) {
      if (c === q) q = null;
    } else if (c === '"' || c === "'") {
      if (i === 0 || /\s|\[|,/.test(s[i - 1])) q = c;
    } else if (c === "#" && (i === 0 || /\s/.test(s[i - 1]))) return s.slice(0, i);
  }
  return s;
}

function unquote(s: string): string {
  s = s.trim();
  if (s.length >= 2 && ((s[0] === '"' && s.endsWith('"')) || (s[0] === "'" && s.endsWith("'")))) return s.slice(1, -1);
  return s;
}

function scalar(raw: string): FmValue {
  const s = stripComment(raw).trim();
  if (s === "" || s === "~" || s === "null" || s === '""' || s === "''") return null;
  if (s.startsWith("[") && s.endsWith("]")) {
    const inner = s.slice(1, -1).trim();
    return inner ? inner.split(",").map((x) => unquote(x)).filter((x) => x !== "") : [];
  }
  return unquote(s);
}

export function parseFrontmatter(lines: string[]): Frontmatter | null {
  if ((lines[0] ?? "").replace(/^﻿/, "").trim() !== "---") return null;
  const fm: Frontmatter = { data: new Map(), lines: new Map(), end: 0, errors: [] };
  let key: string | null = null;
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === "---" || line.trim() === "...") {
      fm.end = i + 1;
      return fm;
    }
    const item = line.match(/^\s*-\s+(.*)$|^\s*-$/);
    if (item && key !== null) {
      const cur = fm.data.get(key);
      const v = scalar(item[1] ?? "");
      const arr = Array.isArray(cur) ? cur : [];
      if (typeof v === "string") arr.push(v);
      fm.data.set(key, arr);
      continue;
    }
    const kv = line.match(/^([A-Za-z0-9_][\w-]*)\s*:(.*)$/);
    if (kv) {
      key = kv[1];
      if (fm.data.has(key)) fm.errors.push({ line: i + 1, message: `duplicate frontmatter key "${key}"` });
      fm.data.set(key, scalar(kv[2]));
      fm.lines.set(key, i + 1);
      continue;
    }
    if (line.trim() === "" || line.trim().startsWith("#")) continue;
    // anything else (nested maps, continuation lines) is tolerated and ignored
  }
  fm.errors.push({ line: 1, message: "frontmatter is not closed with ---" });
  fm.end = lines.length;
  return fm;
}

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
function validDate(s: string): boolean {
  const m = s.match(DATE_RE);
  if (!m) return false;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  return d.getUTCFullYear() === +m[1] && d.getUTCMonth() === +m[2] - 1 && d.getUTCDate() === +m[3];
}

// ---------------------------------------------------------------- markdown scanning

interface ProseLine {
  n: number; // 1-based
  text: string; // HTML comments blanked
  ignore: boolean; // carries the docs-check-ignore marker
}

/** Lines outside frontmatter and fenced code blocks, with HTML comments blanked out. */
function proseLines(lines: string[], fmEnd: number): ProseLine[] {
  const out: ProseLine[] = [];
  let fence: { ch: string; len: number } | null = null;
  let inComment = false;
  for (let i = fmEnd; i < lines.length; i++) {
    const raw = lines[i];
    const f = raw.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
    if (fence) {
      if (f && f[1][0] === fence.ch && f[1].length >= fence.len && f[2].trim() === "") fence = null;
      continue;
    }
    if (f && !inComment && !(f[1][0] === "`" && f[2].includes("`"))) {
      fence = { ch: f[1][0], len: f[1].length };
      continue;
    }
    let text = "";
    let j = 0;
    while (j < raw.length) {
      if (inComment) {
        const e = raw.indexOf("-->", j);
        if (e < 0) {
          text += " ".repeat(raw.length - j);
          j = raw.length;
        } else {
          text += " ".repeat(e + 3 - j);
          j = e + 3;
          inComment = false;
        }
      } else {
        const s = raw.indexOf("<!--", j);
        if (s < 0) {
          text += raw.slice(j);
          j = raw.length;
        } else {
          text += raw.slice(j, s);
          j = s;
          inComment = true;
        }
      }
    }
    out.push({ n: i + 1, text, ignore: raw.includes("docs-check-ignore") });
  }
  return out;
}

/** Inline code spans of a line, and the line with them blanked out. */
function codeSpans(s: string): { masked: string; spans: string[] } {
  let masked = "";
  const spans: string[] = [];
  let i = 0;
  while (i < s.length) {
    if (s[i] === "\\" && s[i + 1] === "`") {
      masked += "  ";
      i += 2;
      continue;
    }
    if (s[i] !== "`") {
      masked += s[i++];
      continue;
    }
    let j = i;
    while (s[j] === "`") j++;
    const n = j - i;
    let k = j;
    let close = -1;
    while (k < s.length) {
      if (s[k] === "`") {
        let m = k;
        while (s[m] === "`") m++;
        if (m - k === n) {
          close = k;
          break;
        }
        k = m;
      } else k++;
    }
    if (close < 0) {
      masked += s.slice(i, j);
      i = j;
      continue;
    }
    spans.push(s.slice(j, close).trim());
    masked += " ".repeat(close + n - i);
    i = close + n;
  }
  return { masked, spans };
}

const LINK_RE = /!?\[[^\]]*\]\(\s*(<[^>]*>|[^\s()]*(?:\([^\s()]*\)[^\s()]*)*)(?:\s+(?:"[^"]*"|'[^']*'))?\s*\)/g;
const REFDEF_RE = /^ {0,3}\[([^\]^][^\]]*)\]:\s*(<[^>]*>|\S+)/;
const GIT_SHOW_RE = /git show\s+([^\s`:]+):([^\s`]+)/g;

/** Link targets on a (code-masked) line that name a repo path; null for URLs, anchors and globs. */
function linkTargets(masked: string): string[] {
  const out: string[] = [];
  for (const m of masked.matchAll(LINK_RE)) out.push(m[1]);
  const d = masked.match(REFDEF_RE);
  if (d) out.push(d[2]);
  return out;
}

function cleanLinkTarget(t: string): string | null {
  if (t.startsWith("<") && t.endsWith(">")) t = t.slice(1, -1);
  if (!t || t.startsWith("#")) return null;
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(t)) return null; // any scheme, mailto:, or a drive letter
  t = t.replace(/[?#].*$/, "");
  if (!t || /[*?[\]{}<>]/.test(t)) return null;
  try {
    t = decodeURIComponent(t);
  } catch {
    /* keep as is */
  }
  return t;
}

const EXT_RE = /\.[A-Za-z][A-Za-z0-9]{0,9}$/;

/** A backticked token that looks like a repo path, cleaned; else null. */
function pathToken(tok: string, topDirs: Set<string>): string | null {
  let t = tok.trim();
  if (!t || /\s/.test(t)) return null;
  t = t.replace(/#.*$/, "").replace(/:\d+(?:[:-]\d+)?$/, "");
  if (!/^[A-Za-z0-9._/-]+$/.test(t)) return null; // placeholders, globs, URLs, options, odd notation
  if (!t.includes("/") || t.startsWith("/") || t.startsWith("-")) return null;
  const segs = t.split("/");
  const first = segs.find((s) => s !== ".") ?? "";
  if (first !== ".." && !first.startsWith(".") && first.includes(".") && !topDirs.has(first)) return null; // a domain
  const last = segs[segs.length - 1];
  if (EXT_RE.test(last)) return t;
  if (topDirs.has(first)) return t;
  return null;
}

// ---------------------------------------------------------------- the repo

class Repo {
  root: string;
  tracked: Set<string>;
  trackedDirs = new Set<string>();
  /** every tail of a tracked path from a / boundary ("src/a.ts" for "host/src/a.ts"), for abbreviated citations */
  trackedTails = new Set<string>();
  files: string[];
  topDirs = new Set<string>(["plan", "docs"]);
  ignorePrefixes: string[] = [];
  gitignore: string[] = [];
  private cache = new Map<string, string>();

  constructor(root: string) {
    this.root = root;
    const deleted = new Set(lsFiles(root, ["--deleted"]));
    const cached = lsFiles(root, ["--cached"]).filter((p) => !deleted.has(p));
    const others = lsFiles(root, ["--others", "--exclude-standard"]);
    this.tracked = new Set(cached);
    for (const p of cached) {
      const segs = p.split("/");
      for (let i = 1; i < segs.length; i++) {
        this.trackedDirs.add(segs.slice(0, i).join("/"));
        for (let j = 1; j <= i; j++) this.trackedTails.add(segs.slice(j, i).join("/")); // dir tails
        this.trackedTails.add(segs.slice(i).join("/")); // file tails
      }
      if (segs.length > 1) this.topDirs.add(segs[0]);
    }
    this.files = [...new Set([...cached, ...others])]
      .filter((p) => !p.endsWith("/") && !p.startsWith(".claude/worktrees/"))
      .sort();
    for (const p of others) if (!p.endsWith("/")) this.addUntracked(p);
    const ig = this.read(".docs-check-ignore");
    if (ig !== null)
      this.ignorePrefixes = ig
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter((l) => l && !l.startsWith("#"))
        .map((l) => l.replace(/^\/+/, ""));
    const gi = this.read(".gitignore");
    if (gi !== null) this.gitignore = gi.split(/\r?\n/).map((l) => l.trim());
  }

  read(rel: string): string | null {
    if (this.cache.has(rel)) return this.cache.get(rel)!;
    const abs = join(this.root, rel);
    if (!existsSync(abs)) return null;
    let text: string;
    try {
      text = readFileSync(abs, "utf8").replace(/^﻿/, "");
    } catch {
      return null;
    }
    this.cache.set(rel, text);
    return text;
  }

  forget(rel: string) {
    this.cache.delete(rel);
  }

  ignored(rel: string): boolean {
    return this.ignorePrefixes.some((p) => rel === p || rel.startsWith(p.endsWith("/") ? p : p + "/"));
  }

  /** files not yet added (and not ignored), and their folders: a doc not yet added may cite them */
  untracked = new Set<string>();
  addUntracked(p: string) {
    const segs = p.split("/");
    for (let i = 1; i <= segs.length; i++) this.untracked.add(segs.slice(0, i).join("/"));
  }

  isTracked(p: string): boolean {
    p = p.replace(/\/+$/, "");
    return p === "" || p === "." || this.tracked.has(p) || this.trackedDirs.has(p);
  }

  isGitignoreLine(p: string): boolean {
    const norm = (s: string) => s.replace(/^\/+/, "").replace(/\/+$/, "");
    const n = norm(p);
    return n === ".claude/worktrees" || this.gitignore.some((l) => l && !l.startsWith("#") && !l.startsWith("!") && norm(l) === n);
  }
}

function lines(text: string): string[] {
  return text.split(/\r?\n/);
}

// ---------------------------------------------------------------- decisions

const DECISIONS = "docs/decisions";
const RECORD_RE = /^(\d{4})-[^/]+\.md$/;
const STATUSES = ["proposed", "accepted", "rejected", "deprecated", "superseded"];
const HISTORY_STATUSES = ["superseded", "rejected", "deprecated"];

export interface DecisionRecord {
  file: string; // repo-relative
  name: string; // basename
  num: string; // NNNN from the file name
  id: string; // ADR-NNNN from the file name
  status: string | null;
  date: string;
  supersedes: string[];
  supersededBy: string[];
  tags: string[];
  title: string;
  fm: Frontmatter | null;
}

function asList(v: FmValue | undefined): string[] {
  if (v === undefined || v === null) return [];
  return Array.isArray(v) ? v : [v];
}

function loadRecords(repo: Repo): DecisionRecord[] {
  const recs: DecisionRecord[] = [];
  for (const f of repo.files) {
    if (posix.dirname(f) !== DECISIONS) continue;
    const name = posix.basename(f);
    const m = name.match(RECORD_RE);
    if (!m) continue;
    const text = repo.read(f) ?? "";
    const ls = lines(text);
    const fm = parseFrontmatter(ls);
    const d = fm?.data;
    let title = "";
    for (let i = fm?.end ?? 0; i < ls.length; i++) {
      const h = ls[i].match(/^#\s+(.+?)\s*#*\s*$/);
      if (h) {
        title = h[1];
        break;
      }
    }
    const status = d?.get("status");
    const date = d?.get("date");
    recs.push({
      file: f,
      name,
      num: m[1],
      id: `ADR-${m[1]}`,
      status: typeof status === "string" ? status : null,
      date: typeof date === "string" ? date : "",
      supersedes: asList(d?.get("supersedes")),
      supersededBy: asList(d?.get("superseded-by")),
      tags: asList(d?.get("tags")),
      title,
      fm,
    });
  }
  return recs.sort((a, b) => (a.num === b.num ? (a.name < b.name ? -1 : 1) : a.num < b.num ? -1 : 1));
}

function cell(s: string): string {
  return s.replace(/\|/g, "\\|");
}

function row(r: DecisionRecord, withStatus: boolean): string {
  const cols = [`[${r.id}](${r.name})`, cell(r.title), ...(withStatus ? [r.status ?? ""] : []), r.date, cell(r.tags.join(", "))];
  return `| ${cols.join(" | ")} |`;
}

const inForce = (r: DecisionRecord) => r.status === "accepted" && r.supersededBy.length === 0;
const inHistory = (r: DecisionRecord) => r.status !== null && HISTORY_STATUSES.includes(r.status);

export function renderIndex(recs: DecisionRecord[]): string {
  const head = "| Id | Title | Date | Tags |\n| --- | --- | --- | --- |";
  const body = (rs: DecisionRecord[]) => rs.map((r) => row(r, false) + "\n").join("");
  return (
    "# Decisions\n\n" +
    "The rules in force. Generated by `docs-check --write` from the records in this folder: edit the records, " +
    "not this file. Superseded, rejected and deprecated records are in [history.md](history.md).\n\n" +
    head + "\n" + body(recs.filter(inForce)) +
    "\n## Awaiting Kevin\n\n" +
    "Proposed records, walked with Kevin at grooming.\n\n" +
    head + "\n" + body(recs.filter((r) => r.status === "proposed"))
  );
}

export function renderHistory(recs: DecisionRecord[]): string {
  const byId = new Map<string, DecisionRecord>();
  for (const r of recs) if (!byId.has(r.id)) byId.set(r.id, r);
  // supersession edges, from both directions, between records that exist
  const edges = new Map<string, Set<string>>(); // newer -> older
  const addEdge = (newer: string, older: string) => {
    if (newer === older || !byId.has(newer) || !byId.has(older)) return;
    if (!edges.has(newer)) edges.set(newer, new Set());
    edges.get(newer)!.add(older);
  };
  for (const r of recs) {
    for (const o of r.supersedes) addEdge(r.id, o);
    for (const n of r.supersededBy) addEdge(n, r.id);
  }
  // connected components
  const adj = new Map<string, Set<string>>();
  const link = (a: string, b: string) => {
    if (!adj.has(a)) adj.set(a, new Set());
    adj.get(a)!.add(b);
  };
  for (const [n, olds] of edges) for (const o of olds) (link(n, o), link(o, n));
  const seen = new Set<string>();
  const chains: string[] = [];
  const ref = (id: string) => `[${id}](${byId.get(id)!.name})`;
  for (const start of [...adj.keys()].sort()) {
    if (seen.has(start)) continue;
    const comp: string[] = [];
    const stack = [start];
    seen.add(start);
    while (stack.length) {
      const x = stack.pop()!;
      comp.push(x);
      for (const y of adj.get(x) ?? []) if (!seen.has(y)) (seen.add(y), stack.push(y));
    }
    comp.sort();
    const superseded = new Set<string>();
    for (const n of comp) for (const o of edges.get(n) ?? []) superseded.add(o);
    const heads = comp.filter((id) => !superseded.has(id)).sort().reverse();
    let s = `- ${heads.map((h) => `${ref(h)} ${byId.get(h)!.title} (${byId.get(h)!.status ?? "no status"})`).join("; ")}\n`;
    for (const n of [...comp].reverse()) {
      const olds = [...(edges.get(n) ?? [])].sort();
      if (olds.length) s += `  - ${ref(n)} supersedes ${olds.map(ref).join(", ")}\n`;
    }
    chains.push(s);
  }
  // newest head first
  chains.reverse();
  return (
    "# Decision history\n\n" +
    "Records no longer in force. Generated by `docs-check --write` from the records in this folder: edit the " +
    "records, not this file. The rules in force are in [index.md](index.md).\n\n" +
    "| Id | Title | Status | Date | Tags |\n| --- | --- | --- | --- | --- |\n" +
    recs.filter(inHistory).map((r) => row(r, true) + "\n").join("") +
    "\n## Chains\n\n" +
    "Each chain starts at its newest record.\n" +
    (chains.length ? "\n" + chains.join("") : "")
  );
}

/** Writes `content` if it differs (ignoring line endings), keeping the file's line endings. */
function writeIfChanged(repo: Repo, rel: string, content: string): boolean {
  const old = repo.read(rel);
  if (old !== null && old.replace(/\r\n/g, "\n") === content) return false;
  const crlf = old !== null && old.includes("\r\n");
  writeFileSync(join(repo.root, rel), crlf ? content.replace(/\n/g, "\r\n") : content);
  repo.forget(rel);
  return true;
}

/** ADR ids in the table rows of a region of lines. */
function tableIds(ls: string[], from: number, to: number): { id: string; line: number }[] {
  const out: { id: string; line: number }[] = [];
  for (let i = from; i < to; i++) {
    if (!ls[i].trimStart().startsWith("|")) continue;
    const firstCell = ls[i].split(/(?<!\\)\|/)[1] ?? "";
    const m = firstCell.match(/ADR-\d{4}/);
    if (m) out.push({ id: m[0], line: i + 1 });
  }
  return out;
}

// ---------------------------------------------------------------- the check

class Findings {
  list: Finding[] = [];
  add(path: string, line: number, message: string) {
    this.list.push({ path, line: Math.max(1, line), message });
  }
  warn(path: string, line: number, message: string) {
    this.list.push({ path, line: Math.max(1, line), message, warning: true });
  }
}

export function check(rootDir: string, opts: { write?: boolean } = {}): CheckResult {
  const repo = new Repo(rootDir);
  const out = new Findings();
  const written: string[] = [];

  const hasDecisions = repo.files.some((f) => f.startsWith(DECISIONS + "/"));
  let recs = hasDecisions ? loadRecords(repo) : [];

  if (opts.write && hasDecisions) {
    for (const [rel, text] of [
      [`${DECISIONS}/index.md`, renderIndex(recs)],
      [`${DECISIONS}/history.md`, renderHistory(recs)],
    ] as const) {
      if (writeIfChanged(repo, rel, text)) written.push(rel);
      if (!repo.files.includes(rel)) repo.files.push(rel);
      if (!repo.tracked.has(rel)) repo.addUntracked(rel);
    }
    repo.files.sort();
  }

  if (hasDecisions) checkDecisions(repo, recs, out);
  checkCitations(repo, recs, out);
  checkPlan(repo, recs, hasDecisions, out);
  checkGitignore(repo, out);
  checkChangelogs(repo, out);

  out.list.sort((a, b) => (a.path === b.path ? a.line - b.line : a.path < b.path ? -1 : 1));
  return { findings: out.list.filter((f) => !f.warning), warnings: out.list.filter((f) => f.warning), written };
}

function checkDecisions(repo: Repo, recs: DecisionRecord[], out: Findings) {
  for (const f of repo.files) {
    if (posix.dirname(f) !== DECISIONS || !f.endsWith(".md")) continue;
    const name = posix.basename(f);
    if (name !== "index.md" && name !== "history.md" && !RECORD_RE.test(name))
      out.add(f, 1, "not a decision record (NNNN-title.md), index.md or history.md");
  }

  const byId = new Map<string, DecisionRecord[]>();
  for (const r of recs) byId.set(r.id, [...(byId.get(r.id) ?? []), r]);

  for (const r of recs) {
    const fm = r.fm;
    if (!fm) {
      out.add(r.file, 1, "no YAML frontmatter (--- at line 1)");
      continue;
    }
    for (const e of fm.errors) out.add(r.file, e.line, e.message);
    const at = (k: string) => fm.lines.get(k) ?? 1;
    const d = fm.data;
    for (const k of ["id", "status", "date", "supersedes", "superseded-by", "tags"])
      if (!d.has(k)) out.add(r.file, 1, `frontmatter has no "${k}"`);
    const id = d.get("id");
    if (d.has("id") && id !== r.id) out.add(r.file, at("id"), `id is ${JSON.stringify(id)}; the file name makes it ${r.id}`);
    if (d.has("status") && (r.status === null || !STATUSES.includes(r.status)))
      out.add(r.file, at("status"), `status ${JSON.stringify(d.get("status"))} is not one of ${STATUSES.join(" | ")}`);
    if (d.has("date") && !validDate(r.date)) out.add(r.file, at("date"), "date is not YYYY-MM-DD");
    for (const k of ["supersedes", "tags"])
      if (d.has(k) && d.get(k) !== null && !Array.isArray(d.get(k))) out.add(r.file, at(k), `${k} must be a list ([] when empty)`);
    for (const k of ["aliases", "amends"])
      if (d.has(k))
        out.add(r.file, at(k), k === "amends" ? "no amends: a change is a new record that supersedes this one" : "no aliases: a record has one id");
    if (!r.title) out.add(r.file, fm.end + 1, "no title (# heading)");

    const dup = byId.get(r.id)!;
    if (dup.length > 1 && dup[0] !== r)
      out.add(r.file, at("id"), `${r.id} is also ${dup[0].file}; the later merge takes the next free number`);

    for (const o of r.supersedes) {
      if (o === r.id) out.add(r.file, at("supersedes"), "a record cannot supersede itself");
      // an id from no series in the tree (an old pre-conversion id) is history: a warning
      else if (!byId.has(o)) out.warn(r.file, at("supersedes"), `supersedes ${o}, which has no record in docs/decisions/`);
      // a proposed record leaves the old one in force until Kevin accepts it: no back-pointer yet
      else if (r.status !== "proposed" && !byId.get(o)!.some((x) => x.supersededBy.includes(r.id)))
        out.add(r.file, at("supersedes"), `supersedes ${o}, but ${o} does not list ${r.id} in superseded-by`);
    }
    for (const n of r.supersededBy) {
      if (n === r.id) out.add(r.file, at("superseded-by"), "a record cannot supersede itself");
      else if (!byId.has(n)) out.add(r.file, at("superseded-by"), `superseded-by ${n}, which has no record`);
      else if (!byId.get(n)!.some((x) => x.supersedes.includes(r.id)))
        out.add(r.file, at("superseded-by"), `superseded-by ${n}, but ${n} does not list ${r.id} in supersedes`);
    }
    if (r.status === "superseded" && r.supersededBy.length === 0)
      out.add(r.file, at("status"), "status is superseded but superseded-by is empty");
    if (r.supersededBy.length > 0 && r.status !== "superseded")
      out.add(r.file, at("status"), `superseded-by is set but status is ${r.status ?? "missing"}; set status: superseded`);
  }

  // the index files
  const checkFile = (
    rel: string,
    render: string,
    regions: { label: string; want: DecisionRecord[]; startHeading: RegExp | null; endHeading: RegExp | null }[],
  ) => {
    const text = repo.read(rel);
    if (text === null || !repo.files.includes(rel)) {
      out.add(rel, 1, "missing; run docs-check --write");
      return;
    }
    const ls = lines(text);
    let bad = false;
    for (const reg of regions) {
      let from = 0;
      if (reg.startHeading) {
        const s = ls.findIndex((l) => reg.startHeading!.test(l));
        if (s < 0) {
          out.add(rel, 1, `no "${reg.label}" section; run docs-check --write`);
          bad = true;
          continue;
        }
        from = s + 1;
      }
      let to = ls.length;
      if (reg.endHeading) {
        const e = ls.findIndex((l, i) => i >= from && reg.endHeading!.test(l));
        if (e >= 0) to = e;
      }
      const listed = tableIds(ls, from, to);
      const want = new Set(reg.want.map((r) => r.id));
      const seen = new Set<string>();
      for (const { id, line } of listed) {
        if (seen.has(id)) {
          out.add(rel, line, `${id} is listed twice in ${reg.label}`);
          bad = true;
        }
        seen.add(id);
        if (!want.has(id)) {
          const r = recs.find((x) => x.id === id);
          out.add(rel, line, `${id} does not belong in ${reg.label} (${r ? `status: ${r.status ?? "missing"}${r.supersededBy.length ? ", superseded-by set" : ""}` : "no such record"})`);
          bad = true;
        }
      }
      for (const r of reg.want)
        if (!seen.has(r.id)) {
          out.add(rel, 1, `${r.id} (${r.status}) is missing from ${reg.label}; run docs-check --write`);
          bad = true;
        }
    }
    if (!bad && text.replace(/\r\n/g, "\n") !== render)
      out.add(rel, 1, "out of date with the records (titles, dates, tags or chains); run docs-check --write");
  };
  const awaiting = /^##\s+Awaiting Kevin\s*$/i;
  checkFile(`${DECISIONS}/index.md`, renderIndex(recs), [
    { label: "the rules in force", want: recs.filter(inForce), startHeading: null, endHeading: awaiting },
    { label: "Awaiting Kevin", want: recs.filter((r) => r.status === "proposed"), startHeading: awaiting, endHeading: /^#{1,2}\s/ },
  ]);
  checkFile(`${DECISIONS}/history.md`, renderHistory(recs), [
    { label: "the history table", want: recs.filter(inHistory), startHeading: null, endHeading: /^##\s/ },
  ]);
}

/** Is a repo path inside plan/ deep enough to be a citation of a thing, not of the folder scheme? */
function isPlanThing(p: string): boolean {
  if (!p.startsWith("plan/")) return false;
  const segs = p.replace(/\/+$/, "").split("/");
  return segs.length >= 3 || EXT_RE.test(segs[segs.length - 1]);
}

function checkCitations(repo: Repo, recs: DecisionRecord[], out: Findings) {
  const recByFile = new Map(recs.map((r) => [r.file, r]));
  const gitShows: { file: string; line: number; spec: string }[] = [];

  for (const file of repo.files) {
    if (!file.endsWith(".md") || repo.ignored(file)) continue;
    const text = repo.read(file);
    if (text === null) continue;
    const ls = lines(text);
    const fm = parseFrontmatter(ls);
    const dir = posix.dirname(file) === "." ? "" : posix.dirname(file);
    const isChangelog = posix.basename(file) === "CHANGELOG.md";
    const permanent = isChangelog || posix.dirname(file) === DECISIONS;
    const rec = recByFile.get(file);
    // frozen history: released changelog sections and records no longer in force
    const recordFrozen = !!rec && rec.status !== null && HISTORY_STATUSES.includes(rec.status);

    const resolve = (target: string, link: boolean): string[] => {
      if (link) return [target.startsWith("/") ? posix.normalize(target.slice(1)) : posix.normalize(posix.join(dir || ".", target))];
      if (target.startsWith("./") || target.startsWith("../")) return [posix.normalize(posix.join(dir || ".", target))];
      // a backticked path: from the root, the file's folder, or any folder above it (attachments cite siblings)
      const out = [posix.normalize(target)];
      for (let d = dir; d; d = posix.dirname(d) === "." ? "" : posix.dirname(d)) out.push(posix.normalize(posix.join(d, target)));
      return out;
    };
    const verify = (line: number, shown: string, target: string, link: boolean) => {
      if (repo.isGitignoreLine(target)) return;
      const cands = resolve(target, link);
      if (cands.every((c) => c === ".." || c.startsWith("../"))) {
        out.add(file, line, `cites ${shown}, which is outside the repo`);
        return;
      }
      if (cands.some((c) => repo.isTracked(c))) return;
      // a tracked doc never cites an untracked path; a doc not yet added may cite others not yet added
      if (!repo.tracked.has(file) && cands.some((c) => repo.untracked.has(c.replace(/\/+$/, "")))) return;
      // a backticked path may be abbreviated (turns/x.ts for host/src/turns/x.ts): fine if it names a tracked path's tail
      if (!link && !target.startsWith(".") && repo.trackedTails.has(target.replace(/\/+$/, ""))) return;
      const onDisk = cands.find((c) => !c.startsWith("../") && existsSync(join(repo.root, c)));
      const ignored = onDisk && git(repo.root, ["check-ignore", "-q", "--", onDisk]).ok;
      out.add(
        file,
        line,
        ignored
          ? `cites ${shown}, which git ignores (a tracked doc never cites an untracked path: reword it)`
          : onDisk
            ? `cites ${shown}, which git does not track (git add it, or stop citing it)`
            : `cites ${shown}, which does not exist`,
      );
    };

    let changelogSection: "head" | "unreleased" | "released" = "head";
    let inConfirmation = false;
    for (const pl of proseLines(ls, fm ? fm.end : 0)) {
      if (isChangelog && /^##\s/.test(pl.text)) changelogSection = /^##\s+\[Unreleased\]/i.test(pl.text) ? "unreleased" : "released";
      const heading = pl.text.match(/^(#{1,6})\s+(.*?)\s*$/);
      if (heading) inConfirmation = !!rec && /^confirmation$/i.test(heading[2]);

      for (const m of pl.text.matchAll(GIT_SHOW_RE)) {
        const ref = m[1];
        const path = m[2].replace(/[.,;:)\]]+$/, "");
        if (/[<>*]/.test(ref + path)) continue;
        gitShows.push({ file, line: pl.n, spec: `${ref}:${path}` });
      }

      const { masked, spans } = codeSpans(pl.text);
      const checkPaths = !pl.ignore && !recordFrozen && !(isChangelog && changelogSection === "released");

      for (const raw of linkTargets(masked)) {
        const t = cleanLinkTarget(raw);
        if (t === null) continue;
        if (permanent && resolve(t, true).some(isPlanThing))
          out.add(file, pl.n, `cites ${t}: decision records and changelogs never cite plan/ (say it in words)`);
        else if (checkPaths) verify(pl.n, t, t, true);
      }
      for (const span of spans) {
        if (/^git show\s/.test(span)) continue;
        if (permanent && !/[\s<>*]/.test(span)) {
          const t = span.replace(/#.*$/, "").replace(/:\d+(?:[:-]\d+)?$/, "");
          if (resolve(t, false).some(isPlanThing)) {
            out.add(file, pl.n, `cites ${t}: decision records and changelogs never cite plan/ (say it in words)`);
            continue;
          }
        }
        const p = pathToken(span, repo.topDirs);
        if (p !== null && checkPaths) verify(pl.n, p, p, false);
      }
      if (inConfirmation && checkPaths && !heading) {
        for (const word of masked.split(/\s+/)) {
          const w = word.replace(/^[("'[]+/, "").replace(/[)"'\],.;:!?]+$/, "");
          const p = EXT_RE.test(w) ? pathToken(w, repo.topDirs) : null;
          if (p !== null && !/\]\(/.test(word)) verify(pl.n, p, p, false);
        }
      }
    }

    // debt's where: names the code it concerns
    if (fm && file.startsWith("plan/debt/")) {
      for (const w of asList(fm.data.get("where"))) {
        const p = pathToken(w.split(/\s+/)[0] ?? "", repo.topDirs);
        if (p !== null && !repo.isGitignoreLine(p)) {
          const c = posix.normalize(p);
          if (!repo.isTracked(c)) out.add(file, fm.lines.get("where") ?? 1, `where: ${p} is not a tracked path`);
        }
      }
    }
  }

  if (gitShows.length) {
    const r = git(repo.root, ["cat-file", "--batch-check"], gitShows.map((g) => g.spec).join("\n") + "\n");
    const res = r.out.split(/\r?\n/);
    gitShows.forEach((g, i) => {
      const line = res[i] ?? "";
      if (!/^[0-9a-f]{7,} \w+ \d+$/.test(line)) out.add(g.file, g.line, `git show ${g.spec} does not resolve`);
    });
  }
}

const MILESTONE_RE = /^(\d{3})_[A-Za-z0-9][A-Za-z0-9._-]*$/;
const TASK_RE = /^(\d{3})\.(\d{2})_[A-Za-z0-9][A-Za-z0-9._-]*\.md$/;
const TASK_STATUSES = ["planned", "started", "reviewed", "merged"];
const PLAN_DIRS = ["ideas", "debt", "roadmap", "milestones", "chores"];

function checkPlan(repo: Repo, recs: DecisionRecord[], hasDecisions: boolean, out: Findings) {
  const planFiles = repo.files.filter((f) => f.startsWith("plan/"));
  if (!planFiles.length) return;
  const recIds = new Set(recs.map((r) => r.id));

  const reported = new Set<string>();
  const once = (key: string, path: string, line: number, msg: string) => {
    if (reported.has(key)) return;
    reported.add(key);
    out.add(path, line, msg);
  };

  const milestones = new Map<string, string[]>(); // number -> folders
  for (const f of planFiles) {
    const segs = f.split("/");
    if (segs.length === 2) {
      if (segs[1] !== ".gitkeep") out.add(f, 1, "plan/ holds only ideas/, debt/, chores/, roadmap/ and milestones/");
      continue;
    }
    if (!PLAN_DIRS.includes(segs[1])) {
      once(`dir:${segs[1]}`, f, 1, `plan/${segs[1]}/ is not a plan folder (ideas, debt, chores, roadmap, milestones)`);
      continue;
    }
    const state = segs[1];
    if (state === "roadmap" || state === "milestones") {
      if (segs.length === 3) {
        if (segs[2] !== ".gitkeep") out.add(f, 1, `plan/${state}/ holds only milestone folders (NNN_slug/)`);
        continue;
      }
      const folder = segs.slice(0, 3).join("/");
      const mm = segs[2].match(MILESTONE_RE);
      if (!mm) {
        once(folder, folder, 1, "milestone folder is not NNN_slug");
        continue;
      }
      if (!reported.has(`ms:${folder}`)) {
        reported.add(`ms:${folder}`);
        milestones.set(mm[1], [...(milestones.get(mm[1]) ?? []), folder]);
        if (!repo.files.includes(`${folder}/milestone.md`)) out.add(folder, 1, "milestone folder has no milestone.md");
      }
      if (segs.length > 4) {
        if (segs[3] !== "attachments") once(`${folder}/${segs[3]}`, f, 1, "a milestone folder holds milestone.md, task files and attachments/ only");
        continue;
      }
      const name = segs[3];
      if (name === "milestone.md" || name === ".gitkeep") continue;
      const tm = name.match(TASK_RE);
      if (!tm) {
        out.add(f, 1, name.endsWith(".md") ? "task file is not NNN.NN_slug.md" : "only task files here; other material goes in attachments/");
        continue;
      }
      if (tm[1] !== mm[1]) out.add(f, 1, `task number ${tm[1]}.${tm[2]} does not match its milestone ${mm[1]}`);
      checkTask(repo, f, `${tm[1]}.${tm[2]}`, state, hasDecisions, recIds, out);
      continue;
    }
    // ideas, debt, chores: <slug>.md, optional <slug>/ attachments
    if (segs.length > 3) {
      const slug = segs[2];
      if (!repo.files.includes(`plan/${state}/${slug}.md`))
        once(`att:${state}/${slug}`, f, 1, `attachment folder plan/${state}/${slug}/ has no plan/${state}/${slug}.md`);
      continue;
    }
    if (segs[2] === ".gitkeep") continue;
    if (!segs[2].endsWith(".md")) {
      out.add(f, 1, `plan/${state}/ holds <slug>.md files (attachments in <slug>/)`);
      continue;
    }
    checkItem(repo, f, state, out);
  }
  for (const [num, folders] of milestones)
    if (folders.length > 1) for (const f of folders.slice(1)) out.add(f, 1, `milestone number ${num} is also used by ${folders[0]}`);

  // no counts in plan files
  for (const f of planFiles) {
    if (!f.endsWith(".md") || repo.ignored(f)) continue;
    const ls = lines(repo.read(f) ?? "");
    const fm = parseFrontmatter(ls);
    for (const pl of proseLines(ls, fm ? fm.end : 0)) {
      if (pl.ignore) continue;
      const { masked } = codeSpans(pl.text);
      const m =
        masked.match(/(?<![\w./-])\d{1,5}\s*\/\s*\d{1,5}(?![\w./-])/) ??
        masked.match(/\b\d+\s+of\s+\d+\s+(?:tasks?|features?|items?|steps?|checks?)\s+(?:are\s+)?(?:done|complete|completed|finished|merged)\b/i);
      if (m) out.add(f, pl.n, `holds a count ("${m[0].trim()}"); counts are derived, never kept (ls and rg ^status: are the views)`);
    }
  }
}

function needFields(path: string, fm: Frontmatter | null, keys: string[], out: Findings): boolean {
  if (!fm) {
    out.add(path, 1, `no YAML frontmatter (needs ${keys.join(", ")})`);
    return false;
  }
  for (const e of fm.errors) out.add(path, e.line, e.message);
  for (const k of keys) {
    const v = fm.data.get(k);
    if (v === undefined || v === null || (Array.isArray(v) && v.length === 0)) out.add(path, fm.lines.get(k) ?? 1, `frontmatter needs "${k}"`);
  }
  return true;
}

function checkTask(repo: Repo, f: string, id: string, state: string, hasDecisions: boolean, recIds: Set<string>, out: Findings) {
  const fm = parseFrontmatter(lines(repo.read(f) ?? ""));
  if (!needFields(f, fm, ["id", "status"], out) || !fm) return;
  const at = (k: string) => fm.lines.get(k) ?? 1;
  const fid = fm.data.get("id");
  if (typeof fid === "string" && fid !== id) out.add(f, at("id"), `id is ${fid}; the file name makes it ${id}`);
  const st = fm.data.get("status");
  if (st !== undefined && st !== null && (typeof st !== "string" || !TASK_STATUSES.includes(st)))
    out.add(f, at("status"), `status ${JSON.stringify(st)} is not one of ${TASK_STATUSES.join(" | ")}`);
  else if (state === "roadmap" && typeof st === "string" && st !== "planned")
    out.add(f, at("status"), `status is ${st}, but plan/roadmap/ holds only planned tasks (start the milestone first)`);
  for (const d of asList(fm.data.get("depends")))
    if (!/^\d{3}\.\d{2}$/.test(d)) out.add(f, at("depends"), `depends: ${d} is not a task id (NNN.NN)`);
  const v = fm.data.get("version");
  if (typeof v === "string" && !parseSemver(v.replace(/^(?:.+-)?v/, "")))
    out.add(f, at("version"), `version ${v} is not valid semver`);
  if (hasDecisions)
    for (const d of asList(fm.data.get("decisions")))
      if (!recIds.has(d)) out.add(f, at("decisions"), `decisions: ${d} has no record in docs/decisions/`);
}

function checkItem(repo: Repo, f: string, state: string, out: Findings) {
  const need = state === "ideas" ? ["title", "raised-by", "date"] : state === "debt" ? ["title", "where", "source", "date"] : ["title"];
  const fm = parseFrontmatter(lines(repo.read(f) ?? ""));
  if (!needFields(f, fm, need, out) || !fm) return;
  const date = fm.data.get("date");
  if (state !== "chores" && typeof date === "string" && !validDate(date)) out.add(f, fm.lines.get("date") ?? 1, "date is not YYYY-MM-DD");
  const c = fm.data.get("confidence");
  if (c !== undefined && c !== null && (typeof c !== "string" || !/^\d{1,3}$/.test(c) || +c > 100))
    out.add(f, fm.lines.get("confidence") ?? 1, "confidence is a whole number from 0 to 100");
}

function checkGitignore(repo: Repo, out: Findings) {
  const ok = repo.gitignore.some((l) => /^\/?\.claude\/worktrees\/?$/.test(l));
  if (!ok) out.add(".gitignore", 1, repo.read(".gitignore") === null ? "missing; it needs the line .claude/worktrees/" : "needs the line .claude/worktrees/");
}

const SUBSECTIONS = ["Added", "Changed", "Deprecated", "Removed", "Fixed", "Security"];

function checkChangelogs(repo: Repo, out: Findings) {
  const logs = repo.files.filter((f) => posix.basename(f) === "CHANGELOG.md" && !repo.ignored(f));
  if (!logs.length) return;
  const remote = git(repo.root, ["remote", "get-url", "origin"]);
  const url = remote.ok ? webUrl(remote.out) : null;
  const tags = url ? git(repo.root, ["tag", "--list"]).out.split(/\r?\n/).filter(Boolean) : [];
  for (const f of logs) checkChangelog(repo, f, url ? versionTags(tags, componentOf(f)) : null, out);
}

function checkChangelog(repo: Repo, f: string, tagged: Map<string, string> | null, out: Findings) {
  const ls = lines(repo.read(f) ?? "");
  const first = ls.findIndex((l) => l.trim() !== "");
  if (first < 0 || ls[first].trim() !== "# Changelog") out.add(f, first + 1, 'the first line must be "# Changelog"');
  let sections = 0;
  let unreleased = false;
  let sub = -1;
  const versions: { v: SemVer; line: number }[] = [];
  const defs = new Set<string>();
  let fence: string | null = null;
  ls.forEach((l, i) => {
    const n = i + 1;
    const fm = l.match(/^ {0,3}(`{3,}|~{3,})/);
    if (fence) {
      if (fm && fm[1][0] === fence[0] && fm[1].length >= fence.length) fence = null;
      return;
    }
    if (fm) {
      fence = fm[1];
      return;
    }
    const d = l.match(REFDEF_RE);
    if (d) defs.add(d[1].toLowerCase());
    if (/^#\s/.test(l) && i !== first) out.add(f, n, "only one level-1 heading (# Changelog)");
    else if (/^##\s/.test(l)) {
      sub = -1;
      if (l.trimEnd() === "## [Unreleased]") {
        if (unreleased) out.add(f, n, "a second [Unreleased] section");
        else if (sections > 0) out.add(f, n, "[Unreleased] must be the first section");
        unreleased = true;
      } else {
        if (sections === 0) out.add(f, n, "the first section must be ## [Unreleased]");
        const m = l.trimEnd().match(/^## \[([^\]]+)\] - (\S+)( \[YANKED\])?$/);
        if (!m) out.add(f, n, 'a release heading is "## [X.Y.Z] - YYYY-MM-DD"');
        else {
          const v = parseSemver(m[1]);
          if (!v) out.add(f, n, `${m[1]} is not valid semver (headings carry no v or component prefix)`);
          else versions.push({ v, line: n });
          if (!validDate(m[2])) out.add(f, n, `${m[2]} is not a YYYY-MM-DD date`);
        }
      }
      sections++;
    } else if (/^###\s/.test(l)) {
      const name = l.replace(/^###\s+/, "").trim();
      const idx = SUBSECTIONS.indexOf(name);
      if (sections === 0) out.add(f, n, "a subsection before any release section");
      if (idx < 0) out.add(f, n, `"${name}" is not a Keep a Changelog subsection (${SUBSECTIONS.join(", ")})`);
      else if (idx <= sub) out.add(f, n, `"${name}" is repeated or out of order (${SUBSECTIONS.join(", ")})`);
      else sub = idx;
    }
  });
  if (!unreleased) out.add(f, 1, "no ## [Unreleased] section");
  for (let k = 1; k < versions.length; k++)
    if (compareSemver(versions[k - 1].v, versions[k].v) <= 0)
      out.add(f, versions[k].line, `${versions[k].v.raw} is not lower than ${versions[k - 1].v.raw}; releases run newest first`);
  if (tagged) {
    for (const { v, line } of versions)
      if (tagged.has(v.raw) && !defs.has(v.raw.toLowerCase()))
        out.add(f, line, `no link reference [${v.raw}] at the bottom (run changelog-links)`);
    if (unreleased && tagged.size > 0 && !defs.has("unreleased"))
      out.add(f, ls.length, "no link reference [Unreleased] at the bottom (run changelog-links)");
  }
}

// ---------------------------------------------------------------- CLI

if (import.meta.main) {
  const args = Bun.argv.slice(2);
  let write = false;
  let rootArg: string | undefined;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--write") write = true;
    else if (args[i] === "--root" && args[i + 1]) rootArg = args[++i];
    else {
      console.error("usage: bun docs-check.ts [--write] [--root <repo dir>]");
      process.exit(2);
    }
  }
  const root = gitTopLevel(rootArg ?? process.cwd());
  if (!root) {
    console.error(`docs-check: ${rootArg ?? process.cwd()} is not inside a git repository`);
    process.exit(2);
  }
  const res = check(root, { write });
  for (const w of res.written) console.log(`wrote ${w}`);
  for (const f of res.findings) console.log(`${f.path}:${f.line}: ${f.message}`);
  for (const f of res.warnings) console.log(`${f.path}:${f.line}: warning: ${f.message}`);
  const w = res.warnings.length ? `, ${res.warnings.length} warning(s)` : "";
  console.error(res.findings.length ? `docs-check: ${res.findings.length} finding(s)${w}` : `docs-check: ok${w}`);
  process.exit(res.findings.length ? 1 : 0);
}
