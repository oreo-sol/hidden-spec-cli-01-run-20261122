// main.ts is mend, the CLI SPEC.md specifies. It does all ten sections of SPEC.md: the command line, the output and
// exit codes, safe paths, format detection, matching lines at three tiers (section 5), unified diffs (section 6),
// SEARCH/REPLACE blocks (section 7), V4A patches (section 8), JSON edits (section 9) and the all-or-nothing write
// (section 10). Node 22, the standard library alone; run it as `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over to runner.ts
// (the last lines below): keep that hand-over and runner.ts as they are, and write the CLI.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  /** Moves of files that existed before the patch: original path -> current path. Used to print `R` rows. */
  readonly moves = new Map<string, string>();
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
  /** Record that the file at `oldP` moved to `newP`. Only files that existed before the patch can be `R` rows. */
  recordMove(oldP: string, newP: string): void {
    for (const [orig, cur] of this.moves) {
      if (cur === oldP) {
        this.moves.set(orig, newP);
        return;
      }
    }
    if (this.original(oldP) !== null) this.moves.set(oldP, newP);
  }
}

type Edit = (tree: Tree) => void;

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

// ---------------------------------------------------------------------------
// Sections 3 and 5: files as lines, and matching lines at three tiers.
// ---------------------------------------------------------------------------

type Tier = 0 | 1 | 2;

/** A file split into lines (section 3): its break, its lines, and whether it ends with one. */
interface FileLines {
  lines: string[];
  br: '\r\n' | '\n';
  final: boolean;
}

function splitFile(text: string): FileLines {
  if (text === '') return { lines: [], br: '\n', final: false };
  const nl = text.indexOf('\n');
  const br: '\r\n' | '\n' = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const final = text.endsWith(br);
  if (final) parts.pop();
  return { lines: parts, br, final };
}

function joinFile(f: FileLines): string {
  if (f.lines.length === 0) return '';
  return f.lines.join(f.br) + (f.final ? f.br : '');
}

const trimEndWs = (s: string): string => s.replace(/[ \t]+$/, '');
const trimWs = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
const leadingWs = (s: string): string => {
  const m = /^[ \t]*/.exec(s);
  return m === null ? '' : m[0];
};

function lineEq(tier: Tier, a: string, b: string): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return trimEndWs(a) === trimEndWs(b);
  return trimWs(a) === trimWs(b);
}

