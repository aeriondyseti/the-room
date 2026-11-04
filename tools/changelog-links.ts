#!/usr/bin/env bun
/**
 * changelog-links: writes or refreshes the Keep a Changelog link references at the
 * bottom of a CHANGELOG.md from the git tags and the `origin` remote.
 *
 *   bun changelog-links.ts [--root <repo dir>] [--changelog <path>] [--prefix <component>]
 *
 *   --changelog  the changelog, relative to the repo root (default CHANGELOG.md)
 *   --prefix     the component whose tags to use (`host` for host-vX.Y.Z); default:
 *                none for a root changelog, the folder's name for one in a folder
 *
 * [Unreleased]: <url>/compare/<latest tag>...HEAD
 * [X.Y.Z]:      <url>/compare/<previous tag>...<tag>    (the lowest: <url>/releases/tag/<tag>)
 * Only versions with both a heading and a tag get a link. Without a web `origin`
 * remote it changes nothing and says so. Self-contained: Bun and git only.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, posix } from "node:path";

function git(root: string, args: string[]) {
  const p = Bun.spawnSync(["git", "-C", root, ...args], { stdout: "pipe", stderr: "pipe" });
  return { ok: p.exitCode === 0, out: p.stdout.toString(), err: p.stderr.toString() };
}

/** The web URL of a remote (https://host/owner/repo), or null for a local path or unknown form. */
export function webUrl(remote: string): string | null {
  let r = remote.trim();
  let m: RegExpMatchArray | null;
  if ((m = r.match(/^[\w.-]+@([\w.-]+):(?!\/)(.+)$/))) r = `https://${m[1]}/${m[2]}`;
  else if ((m = r.match(/^(?:ssh|git\+ssh|git):\/\/(?:[^@/]+@)?([^/:]+)(?::\d+)?\/(.+)$/))) r = `https://${m[1]}/${m[2]}`;
  else if ((m = r.match(/^(https?):\/\/(?:[^@/]+@)?(.+)$/))) r = `${m[1]}://${m[2]}`;
  else return null;
  return r.replace(/\/+$/, "").replace(/\.git$/, "");
}

interface SemVer {
  major: number;
  minor: number;
  patch: number;
  pre: string[];
  raw: string;
}
const SEMVER_RE =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/;
function parseSemver(s: string): SemVer | null {
  const m = s.match(SEMVER_RE);
  return m ? { major: +m[1], minor: +m[2], patch: +m[3], pre: m[4] ? m[4].split(".") : [], raw: s } : null;
}
function compareSemver(a: SemVer, b: SemVer): number {
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

const REFDEF_RE = /^ {0,3}\[([^\]^][^\]]*)\]:\s*\S+/;

/**
 * The changelog text with its version link references replaced by fresh ones.
 * `tags` are all tag names in the repo; `prefix` is the component ("" for unprefixed vX.Y.Z).
 */
export function renderLinks(text: string, tags: string[], url: string, prefix: string) {
  const crlf = text.includes("\r\n");
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const head = prefix ? `${prefix}-v` : "v";
  const tagged = tags
    .filter((t) => t.startsWith(head))
    .map((t) => ({ tag: t, v: parseSemver(t.slice(head.length)) }))
    .filter((x): x is { tag: string; v: SemVer } => x.v !== null)
    .sort((a, b) => compareSemver(a.v, b.v));

  // headings, in file order, outside fenced code
  const headings: string[] = [];
  let unreleased = false;
  let fence: string | null = null;
  for (const l of lines) {
    const f = l.match(/^ {0,3}(`{3,}|~{3,})/);
    if (fence) {
      if (f && f[1][0] === fence[0] && f[1].length >= fence.length) fence = null;
      continue;
    }
    if (f) {
      fence = f[1];
      continue;
    }
    if (/^## \[Unreleased\]\s*$/.test(l)) unreleased = true;
    const m = l.match(/^## \[([^\]]+)\]/);
    if (m && m[1] !== "Unreleased" && parseSemver(m[1])) headings.push(m[1]);
  }

  const out: string[] = [];
  if (unreleased && tagged.length) out.push(`[Unreleased]: ${url}/compare/${tagged[tagged.length - 1].tag}...HEAD`);
  const untagged: string[] = [];
  for (const h of headings) {
    const i = tagged.findIndex((t) => t.v.raw === h);
    if (i < 0) {
      untagged.push(h);
      continue;
    }
    out.push(i === 0 ? `[${h}]: ${url}/releases/tag/${tagged[i].tag}` : `[${h}]: ${url}/compare/${tagged[i - 1].tag}...${tagged[i].tag}`);
  }

  // drop the old version and Unreleased references, keep every other line
  const kept = lines.filter((l) => {
    const d = l.match(REFDEF_RE);
    return !(d && (d[1].toLowerCase() === "unreleased" || parseSemver(d[1])));
  });
  while (kept.length && kept[kept.length - 1].trim() === "") kept.pop();
  let body = kept.join("\n") + "\n";
  if (out.length) body += "\n" + out.join("\n") + "\n";
  return { text: crlf ? body.replace(/\n/g, "\r\n") : body, links: out.length, untagged };
}

export interface RunResult {
  changed: boolean;
  message: string;
  error?: boolean;
}

export function run(root: string, changelog = "CHANGELOG.md", prefix?: string): RunResult {
  const dir = posix.dirname(changelog.replace(/\\/g, "/"));
  const component = (prefix ?? (dir === "." ? "" : posix.basename(dir))).replace(/-v$/, "").replace(/-$/, "");
  const path = join(root, changelog);
  if (!existsSync(path)) return { changed: false, message: `${changelog} does not exist`, error: true };
  const remote = git(root, ["remote", "get-url", "origin"]);
  const url = remote.ok ? webUrl(remote.out) : null;
  if (!url)
    return {
      changed: false,
      message: remote.ok
        ? `origin (${remote.out.trim()}) is not a web remote: nothing to link, ${changelog} unchanged`
        : `no origin remote: nothing to link, ${changelog} unchanged`,
    };
  const tags = git(root, ["tag", "--list"]).out.split(/\r?\n/).filter(Boolean);
  const old = readFileSync(path, "utf8");
  const r = renderLinks(old, tags, url, component);
  const note = r.untagged.length ? `; no ${component ? component + "-" : ""}v tag for ${r.untagged.join(", ")}, so no link` : "";
  if (r.text === old) return { changed: false, message: `${changelog} already up to date (${r.links} link references)${note}` };
  writeFileSync(path, r.text);
  return { changed: true, message: `wrote ${r.links} link references to ${changelog}${note}` };
}

if (import.meta.main) {
  const args = Bun.argv.slice(2);
  let root = process.cwd();
  let changelog: string | undefined;
  let prefix: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--root" && args[i + 1]) root = args[++i];
    else if (a === "--changelog" && args[i + 1]) changelog = args[++i];
    else if (a === "--prefix" && args[i + 1] !== undefined) prefix = args[++i];
    else {
      console.error("usage: bun changelog-links.ts [--root <repo dir>] [--changelog <path>] [--prefix <component>]");
      process.exit(2);
    }
  }
  const top = git(root, ["rev-parse", "--show-toplevel"]);
  if (!top.ok) {
    console.error(`changelog-links: ${root} is not inside a git repository`);
    process.exit(2);
  }
  const r = run(top.out.trim(), changelog, prefix);
  (r.error ? console.error : console.log)(`changelog-links: ${r.message}`);
  process.exit(r.error ? 1 : 0);
}
