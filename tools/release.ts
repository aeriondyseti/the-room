#!/usr/bin/env bun
/**
 * release: the one way a version is cut and tagged. Copied into each repo as tools/release.ts,
 * beside tools/changelog-links.ts, which it imports.
 *
 *   bun tools/release.ts [options]
 *
 * It refuses unless the working tree is clean, HEAD is on the trunk, and the full check passes at
 * HEAD (the commands under "The full check" in AGENTS.md, or --check). It reads the bump from the
 * subsections of CHANGELOG.md's [Unreleased] section:
 *
 *   The release has                          Before 1.0.0   1.0.0 and later
 *   Removed, or a line marked BREAKING       MINOR          MAJOR
 *   Added or Deprecated                      PATCH          MINOR
 *   Only Fixed, Security or other Changed    PATCH          PATCH
 *
 * Then it writes `## [X.Y.Z] - date` under [Unreleased], the version files it is told about, the
 * CHANGELOG link references (when origin is a web remote) and each --task file's `version:`;
 * commits `chore(release): vX.Y.Z` with trailers; and creates an annotated tag whose message is the
 * release's CHANGELOG section. It never pushes.
 *
 * Options:
 *   --dry-run               check and print the plan; write nothing and skip the full check
 *   --next                  print the next tag from [Unreleased] and exit (no checks, writes nothing)
 *   --check "<cmd>"         the full check, instead of AGENTS.md's (repeat for several commands)
 *   --version-file <path>   a file holding the version: *.json, *.toml, *.props/*.csproj/*.xml, VERSION or *.txt (repeat)
 *   --component <name>      release one component: tag <name>-vX.Y.Z, changelog <name>/CHANGELOG.md
 *   --changelog <path>      the changelog, relative to the root (default CHANGELOG.md, or <component>/CHANGELOG.md)
 *   --trunk <branch>        default: origin's HEAD, else main, else master
 *   --bump major|minor|patch  bump at least this much (never less than the changelog requires)
 *   --version X.Y.Z         an exact version (never less than the changelog requires)
 *   --date YYYY-MM-DD       default: today, local time
 *   --task <id>             adds a `Task:` trailer and sets that task file's `version:` (repeat)
 *   --agent <harness/label> adds an `Agent:` trailer
 *   --trailer "Key: value"  adds any other trailer, such as Co-Authored-By (repeat)
 *   --root <dir>            the repo (default: the git top level of the current directory)
 *
 * Self-contained: Bun, git and ./changelog-links.ts.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { renderLinks, webUrl } from "./changelog-links.ts";

// ---------------------------------------------------------------- versions

export interface Version {
  major: number;
  minor: number;
  patch: number;
  pre: string;
}
export type Bump = "major" | "minor" | "patch";
const ORDER: Bump[] = ["patch", "minor", "major"];

export function parseVersion(s: string): Version | null {
  const m = s.trim().match(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/);
  return m ? { major: +m[1], minor: +m[2], patch: +m[3], pre: m[4] ?? "" } : null;
}
export const formatVersion = (v: Version) => `${v.major}.${v.minor}.${v.patch}${v.pre ? `-${v.pre}` : ""}`;

/** Compares release versions; a pre-release sorts before its release. */
export function compareVersions(a: Version, b: Version): number {
  for (const k of ["major", "minor", "patch"] as const) if (a[k] !== b[k]) return a[k] < b[k] ? -1 : 1;
  if (a.pre === b.pre) return 0;
  if (!a.pre) return 1;
  if (!b.pre) return -1;
  return a.pre < b.pre ? -1 : 1;
}

export function bumpVersion(v: Version, bump: Bump): Version {
  if (bump === "major") return { major: v.major + 1, minor: 0, patch: 0, pre: "" };
  if (bump === "minor") return { major: v.major, minor: v.minor + 1, patch: 0, pre: "" };
  return { major: v.major, minor: v.minor, patch: v.patch + 1, pre: "" };
}