/** 0-based positions where O occurs in `lines` at `tier`; occurrences may overlap. */
function occurrences(lines: string[], o: string[], tier: Tier): number[] {
  const out: number[] = [];
  if (o.length === 0 || o.length > lines.length) return out;
  for (let i = 0; i + o.length <= lines.length; i++) {
    let ok = true;
    for (let j = 0; j < o.length; j++) {
      if (!lineEq(tier, o[j]!, lines[i + j]!)) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

/** The first tier (0, then 1, then 2; only 0 with --strict) at which O occurs at least once. */
function findTier(lines: string[], o: string[], strict: boolean): { tier: Tier; occ: number[] } | null {
  const tiers: Tier[] = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const occ = occurrences(lines, o, t);
    if (occ.length > 0) return { tier: t, occ };
  }
  return null;
}

/** One line of N: a context line (written as the file's own matched line) or a fresh line. */
type NItem = { kind: 'ctx'; oIndex: number } | { kind: 'new'; text: string };

/** Section 5, tier 2: re-indent a fresh line of N from O's indent P to the file's indent F. */
function reindent(text: string, tier: Tier, p: string, f: string): string {
  if (tier !== 2) return text;
  if (text === '' || /^[ \t]+$/.test(text)) return text;
  if (text.startsWith(p)) return f + text.slice(p.length);
  return text;
}

/** Build N's lines at the match: context lines from the file, fresh lines re-indented at tier 2. */
function buildN(n: NItem[], fileLines: string[], pos: number, tier: Tier, p: string, f: string): string[] {
  return n.map((item) => (item.kind === 'ctx' ? fileLines[pos + item.oIndex]! : reindent(item.text, tier, p, f)));
}

// ---------------------------------------------------------------------------
// Section 6: unified diffs.
// ---------------------------------------------------------------------------

interface Hunk {
  a: number;
  o: string[];
  n: NItem[];
  /** A `\` line follows the hunk's last context or `+` line. */
  noeolLastCtxPlus: boolean;
  /** A `\` line follows the hunk's last `+` line. */
  noeolLastPlus: boolean;
}

interface USection {
  diffOld: string | null;
  diffNew: string | null;
  pairOld: string | null;
  pairNew: string | null;
  renameFrom: string | null;
  renameTo: string | null;
  newFile: boolean;
  deletedFile: boolean;
  hunks: Hunk[];
}

/** The path after `--- ` or `+++ `: up to the first tab, surrounding spaces removed, a/b/ prefix removed. */
function diffPath(line: string): string | null {
  let p = line.slice(4).split('\t')[0]!.trim();
  if (p === '/dev/null') return null;
  if (p.startsWith('a/') || p.startsWith('b/')) p = p.slice(2);
  return p;
}

type BodyLine = { kind: 'ctx' | 'old' | 'new' | 'bs'; text: string };

function parseHunk(lines: string[], start: number): { hunk: Hunk; next: number } {
  const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(lines[start]!);
  if (m === null) throw new Exit2(`error: parse ${start + 1}`);
  const a = parseInt(m[1]!, 10);
  const body: BodyLine[] = [];
  let j = start + 1;
  while (j < lines.length) {
    const l = lines[j]!;
    if (l.startsWith('diff --git ')) break;
    if (l.startsWith('--- ') && (lines[j + 1] ?? '').startsWith('+++ ')) break;
    if (l === '') {
      body.push({ kind: 'ctx', text: '' });
      j++;
      continue;
    }
    const c = l[0]!;
    if (c === ' ') {
      body.push({ kind: 'ctx', text: l.slice(1) });
      j++;
      continue;
    }
    if (c === '-') {
      body.push({ kind: 'old', text: l.slice(1) });
      j++;
      continue;
    }
    if (c === '+') {
      body.push({ kind: 'new', text: l.slice(1) });
      j++;
      continue;
    }
    if (c === '\\') {
      body.push({ kind: 'bs', text: l.slice(1) });
      j++;
      continue;
    }
    break;
  }
  // Empty lines at the end of a body are not part of it.
  while (body.length > 0 && body[body.length - 1]!.kind === 'ctx' && body[body.length - 1]!.text === '') body.pop();
  const o: string[] = [];
  const n: NItem[] = [];
  for (const b of body) {
    if (b.kind === 'ctx') {
      const idx = o.length;
      o.push(b.text);
      n.push({ kind: 'ctx', oIndex: idx });
    } else if (b.kind === 'old') {
      o.push(b.text);
    } else if (b.kind === 'new') {
      n.push({ kind: 'new', text: b.text });
    }
  }
  let noeolLastCtxPlus = false;
  let noeolLastPlus = false;
  for (let k = body.length - 1; k >= 0; k--) {
    if (body[k]!.kind === 'ctx' || body[k]!.kind === 'new') {
      noeolLastCtxPlus = body[k + 1] !== undefined && body[k + 1]!.kind === 'bs';
      break;
    }
  }
  for (let k = body.length - 1; k >= 0; k--) {
    if (body[k]!.kind === 'new') {
      noeolLastPlus = body[k + 1] !== undefined && body[k + 1]!.kind === 'bs';
      break;
    }
  }
  return { hunk: { a, o, n, noeolLastCtxPlus, noeolLastPlus }, next: j };
}

function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  const sections: USection[] = [];
  const fresh = (diffOld: string | null, diffNew: string | null): USection => ({
    diffOld,
    diffNew,
    pairOld: null,
    pairNew: null,
    renameFrom: null,
    renameTo: null,
    newFile: false,
    deletedFile: false,
    hunks: [],
  });
  let cur: USection | null = null;
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.startsWith('diff --git ')) {
      const m = /^diff --git a\/(\S+) b\/(\S+)$/.exec(line);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      cur = fresh(m[1]!, m[2]!);
      sections.push(cur);
      i++;
      continue;
    }
    if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      // A section starts here unless this pair is part of the current section's header.
      if (cur === null || cur.hunks.length > 0) {
        cur = fresh(null, null);
        sections.push(cur);
      }
      // Fall through: the header below consumes the pair.
    } else if (cur === null) {
      if (line.startsWith('@@')) throw new Exit2(`error: parse ${i + 1}`);
      i++;
      continue;
    }
    if (cur === null) {
      i++;
      continue;
    }
    if (cur.hunks.length === 0) {
      // Inside the section's header, before its first hunk.
      if (line.startsWith('@@')) {
        const h = parseHunk(lines, i);
        cur.hunks.push(h.hunk);
        i = h.next;
        continue;
      }
      if (line.startsWith('--- ')) {
        if ((lines[i + 1] ?? '').startsWith('+++ ')) {
          if (cur.pairOld === null && cur.pairNew === null) {
            cur.pairOld = diffPath(line);
            cur.pairNew = diffPath(lines[i + 1]!);
          }
          i += 2;
          continue;
        }
        throw new Exit2(`error: parse ${i + 2}`);
      }
      if (line.startsWith('rename from ')) {
        if (cur.renameFrom === null) cur.renameFrom = line.slice('rename from '.length).split('\t')[0]!.trim();
        i++;
        continue;
      }
      if (line.startsWith('rename to ')) {
        if (cur.renameTo === null) cur.renameTo = line.slice('rename to '.length).split('\t')[0]!.trim();
        i++;
        continue;
      }
      if (line === 'new file mode' || line.startsWith('new file mode ')) {
        cur.newFile = true;
        i++;
        continue;
      }
      if (line === 'deleted file mode' || line.startsWith('deleted file mode ')) {
        cur.deletedFile = true;
        i++;
        continue;
      }
      i++;
      continue;
    }
    // After the first hunk: more hunks, or prose.
    if (line.startsWith('@@')) {
      const h = parseHunk(lines, i);
      cur.hunks.push(h.hunk);
      i = h.next;
      continue;
    }
    i++;
  }
  return sections.map((s) => unifiedSectionEdit(s, strict));
}

/** Apply one hunk to the file's lines; d is the running length delta of this section's earlier hunks. */
function applyHunk(fl: FileLines, hunk: Hunk, d: number, strict: boolean, failPath: string): { fl: FileLines; d: number } {
  const lines = fl.lines;
  if (hunk.o.length === 0 && hunk.n.length === 0) {
    // A hunk that removes and adds nothing leaves the file (and its final break) untouched.
    return { fl, d };
  }
  if (hunk.o.length === 0) {
    const pos = Math.min(hunk.a + d, lines.length);
    const ins: string[] = [];
    for (const item of hunk.n) {
      if (item.kind === 'new') ins.push(item.text);
    }
    const out = [...lines.slice(0, pos), ...ins, ...lines.slice(pos)];
    let final = fl.final;
    if (pos === lines.length) final = !hunk.noeolLastPlus;
    return { fl: { lines: out, br: fl.br, final }, d: d + hunk.n.length };
  }
  const found = findTier(lines, hunk.o, strict);
  if (found === null) throw new Fail('no-match', failPath);
  const target = hunk.a - 1 + d;
  let pos = found.occ[0]!;
  let best = Math.abs(pos - target);
  for (const o of found.occ) {
    const dist = Math.abs(o - target);
    if (dist < best) {
      best = dist;
      pos = o;
    }
  }
  const p = leadingWs(hunk.o[0]!);
  const f = leadingWs(lines[pos]!);
  const repl = buildN(hunk.n, lines, pos, found.tier, p, f);
  const out = [...lines.slice(0, pos), ...repl, ...lines.slice(pos + hunk.o.length)];
  let final = fl.final;
  if (pos + hunk.o.length === lines.length) final = !hunk.noeolLastCtxPlus;
  return { fl: { lines: out, br: fl.br, final }, d: d + (hunk.n.length - hunk.o.length) };
}