/** The design's bump rule, shifted down one place before 1.0.0. */
export function requiredBump(current: Version, kinds: Set<string>, breaking: boolean): Bump {
  const big = breaking || kinds.has("Removed");
  if (current.major === 0) return big ? "minor" : "patch";
  if (big) return "major";
  if (kinds.has("Added") || kinds.has("Deprecated")) return "minor";
  return "patch";
}

// ---------------------------------------------------------------- the changelog

export const KINDS = ["Added", "Changed", "Deprecated", "Removed", "Fixed", "Security"];

export interface Section {
  kind: string;
  lines: string[];
  /** true once a line outside an HTML comment holds text */
  content: boolean;
}

export interface Unreleased {
  /** the subsections with content, in file order */
  sections: Section[];
  kinds: Set<string>;
  breaking: boolean;
  /** HTML comments directly under the [Unreleased] heading; they stay there */
  comments: string[];
  /** index of the `## [Unreleased]` line, and of the first line after the section */
  start: number;
  end: number;
}

const isRefDef = (l: string) => /^ {0,3}\[[^\]^][^\]]*\]:\s*\S+/.test(l);
const isFence = (l: string) => /^ {0,3}(`{3,}|~{3,})/.test(l);

/** Tracks HTML comments line by line: whether a line is (part of) a comment. */
function commentTracker() {
  let open = false;
  return (l: string): boolean => {
    const at = l.indexOf("<!--");
    const inside = open || /^\s*<!--/.test(l);
    if (open) open = !l.includes("-->");
    else if (at >= 0) open = !l.slice(at + 4).includes("-->");
    return inside;
  };
}

/** Reads [Unreleased]; throws when it is missing, empty, or not in Keep a Changelog form. */
export function readUnreleased(lines: string[]): Unreleased {
  const start = lines.findIndex((l) => /^## \[Unreleased\]\s*$/i.test(l));
  if (start < 0) throw new Error('the changelog has no "## [Unreleased]" section');
  let end = start + 1;
  let fence = false;
  const scan = commentTracker();
  for (; end < lines.length; end++) {
    const l = lines[end];
    if (scan(l)) continue; // a heading inside a comment (an old template's example) is not a section
    if (isFence(l)) fence = !fence;
    if (!fence && (/^## /.test(l) || isRefDef(l))) break;
  }
  const sections: Section[] = [];
  const comments: string[] = [];
  let current: Section | null = null;
  let breaking = false;
  const inComment = commentTracker();
  for (const l of lines.slice(start + 1, end)) {
    if (inComment(l)) {
      (current ? current.lines : comments).push(l);
      continue;
    }
    if (!current && l.trim() === "") continue;
    const h = l.match(/^### (.+?)\s*$/);
    if (h) {
      if (!KINDS.includes(h[1]))
        throw new Error(`[Unreleased] has a "### ${h[1]}" subsection; Keep a Changelog allows only ${KINDS.join(", ")}`);
      current = { kind: h[1], lines: [], content: false };
      sections.push(current);
      continue;
    }
    if (!current) throw new Error(`[Unreleased] has text outside a subsection: "${l.trim()}"`);
    current.lines.push(l);
    if (l.trim() !== "") current.content = true;
    if (/\bBREAKING\b/.test(l)) breaking = true;
  }
  const filled = sections.filter((s) => s.content);
  if (!filled.length) throw new Error("[Unreleased] is empty: nothing to release");
  return { sections: filled, kinds: new Set(filled.map((s) => s.kind)), breaking, comments, start, end };
}

/** The highest version heading in the changelog, or null when it has none. */
export function latestHeading(lines: string[]): Version | null {
  let fence = false;
  let best: Version | null = null;
  const inComment = commentTracker();
  for (const l of lines) {
    if (inComment(l)) continue;
    if (isFence(l)) fence = !fence;
    if (fence) continue;
    const m = l.match(/^## \[([^\]]+)\]/);
    const v = m && !/^unreleased$/i.test(m[1]) ? parseVersion(m[1]) : null;
    if (v && (!best || compareVersions(v, best) > 0)) best = v;
  }
  return best;
}

/** The changelog with [Unreleased]'s subsections moved under `## [version] - date`. */
export function cutChangelog(lines: string[], u: Unreleased, version: string, date: string): string[] {
  const body: string[] = [];
  for (const s of u.sections) {
    while (s.lines.length && s.lines[s.lines.length - 1].trim() === "") s.lines.pop();
    if (body.length) body.push("");
    body.push(`### ${s.kind}`, ...s.lines);
  }
  const head = ["## [Unreleased]", ...(u.comments.length ? ["", ...u.comments] : []), "", `## [${version}] - ${date}`, ""];
  const rest = lines.slice(u.end);
  // a blank line before what follows; at the end of the file, the final newline
  return [...lines.slice(0, u.start), ...head, ...body, "", ...rest];
}

/** The release's CHANGELOG section, for the tag message. */
export function sectionText(u: Unreleased): string {
  return u.sections
    .map((s) => [`### ${s.kind}`, ...s.lines].join("\n").trim())
    .join("\n\n");
}

// ---------------------------------------------------------------- version files

/** The version a file holds, and the file's text with a new one. Throws for a type it doesn't know. */
export function versionInFile(path: string, text: string): { current: string; set: (v: string) => string } {
  const name = basename(path).toLowerCase();
  if (name.endsWith(".json")) {
    const re = /("version"\s*:\s*")([^"]*)(")/;
    const m = text.match(re);
    if (!m) throw new Error(`${path} has no "version" field`);
    const lock = name === "package-lock.json";
    return {
      current: m[2],
      set: (v) => {
        let n = 0;
        // package-lock.json holds the package's own version twice; dependencies follow
        return text.replace(new RegExp(re.source, "g"), (all, a: string, _old: string, b: string) =>
          n++ < (lock ? 2 : 1) ? `${a}${v}${b}` : all,
        );
      },
    };
  }
  if (name.endsWith(".toml")) {
    const lines = text.split("\n");
    let table = "";
    for (let i = 0; i < lines.length; i++) {
      const t = lines[i].match(/^\s*\[([^\]]+)\]\s*$/);
      if (t) table = t[1].trim();
      const m = lines[i].match(/^(\s*version\s*=\s*")([^"]*)(".*)$/);
      if (m && ["project", "package", "tool.poetry", "workspace.package"].includes(table))
        return {
          current: m[2],
          set: (v) => lines.map((l, j) => (j === i ? `${m[1]}${v}${m[3]}` : l)).join("\n"),
        };
    }
    throw new Error(`${path} has no version under [project], [package], [tool.poetry] or [workspace.package]`);
  }
  if (/\.(props|csproj|fsproj|vbproj|targets|xml)$/.test(name)) {
    const re = /(<Version>)([^<]*)(<\/Version>)/;
    const m = text.match(re);
    if (!m) throw new Error(`${path} has no <Version> element`);
    return { current: m[2].trim(), set: (v) => text.replace(re, `$1${v}$3`) };
  }
  if (name === "version" || name.endsWith(".txt")) {
    const m = text.match(/^(\s*)(\S+)(\s*)$/);
    if (!m) throw new Error(`${path} should hold only a version`);
    return { current: m[2], set: (v) => `${m[1]}${v}${m[3]}` };
  }
  throw new Error(`${path}: unknown version file type (use .json, .toml, .props/.csproj/.xml, VERSION or .txt)`);
}

// ---------------------------------------------------------------- task files

/**
 * The task file's text with `version:` set in its frontmatter. A component release appends to a list
 * (a task can touch several components); otherwise a different version already there is an error.
 */
export function setTaskVersion(text: string, value: string, appendList: boolean): string {
  const crlf = text.includes("\r\n");
  const lf = text.replace(/\r\n/g, "\n");
  const fm = lf.match(/^---\n([\s\S]*?)\n---/);
  if (!fm) throw new Error("has no frontmatter");
  const re = /^version:[ \t]*([^#\n]*?)[ \t]*(#.*)?$/m;
  const block = fm[1];
  const m = block.match(re);
  let next: string;
  if (!m) {
    next = `${block}\nversion: ${value}`;
  } else {
    const old = m[1].trim();
    const items = old.startsWith("[") ? old.slice(1, -1).split(",").map((s) => s.trim()).filter(Boolean) : old ? [old] : [];
    if (items.includes(value)) return text;
    if (items.length && !appendList) throw new Error(`already has version ${old}`);
    const val = items.length ? `[${[...items, value].join(", ")}]` : value;
    next = block.replace(re, () => `version: ${val}${m[2] ? `  ${m[2]}` : ""}`);
  }
  const out = lf.replace(block, () => next);
  return crlf ? out.replace(/\n/g, "\r\n") : out;
}

function findTaskFile(root: string, id: string): string | null {
  for (const state of ["milestones", "roadmap"]) {
    const dir = join(root, "plan", state);
    if (!existsSync(dir)) continue;
    for (const m of readdirSync(dir, { withFileTypes: true })) {
      if (!m.isDirectory()) continue;
      for (const f of readdirSync(join(dir, m.name)))
        if (f.startsWith(`${id}_`) && f.endsWith(".md")) return `plan/${state}/${m.name}/${f}`;
    }
  }
  return null;
}

// ---------------------------------------------------------------- the full check

/**
 * The full-check commands AGENTS.md names: the fenced block after a line starting "The full check",
 * or else a list or table line naming "full check" with a `command` in backticks. Null when none.
 */
export function fullCheckFrom(agents: string): string[] | null {
  const lines = agents.replace(/\r\n/g, "\n").split("\n");
  const at = lines.findIndex((l) => /^\s*(?:\*\*)?the full check\b/i.test(l));
  if (at >= 0) {
    let i = at + 1;
    while (i < lines.length && lines[i].trim() === "") i++;
    const open = lines[i]?.match(/^\s*(`{3,}|~{3,})/);
    if (open) {
      const cmds: string[] = [];
      for (i++; i < lines.length && !lines[i].trim().startsWith(open[1]); i++) {
        const c = lines[i].trim();
        if (c && !c.startsWith("#")) cmds.push(c);
      }
      if (cmds.length) return cmds;
    }
  }
  const inline = lines.filter((l) => /^\s*(?:[-*]|\|)[^`\n]*\bfull check\b[^`\n]*`[^`\n]+`/i.test(l));
  if (inline.length > 1) throw new Error("AGENTS.md names more than one full check line; pass --check");
  if (inline.length === 1) return [inline[0].match(/`([^`\n]+)`/)![1]];
  return null;
}

// ---------------------------------------------------------------- git

function git(root: string, args: string[]) {
  const p = Bun.spawnSync(["git", "-C", root, ...args], { stdout: "pipe", stderr: "pipe" });
  return { ok: p.exitCode === 0, out: p.stdout.toString().trim(), err: p.stderr.toString().trim() };
}
function gitOrThrow(root: string, args: string[]): string {
  const r = git(root, args);
  if (!r.ok) throw new Error(`git ${args.join(" ")} failed: ${r.err}`);
  return r.out;
}

function trunkOf(root: string): string {
  const head = git(root, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]);
  if (head.ok && head.out) return head.out.replace(/^origin\//, "");
  for (const b of ["main", "master"]) if (git(root, ["rev-parse", "-q", "--verify", `refs/heads/${b}`]).ok) return b;
  throw new Error("can't tell the trunk (no origin/HEAD, main or master); pass --trunk");
}

// ---------------------------------------------------------------- plan and apply

export interface Options {
  root: string;
  dryRun?: boolean;
  check?: string[];
  versionFiles?: string[];
  component?: string;
  changelog?: string;
  trunk?: string;
  bump?: Bump;
  version?: string;
  date?: string;
  tasks?: string[];
  agent?: string;
  trailers?: string[];
}

export interface Edit {
  path: string;
  before: string;
  after: string;
}

export interface Plan {
  root: string;
  current: string;
  version: string;
  tag: string;
  bump: Bump;
  reason: string;
  trunk: string;
  edits: Edit[];
  check: string[];
  message: string;
  tagMessage: string;
  notes: string[];
}

export function localDate(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function changelogPath(o: Options) {
  return (o.changelog ?? (o.component ? `${o.component}/CHANGELOG.md` : "CHANGELOG.md")).replace(/\\/g, "/");
}

/** The next version from the changelog and tags alone, with the reason; checks nothing else. */
export function nextVersion(o: Options) {
  const path = changelogPath(o);
  const full = join(o.root, path);
  if (!existsSync(full)) throw new Error(`${path} does not exist${o.component ? "; pass --changelog" : ""}`);
  const text = readFileSync(full, "utf8");
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const u = readUnreleased(lines);

  const prefix = o.component ? `${o.component}-v` : "v";
  const tags = git(o.root, ["tag", "--list", `${prefix}*`]).out.split(/\r?\n/).filter(Boolean);
  const tagged = tags
    .map((t) => ({ t, v: t.startsWith(prefix) ? parseVersion(t.slice(prefix.length)) : null }))
    .filter((x): x is { t: string; v: Version } => x.v !== null)
    .sort((a, b) => compareVersions(a.v, b.v));
  const lastTag = tagged.length ? tagged[tagged.length - 1].v : null;
  const heading = latestHeading(lines);
  const notes: string[] = [];
  // A repo that cut over may have tags from before its changelog: the higher of the two is the last release.
  let current: Version = heading ?? lastTag ?? { major: 0, minor: 0, patch: 0, pre: "" };
  if (lastTag && heading && compareVersions(lastTag, heading) > 0) current = lastTag;
  if (lastTag && (!heading || compareVersions(lastTag, heading) > 0))
    notes.push(`the last release, tag ${prefix}${formatVersion(lastTag)}, has no section in ${path}`);
  const released = heading !== null || lastTag !== null;
  if (current.pre && !o.version)
    throw new Error(`the latest release, ${formatVersion(current)}, is a pre-release; pass --version`);

  const required = requiredBump(current, u.kinds, u.breaking);
  const reason =
    `${[...u.kinds].join(", ")}${u.breaking ? " (BREAKING)" : ""} ` +
    `${current.major === 0 ? "before" : "from"} 1.0.0 needs ${required.toUpperCase()}`;
  const floor = bumpVersion(current, required);
  let bump = required;
  let next = floor;
  if (o.bump) {
    if (ORDER.indexOf(o.bump) < ORDER.indexOf(required))
      throw new Error(`--bump ${o.bump} is less than the changelog requires: ${reason}`);
    bump = o.bump;
    next = bumpVersion(current, o.bump);
  }
  if (o.version) {
    const v = parseVersion(o.version);
    if (!v) throw new Error(`--version ${o.version} is not X.Y.Z`);
    if (compareVersions(v, floor) < 0)
      throw new Error(`--version ${o.version} is less than ${formatVersion(floor)}, which the changelog requires: ${reason}`);
    next = v;
  }
  return { path, text, lines, u, current, released, next, bump, reason, prefix, notes };
}

/** Every check that needs no running, and every edit, computed; nothing is written. */
export function planRelease(o: Options): Plan {
  const root = o.root;
  const notes: string[] = [];
  if (git(root, ["status", "--porcelain"]).out !== "")
    throw new Error("the working tree has changes; commit them first");
  const trunk = o.trunk ?? trunkOf(root);
  const branch = gitOrThrow(root, ["rev-parse", "--abbrev-ref", "HEAD"]);
  if (branch !== trunk) throw new Error(`HEAD is on ${branch}, not the trunk (${trunk})`);

  const n = nextVersion(o);
  notes.push(...n.notes);
  const version = formatVersion(n.next);
  const tag = `${n.prefix}${version}`;
  if (git(root, ["rev-parse", "-q", "--verify", `refs/tags/${tag}`]).ok) throw new Error(`tag ${tag} already exists`);

  let check = o.check?.length ? o.check : null;
  if (!check) {
    const agents = join(root, "AGENTS.md");
    check = existsSync(agents) ? fullCheckFrom(readFileSync(agents, "utf8")) : null;
    if (!check) throw new Error('AGENTS.md names no full check (a fenced block after "The full check"); pass --check');
  }
  const unfilled = check.find((c) => /<[^>]+>/.test(c));
  if (unfilled) throw new Error(`the full check still has a placeholder: ${unfilled}`);

  const edits: Edit[] = [];
  const date = o.date ?? localDate();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error(`--date ${date} is not YYYY-MM-DD`);

  // the changelog: heading, then link references with the new tag included
  const crlf = n.text.includes("\r\n");
  let cut = cutChangelog(n.lines, n.u, version, date).join("\n");
  const remote = git(root, ["remote", "get-url", "origin"]);
  const url = remote.ok ? webUrl(remote.out) : null;
  if (url) {
    const tags = git(root, ["tag", "--list"]).out.split(/\r?\n/).filter(Boolean);
    cut = renderLinks(cut, [...tags, tag], url, o.component ?? "").text;
  } else notes.push(`no web origin remote: ${n.path} gets no link references`);
  edits.push({ path: n.path, before: n.text, after: crlf ? cut.replace(/\r?\n/g, "\r\n") : cut });

  // version files must hold the last release's version, so the tag always equals the file
  for (const f of o.versionFiles ?? []) {
    const path = f.replace(/\\/g, "/");
    const full = join(root, path);
    if (!existsSync(full)) throw new Error(`version file ${path} does not exist`);
    const before = readFileSync(full, "utf8");
    const vf = versionInFile(path, before);
    if (n.released && vf.current !== formatVersion(n.current))
      throw new Error(`${path} holds ${vf.current}, but the last release is ${formatVersion(n.current)}; fix it first`);
    edits.push({ path, before, after: vf.set(version) });
  }

  for (const id of o.tasks ?? []) {
    const path = findTaskFile(root, id);
    if (!path) {
      notes.push(`no task file for ${id} under plan/; its version is not recorded there`);
      continue;
    }
    const before = readFileSync(join(root, path), "utf8");
    try {
      const after = setTaskVersion(before, o.component ? tag : version, !!o.component);
      if (after !== before) edits.push({ path, before, after });
    } catch (e) {
      throw new Error(`${path} ${(e as Error).message}`);
    }
  }

  const trailers = [
    ...(o.tasks ?? []).map((t) => `Task: ${t}`),
    ...(o.agent ? [`Agent: ${o.agent}`] : []),
    ...(o.trailers ?? []),
  ];
  for (const t of trailers) if (!/^[A-Za-z][A-Za-z0-9-]*: \S/.test(t)) throw new Error(`"${t}" is not a "Key: value" trailer`);
  const message = `chore(release): ${tag}` + (trailers.length ? `\n\n${trailers.join("\n")}` : "");
  const tagMessage = `${tag}\n\n${sectionText(n.u)}\n`;
  return {
    root,
    current: n.released ? formatVersion(n.current) : "none",
    version,
    tag,
    bump: n.bump,
    reason: n.reason,
    trunk,
    edits,
    check,
    message,
    tagMessage,
    notes,
  };
}

/** Runs each full-check command in a shell at the root; throws on the first failure. */
export function runCheck(root: string, check: string[], quiet = false) {
  for (const cmd of check) {
    if (!quiet) console.log(`release: full check: ${cmd}`);
    const p = spawnSync(cmd, { cwd: root, shell: true, stdio: quiet ? "pipe" : "inherit" });
    if (p.status !== 0) throw new Error(`the full check failed at HEAD: \`${cmd}\` exited ${p.status ?? p.signal}`);
  }
  const dirty = git(root, ["status", "--porcelain"]).out;
  if (dirty) throw new Error(`the full check changed the working tree, so HEAD is not what was checked:\n${dirty}`);
}

/** Writes the edits, commits and tags. Returns the release commit. */
export function applyRelease(plan: Plan): string {
  for (const e of plan.edits) writeFileSync(join(plan.root, e.path), e.after);
  gitOrThrow(plan.root, ["add", "--", ...plan.edits.map((e) => e.path)]);
  gitOrThrow(plan.root, ["commit", "-q", "-m", plan.message]);
  // whitespace cleanup: the default would strip the "### Fixed" lines as comments
  gitOrThrow(plan.root, ["tag", "-a", "--cleanup=whitespace", plan.tag, "-m", plan.tagMessage]);
  return gitOrThrow(plan.root, ["rev-parse", "--short", "HEAD"]);
}

export function describePlan(plan: Plan): string {
  const lines = [
    `release ${plan.tag} on ${plan.trunk} (last release: ${plan.current}; ${plan.bump.toUpperCase()}: ${plan.reason})`,
  ];
  for (const e of plan.edits) {
    const a = e.before.split("\n");
    const changed = e.after.split("\n").filter((l, i) => l !== a[i]).length;
    lines.push(`  edit ${e.path} (${changed} line${changed === 1 ? "" : "s"})`);
  }
  lines.push(`  full check: ${plan.check.join(" && ")}`);
  lines.push(`  commit: ${plan.message.split("\n").join(" | ")}`);
  lines.push(`  annotated tag ${plan.tag}; nothing is pushed`);
  for (const n of plan.notes) lines.push(`  note: ${n}`);
  return lines.join("\n");
}

// ---------------------------------------------------------------- command line

const USAGE =
  "usage: bun tools/release.ts [--dry-run | --next] [--check <cmd>]... [--version-file <path>]... " +
  "[--component <name>] [--changelog <path>] [--trunk <branch>] [--bump major|minor|patch] [--version X.Y.Z] " +
  "[--date YYYY-MM-DD] [--task <id>]... [--agent <harness/label>] [--trailer <Key: value>]... [--root <dir>]";

export function parseArgs(argv: string[], cwd: string): Options & { next?: boolean } {
  const o: Options & { next?: boolean } = { root: cwd };
  const value = (i: number) => {
    if (argv[i + 1] === undefined) throw new Error(`${argv[i]} needs a value\n${USAGE}`);
    return argv[i + 1];
  };
  const list = (k: "check" | "versionFiles" | "tasks" | "trailers", v: string) => ((o[k] ??= []).push(v), 1);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dry-run") o.dryRun = true;
    else if (a === "--next") o.next = true;
    else if (a === "--check") i += list("check", value(i));
    else if (a === "--version-file") i += list("versionFiles", value(i));
    else if (a === "--task") i += list("tasks", value(i));
    else if (a === "--trailer") i += list("trailers", value(i));
    else if (a === "--component") (o.component = value(i)), i++;
    else if (a === "--changelog") (o.changelog = value(i)), i++;
    else if (a === "--trunk") (o.trunk = value(i)), i++;
    else if (a === "--version") (o.version = value(i)), i++;
    else if (a === "--date") (o.date = value(i)), i++;
    else if (a === "--agent") (o.agent = value(i)), i++;
    else if (a === "--root") (o.root = value(i)), i++;
    else if (a === "--bump") {
      const b = value(i);
      if (!ORDER.includes(b as Bump)) throw new Error(`--bump takes major, minor or patch\n${USAGE}`);
      o.bump = b as Bump;
      i++;
    } else throw new Error(`unknown argument ${a}\n${USAGE}`);
  }
  return o;
}

if (import.meta.main) {
  try {
    const o = parseArgs(Bun.argv.slice(2), process.cwd());
    const top = git(o.root, ["rev-parse", "--show-toplevel"]);
    if (!top.ok) throw new Error(`${o.root} is not inside a git repository`);
    o.root = top.out;
    if (o.next) {
      const n = nextVersion(o);
      console.log(`${n.prefix}${formatVersion(n.next)}`);
      process.exit(0);
    }
    const plan = planRelease(o);
    console.log(describePlan(plan));
    if (o.dryRun) {
      console.log("release: dry run; the full check was not run and nothing was written");
      process.exit(0);
    }
    runCheck(plan.root, plan.check);
    const sha = applyRelease(plan);
    console.log(`release: committed ${sha} and tagged ${plan.tag}. Nothing was pushed; Kevin pushes with git push --follow-tags.`);
  } catch (e) {
    console.error(`release: refused: ${(e as Error).message}`);
    process.exit(1);
  }
}