function unifiedSectionEdit(s: USection, strict: boolean): Edit {
  let oldP: string | null;
  let newP: string | null;
  if (s.pairOld !== null || s.pairNew !== null) {
    oldP = s.pairOld;
    newP = s.pairNew;
  } else if (s.renameFrom !== null || s.renameTo !== null) {
    oldP = s.renameFrom;
    newP = s.renameTo;
  } else {
    oldP = s.diffOld;
    newP = s.diffNew;
  }
  const isCreate = s.newFile || oldP === null;
  const isDelete = !isCreate && (s.deletedFile || newP === null);
  const isMove = !isCreate && !isDelete && oldP !== null && newP !== null && oldP !== newP;
  if (isCreate) {
    const newPath = newP!;
    return (tree) => {
      if (!safe(newPath)) throw new Fail('unsafe', newPath);
      if (tree.get(newPath) !== null) throw new Fail('exists', newPath);
      const plus: string[] = [];
      for (const h of s.hunks) {
        for (const item of h.n) {
          if (item.kind === 'new') plus.push(item.text);
        }
      }
      let noeol = false;
      for (let k = s.hunks.length - 1; k >= 0; k--) {
        if (s.hunks[k]!.n.some((x) => x.kind === 'new')) {
          noeol = s.hunks[k]!.noeolLastPlus;
          break;
        }
      }
      tree.now.set(newPath, plus.length === 0 ? '' : plus.join('\n') + (noeol ? '' : '\n'));
    };
  }
  if (isDelete) {
    const oldPath = oldP!;
    return (tree) => {
      if (!safe(oldPath)) throw new Fail('unsafe', oldPath);
      if (tree.get(oldPath) === null) throw new Fail('missing', oldPath);
      tree.now.set(oldPath, null);
    };
  }
  if (isMove) {
    const oldPath = oldP!;
    const newPath = newP!;
    return (tree) => {
      if (!safe(oldPath)) throw new Fail('unsafe', oldPath);
      if (!safe(newPath)) throw new Fail('unsafe', newPath);
      const before = tree.get(oldPath);
      if (before === null) throw new Fail('missing', oldPath);
      if (tree.get(newPath) !== null) throw new Fail('exists', newPath);
      let fl = splitFile(before);
      let d = 0;
      for (const h of s.hunks) {
        const r = applyHunk(fl, h, d, strict, oldPath);
        fl = r.fl;
        d = r.d;
      }
      tree.now.set(oldPath, null);
      tree.now.set(newPath, joinFile(fl));
      tree.recordMove(oldPath, newPath);
    };
  }
  const path = oldP!;
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    const before = tree.get(path);
    if (before === null) throw new Fail('missing', path);
    let fl = splitFile(before);
    let d = 0;
    for (const h of s.hunks) {
      const r = applyHunk(fl, h, d, strict, path);
      fl = r.fl;
      d = r.d;
    }
    tree.now.set(path, joinFile(fl));
  };
}

// ---------------------------------------------------------------------------
// Section 7: SEARCH/REPLACE blocks.
// ---------------------------------------------------------------------------

function searchReplaceEdits(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevReplaceEnd = -1;
  let prevPath: string | null = null;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i++;
      continue;
    }
    const searchIdx = i;
    let path: string | null = null;
    for (let j = searchIdx - 1; j > prevReplaceEnd; j--) {
      const t = lines[j]!.trim();
      if (t === '' || t.startsWith('```')) continue;
      path = t;
      break;
    }
    if (path === null) {
      if (prevPath === null) throw new Exit2(`error: parse ${searchIdx + 1}`);
      path = prevPath;
    }
    let sep = -1;
    for (let j = searchIdx + 1; j < lines.length; j++) {
      if (lines[j]!.trimEnd() === '=======') {
        sep = j;
        break;
      }
    }
    if (sep === -1) throw new Exit2(`error: parse ${searchIdx + 1}`);
    let rep = -1;
    for (let j = sep + 1; j < lines.length; j++) {
      if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') {
        rep = j;
        break;
      }
    }
    if (rep === -1) throw new Exit2(`error: parse ${searchIdx + 1}`);
    const oldLines = lines.slice(searchIdx + 1, sep);
    const newLines = lines.slice(sep + 1, rep);
    edits.push(searchReplaceEdit(path, oldLines, newLines, strict));
    prevPath = path;
    prevReplaceEnd = rep;
    i = rep + 1;
  }
  return edits;
}

function searchReplaceEdit(path: string, oldLines: string[], newLines: string[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (oldLines.length === 0) {
      if (tree.get(path) !== null) throw new Fail('exists', path);
      tree.now.set(path, newLines.length === 0 ? '' : newLines.join('\n') + '\n');
      return;
    }
    const before = tree.get(path);
    if (before === null) throw new Fail('missing', path);
    const fl = splitFile(before);
    const found = findTier(fl.lines, oldLines, strict);
    if (found === null) throw new Fail('no-match', path);
    if (found.occ.length !== 1) throw new Fail('ambiguous', path);
    const pos = found.occ[0]!;
    const p = leadingWs(oldLines[0]!);
    const f = leadingWs(fl.lines[pos]!);
    const nItems: NItem[] = newLines.map((text) => ({ kind: 'new', text }) as NItem);
    const repl = buildN(nItems, fl.lines, pos, found.tier, p, f);
    const out = [...fl.lines.slice(0, pos), ...repl, ...fl.lines.slice(pos + oldLines.length)];
    tree.now.set(path, joinFile({ lines: out, br: fl.br, final: fl.final }));
  };
}

// ---------------------------------------------------------------------------
// Section 8: V4A patches.
// ---------------------------------------------------------------------------

interface VChunk {
  anchor: string | null;
  o: string[];
  n: NItem[];
  eof: boolean;
}

const isV4aSectionStart = (l: string): boolean =>
  l.startsWith('*** Add File: ') || l.startsWith('*** Delete File: ') || l.startsWith('*** Update File: ');

function v4aEdits(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = lines.length - 1;
  while (last >= 0 && blank(lines[last]!)) last--;
  if (last < 0 || lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const edits: Edit[] = [];
  let i = first + 1;
  while (i < last) {
    const line = lines[i]!;
    if (blank(line)) {
      i++;
      continue;
    }
    if (line.startsWith('*** Add File: ')) {
      const path = line.slice('*** Add File: '.length).trim();
      i++;
      const sec = collectV4aSection(lines, i, last);
      i = sec.next;
      const items = stripTrailingBlanks(sec.items);
      const fileLines: string[] = [];
      for (const it of items) {
        if (it.text === '') fileLines.push('');
        else if (it.text.startsWith('+')) fileLines.push(it.text.slice(1));
        else throw new Exit2(`error: parse ${it.idx + 1}`);
      }
      edits.push((tree) => {
        if (!safe(path)) throw new Fail('unsafe', path);
        if (tree.get(path) !== null) throw new Fail('exists', path);
        tree.now.set(path, fileLines.length === 0 ? '' : fileLines.join('\n') + '\n');
      });
      continue;
    }
    if (line.startsWith('*** Delete File: ')) {
      const path = line.slice('*** Delete File: '.length).trim();
      i++;
      const sec = collectV4aSection(lines, i, last);
      i = sec.next;
      const items = stripTrailingBlanks(sec.items);
      for (const it of items) {
        if (!blank(it.text)) throw new Exit2(`error: parse ${it.idx + 1}`);
      }
      edits.push((tree) => {
        if (!safe(path)) throw new Fail('unsafe', path);
        if (tree.get(path) === null) throw new Fail('missing', path);
        tree.now.set(path, null);
      });
      continue;
    }
    if (line.startsWith('*** Update File: ')) {
      const path = line.slice('*** Update File: '.length).trim();
      const updateIdx = i;
      i++;
      const sec = collectV4aSection(lines, i, last);
      i = sec.next;
      const items = stripTrailingBlanks(sec.items);
      edits.push(v4aUpdateEdit(path, items, strict, updateIdx));
      continue;
    }
    throw new Exit2(`error: parse ${i + 1}`);
  }
  return edits;
}

function collectV4aSection(
  lines: string[],
  start: number,
  end: number,
): { items: { idx: number; text: string }[]; next: number } {
  const items: { idx: number; text: string }[] = [];
  let i = start;
  while (i < end) {
    const l = lines[i]!;
    if (isV4aSectionStart(l)) break;
    items.push({ idx: i, text: l });
    i++;
  }
  return { items, next: i };
}

function stripTrailingBlanks(items: { idx: number; text: string }[]): { idx: number; text: string }[] {
  let n = items.length;
  while (n > 0 && blank(items[n - 1]!.text)) n--;
  return items.slice(0, n);
}

function v4aUpdateEdit(
  path: string,
  items: { idx: number; text: string }[],
  strict: boolean,
  updateIdx: number,
): Edit {
  let moveTo: string | null = null;
  let j = 0;
  if (items.length > 0 && items[0]!.text.startsWith('*** Move to: ')) {
    moveTo = items[0]!.text.slice('*** Move to: '.length).trim();
    j = 1;
  }
  const chunks: VChunk[] = [];
  let cur: VChunk | null = null;
  let firstChunk = true;
  const closeChunk = (): void => {
    if (cur !== null) {
      chunks.push(cur);
      cur = null;
    }
  };
  while (j < items.length) {
    const it = items[j]!;
    const t = it.text;
    if (t.startsWith('@@')) {
      closeChunk();
      const anchorText = t.slice(2).trim();
      cur = { anchor: anchorText === '' ? null : anchorText, o: [], n: [], eof: false };
      firstChunk = false;
      j++;
      continue;
    }
    if (t.trimEnd() === '*** End of File' && !t.startsWith(' ') && !t.startsWith('\t')) {
      if (cur === null) throw new Exit2(`error: parse ${it.idx + 1}`);
      cur.eof = true;
      closeChunk();
      firstChunk = false;
      j++;
      continue;
    }
    if (t === '' || t.startsWith(' ') || t.startsWith('-') || t.startsWith('+')) {
      if (cur === null) {
        if (!firstChunk) throw new Exit2(`error: parse ${it.idx + 1}`);
        cur = { anchor: null, o: [], n: [], eof: false };
        firstChunk = false;
      }
      if (t === '') {
        const idx = cur.o.length;
        cur.o.push('');
        cur.n.push({ kind: 'ctx', oIndex: idx });
      } else if (t.startsWith(' ')) {
        const idx = cur.o.length;
        cur.o.push(t.slice(1));
        cur.n.push({ kind: 'ctx', oIndex: idx });
      } else if (t.startsWith('-')) {
        cur.o.push(t.slice(1));
      } else {
        cur.n.push({ kind: 'new', text: t.slice(1) });
      }
      j++;
      continue;
    }
    throw new Exit2(`error: parse ${it.idx + 1}`);
  }
  closeChunk();
  if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${updateIdx + 1}`);
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (moveTo !== null && !safe(moveTo)) throw new Fail('unsafe', moveTo);
    const before = tree.get(path);
    if (before === null) throw new Fail('missing', path);
    if (moveTo !== null && tree.get(moveTo) !== null) throw new Fail('exists', moveTo);
    let fl = splitFile(before);
    let cursor = 0;
    for (const ch of chunks) {
      const r = applyV4aChunk(fl, ch, cursor, strict, path);
      fl = r.fl;
      cursor = r.cursor;
    }
    const text = joinFile(fl);
    if (moveTo !== null) {
      tree.now.set(path, null);
      tree.now.set(moveTo, text);
      tree.recordMove(path, moveTo);
    } else {
      tree.now.set(path, text);
    }
  };
}

/** Find the first line at or after `from` equal to `anchor` at the first tier where one is. */
function findAnchor(
  lines: string[],
  anchor: string,
  from: number,
  strict: boolean,
): { index: number } | null {
  const tiers: Tier[] = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    for (let i = from; i < lines.length; i++) {
      if (lineEq(t, anchor, lines[i]!)) return { index: i };
    }
  }
  return null;
}

function applyV4aChunk(
  fl: FileLines,
  ch: VChunk,
  cursor: number,
  strict: boolean,
  failPath: string,
): { fl: FileLines; cursor: number } {
  const lines = fl.lines;
  let cur = cursor;
  if (ch.anchor !== null) {
    const found = findAnchor(lines, ch.anchor, cur, strict);
    if (found === null) throw new Fail('no-match', failPath);
    cur = found.index + 1;
  }
  if (ch.o.length === 0) {
    const pos = ch.eof ? lines.length : cur;
    const ins = ch.n.map((item) => (item.kind === 'new' ? item.text : ''));
    const out = [...lines.slice(0, pos), ...ins, ...lines.slice(pos)];
    return { fl: { lines: out, br: fl.br, final: fl.final }, cursor: pos + ins.length };
  }
  const tiers: Tier[] = strict ? [0] : [0, 1, 2];
  let hit: { tier: Tier; pos: number } | null = null;
  for (const t of tiers) {
    const occ = occurrences(lines, ch.o, t).filter((p) => p >= cur && (!ch.eof || p + ch.o.length === lines.length));
    if (occ.length > 0) {
      hit = { tier: t, pos: occ[0]! };
      break;
    }
  }
  if (hit === null) throw new Fail('no-match', failPath);
  const p = leadingWs(ch.o[0]!);
  const f = leadingWs(lines[hit.pos]!);
  const repl = buildN(ch.n, lines, hit.pos, hit.tier, p, f);
  const out = [...lines.slice(0, hit.pos), ...repl, ...lines.slice(hit.pos + ch.o.length)];
  return { fl: { lines: out, br: fl.br, final: fl.final }, cursor: hit.pos + repl.length };
}

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    edits =
      kind === 'json'
        ? jsonEdits(text, lines)
        : kind === 'unified'
          ? unifiedEdits(lines, strict)
          : kind === 'search-replace'
            ? searchReplaceEdits(lines, strict)
            : v4aEdits(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const beforeMoves = new Map(tree.moves);
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      tree.moves.clear();
      for (const [k, v] of beforeMoves) tree.moves.set(k, v);
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const changed: { p: string; was: string | null; now: string | null }[] = [];
  for (const p of [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    changed.push({ p, was, now });
  }
  if (!check) {
    for (const { p, now } of changed) {
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  const rows: { key: string; line: string }[] = [];
  const rOld = new Set<string>();
  const rNew = new Set<string>();
  for (const [orig, cur] of tree.moves) {
    if (tree.original(orig) !== null && tree.get(orig) === null && tree.original(cur) === null && tree.get(cur) !== null) {
      rows.push({ key: cur, line: `R ${orig} -> ${cur}` });
      rOld.add(orig);
      rNew.add(cur);
    }
  }
  for (const { p, was, now } of changed) {
    if (rOld.has(p) || rNew.has(p)) continue;
    rows.push({ key: p, line: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  const out = rows.map((r) => r.line);
  return { code: 0, out: [...out, `ok: ${out.length} ${out.length === 1 ? 'file' : 'files'}`] };
}

const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
