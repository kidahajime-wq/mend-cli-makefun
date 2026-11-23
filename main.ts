// main.ts is mend, the CLI SPEC.md specifies, and this is the kit's starting point for it (MIT). It does sections 1 to 4, 9 and 10 of SPEC.md: the command line, the output and
// exit codes, safe paths, format detection, JSON edits and the all-or-nothing write. The other three formats are
// detected and then read as holding no edit, so they answer `error: parse 1`: reading unified diffs (section 6),
// SEARCH/REPLACE blocks (section 7) and V4A patches (section 8), and matching lines at three tiers (section 5), are
// yours to write. Node 22, the standard library alone; run it as `node main.ts [options] [PATCH]`.
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
  /** Moves recorded by move edits: [old, new]. */
  readonly moves: [string, string][] = [];
  move(from: string, to: string): void {
    this.moves.push([from, to]);
  }
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

// ------------------------------------------------------------ section 3
// A file's lines: its line break is CRLF when its first line feed follows
// a carriage return, else LF; its lines are its text split at that break.

function fileLines(text: string): { lines: string[]; br: string; final: boolean } {
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  if (text === '') return { lines: [], br, final: false };
  const lines = text.split(br);
  const final = text.endsWith(br);
  if (final) lines.pop();
  return { lines, br, final };
}

function joinFile(lines: string[], br: string, final: boolean): string {
  if (lines.length === 0) return '';
  return lines.join(br) + (final ? br : '');
}

// ------------------------------------------------------------ section 5
// Matching lines at three tiers: 0 exact, 1 trailing spaces/tabs removed,
// 2 leading and trailing spaces/tabs removed.

const tierKey = [
  (s: string): string => s,
  (s: string): string => s.replace(/[ \t]+$/, ''),
  (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, ''),
];

function leadingWs(s: string): string {
  const m = /^[ \t]*/.exec(s);
  return m === null ? '' : m[0];
}

function occurrences(lines: string[], old: string[], tier: number): number[] {
  const key = tierKey[tier]!;
  const want = old.map(key);
  const out: number[] = [];
  if (old.length === 0 || old.length > lines.length) return out;
  outer: for (let i = 0; i + old.length <= lines.length; i++) {
    for (let j = 0; j < old.length; j++) {
      if (key(lines[i + j]!) !== want[j]) continue outer;
    }
    out.push(i);
  }
  return out;
}

/** The first tier at which old occurs at least once, or null. */
function findTier(lines: string[], old: string[], strict: boolean): { tier: number; occs: number[] } | null {
  const max = strict ? 0 : 2;
  for (let t = 0; t <= max; t++) {
    const occs = occurrences(lines, old, t);
    if (occs.length > 0) return { tier: t, occs };
  }
  return null;
}

/** The first tier at which old occurs at or after `from`, or null. */
function findTierFrom(lines: string[], old: string[], from: number, strict: boolean): { tier: number; occs: number[] } | null {
  const max = strict ? 0 : 2;
  for (let t = 0; t <= max; t++) {
    const occs = occurrences(lines, old, t).filter((o) => o >= from);
    if (occs.length > 0) return { tier: t, occs };
  }
  return null;
}

/** One line of a replacement: a context line is written as the file's
 *  own matched line; any other line is written as the patch wrote it. */
type NewLine = { text: string; ctx: boolean; oPos: number };

function applyMatched(lines: string[], at: number, old: string[], n: NewLine[], tier: number): string[] {
  const out = lines.slice();
  const f = leadingWs(lines[at] ?? '');
  const p = leadingWs(old[0] ?? '');
  const rep = n.map((x) => {
    if (x.ctx) return lines[at + x.oPos]!;
    if (tier === 2 && x.text !== '' && !/^[ \t]*$/.test(x.text) && x.text.startsWith(p)) {
      return f + x.text.slice(p.length);
    }
    return x.text;
  });
  out.splice(at, old.length, ...rep);
  return out;
}

// ------------------------------------------------------------ section 6
// Unified diffs.

type BodyLine = { kind: ' ' | '-' | '+'; text: string; noEol?: boolean };
type Hunk = { a: number; body: BodyLine[] };
type Section = {
  old: string | null | undefined;
  nw: string | null | undefined;
  create: boolean;
  del: boolean;
  hunks: Hunk[];
  startLine: number;
};

/** The path after `--- ` or `+++ `: up to the first tab, surrounding
 *  spaces removed, one leading a/ or b/ removed. */
function headerPath(l: string): string {
  return l.slice(4).split('\t')[0]!.trim().replace(/^[ab]\//, '');
}

function lastCtxOrPlus(body: BodyLine[]): BodyLine | undefined {
  for (let i = body.length - 1; i >= 0; i--) {
    if (body[i]!.kind === ' ' || body[i]!.kind === '+') return body[i];
  }
  return undefined;
}

/** Apply a section's hunks in order to a file's text. */
function applyHunks(text: string, hunks: Hunk[], path: string, strict: boolean): string {
  let { lines, br, final } = fileLines(text);
  let d = 0;
  for (const h of hunks) {
    const o: string[] = [];
    const n: NewLine[] = [];
    let oPos = 0;
    for (const b of h.body) {
      if (b.kind === ' ') {
        o.push(b.text);
        n.push({ text: b.text, ctx: true, oPos });
        oPos += 1;
      } else if (b.kind === '-') {
        o.push(b.text);
        oPos += 1;
      } else {
        n.push({ text: b.text, ctx: false, oPos: -1 });
      }
    }
    if (o.length === 0) {
      const at = Math.min(lines.length, h.a + d);
      const rep = n.map((x) => x.text);
      const wasEnd = at === lines.length;
      lines.splice(at, 0, ...rep);
      if (wasEnd && rep.length > 0) {
        const last = lastCtxOrPlus(h.body);
        final = !(last !== undefined && last.noEol === true);
      }
      d += n.length;
      continue;
    }
    const found = findTier(lines, o, strict);
    if (found === null) throw new Fail('no-match', path);
    const want = h.a - 1 + d;
    let best = found.occs[0]!;
    let bestDist = Math.abs(best - want);
    for (const cand of found.occs.slice(1)) {
      const dist = Math.abs(cand - want);
      if (dist < bestDist) {
        best = cand;
        bestDist = dist;
      }
    }
    const touchesEnd = best + o.length === lines.length;
    lines = applyMatched(lines, best, o, n, found.tier);
    if (touchesEnd) {
      const last = lastCtxOrPlus(h.body);
      final = !(last !== undefined && last.noEol === true);
    }
    d += n.length - o.length;
  }
  return joinFile(lines, br, final);
}

function sectionEdit(sec: Section, strict: boolean): Edit {
  return (tree) => {
    const old = sec.old;
    const nw = sec.nw;
    for (const p of [old, nw]) {
      if (p !== undefined && p !== null && !safe(p)) throw new Fail('unsafe', p);
    }
    const isCreate = sec.create || old === null;
    const isDelete = sec.del || nw === null;
    if (isCreate) {
      const target = nw!;
      if (tree.get(target) !== null) throw new Fail('exists', target);
      const plus: string[] = [];
      let finalBreak = true;
      for (const h of sec.hunks) {
        for (const b of h.body) {
          if (b.kind === '+') {
            plus.push(b.text);
            finalBreak = b.noEol !== true;
          }
        }
      }
      tree.now.set(target, plus.length === 0 ? '' : plus.join('\n') + (finalBreak ? '\n' : ''));
      return;
    }
    if (isDelete) {
      const target = old!;
      if (tree.get(target) === null) throw new Fail('missing', target);
      tree.now.set(target, null);
      return;
    }
    const isMove = old !== nw;
    if (isMove) {
      if (tree.get(old!) === null) throw new Fail('missing', old!);
      if (tree.get(nw!) !== null) throw new Fail('exists', nw!);
      const after = applyHunks(tree.get(old!)!, sec.hunks, old!, strict);
      tree.now.set(nw!, after);
      tree.now.set(old!, null);
      tree.move(old!, nw!);
      return;
    }
    const target = old!;
    if (tree.get(target) === null) throw new Fail('missing', target);
    tree.now.set(target, applyHunks(tree.get(target)!, sec.hunks, target, strict));
  };
}

function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  const sections: Section[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    let sec: Section | null = null;
    if (line.startsWith('diff --git ')) {
      const m = /^diff --git a\/(\S+) b\/(\S+)$/.exec(line);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      sec = { old: m[1]!, nw: m[2]!, create: false, del: false, hunks: [], startLine: i + 1 };
      i += 1;
    } else if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      sec = { old: undefined, nw: undefined, create: false, del: false, hunks: [], startLine: i + 1 };
    } else {
      if (line.startsWith('@@')) throw new Exit2(`error: parse ${i + 1}`);
      i += 1;
      continue;
    }
    // Header: lines before the first hunk.
    let sawPair = false;
    let renameFrom: string | undefined;
    let renameTo: string | undefined;
    while (i < lines.length) {
      const l = lines[i]!;
      if (l.startsWith('@@')) break;
      if (l.startsWith('--- ')) {
        if ((lines[i + 1] ?? '').startsWith('+++ ')) {
          const op = headerPath(l);
          const np = headerPath(lines[i + 1]!);
          sec.old = op === '/dev/null' ? null : op;
          sec.nw = np === '/dev/null' ? null : np;
          sawPair = true;
          i += 2;
          continue;
        }
        throw new Exit2(`error: parse ${i + 2}`);
      }
      if (l.startsWith('rename from ')) {
        renameFrom = l.slice('rename from '.length).trim();
        i += 1;
        continue;
      }
      if (l.startsWith('rename to ')) {
        renameTo = l.slice('rename to '.length).trim();
        i += 1;
        continue;
      }
      if (l.startsWith('new file mode')) {
        sec.create = true;
        i += 1;
        continue;
      }
      if (l.startsWith('deleted file mode')) {
        sec.del = true;
        i += 1;
        continue;
      }
      i += 1;
    }
    if (!sawPair) {
      if (renameFrom !== undefined) sec.old = renameFrom;
      if (renameTo !== undefined) sec.nw = renameTo;
    }
    if (sec.old === undefined && sec.nw === undefined) throw new Exit2(`error: parse ${sec.startLine}`);
    if (sec.old === null && sec.nw === null) throw new Exit2(`error: parse ${sec.startLine}`);
    if (sec.old === undefined) sec.old = sec.nw;
    if (sec.nw === undefined) sec.nw = sec.old;
    if (sec.create && sec.nw === null) throw new Exit2(`error: parse ${sec.startLine}`);
    if (sec.del && sec.old === null) throw new Exit2(`error: parse ${sec.startLine}`);
    // Hunks.
    while (i < lines.length) {
      const l = lines[i]!;
      if (l.startsWith('@@')) {
        const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(l);
        if (m === null) throw new Exit2(`error: parse ${i + 1}`);
        const hunk: Hunk = { a: parseInt(m[1]!, 10), body: [] };
        i += 1;
        let j = i;
        while (j < lines.length) {
          const bl = lines[j]!;
          if (bl.startsWith('diff --git ')) break;
          if (bl.startsWith('--- ') && (lines[j + 1] ?? '').startsWith('+++ ')) break;
          if (bl === '' || bl.startsWith(' ') || bl.startsWith('-') || bl.startsWith('+')) {
            hunk.body.push({ kind: bl === '' ? ' ' : (bl[0] as ' ' | '-' | '+'), text: bl === '' ? '' : bl.slice(1) });
            j += 1;
            continue;
          }
          if (bl.startsWith('\\')) {
            const prev = hunk.body[hunk.body.length - 1];
            if (prev !== undefined) prev.noEol = true;
            j += 1;
            continue;
          }
          break;
        }
        while (hunk.body.length > 0) {
          const last = hunk.body[hunk.body.length - 1]!;
          if (last.kind === ' ' && last.text === '' && last.noEol !== true) hunk.body.pop();
          else break;
        }
        sec.hunks.push(hunk);
        i = j;
        continue;
      }
      if (l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ '))) break;
      i += 1;
    }
    sections.push(sec);
  }
  return sections.map((s) => sectionEdit(s, strict));
}

// ------------------------------------------------------------ section 7
// SEARCH/REPLACE blocks.

function srEdit(p: string, oldLines: string[], newLines: string[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(p)) throw new Fail('unsafe', p);
    if (oldLines.length === 0) {
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, newLines.length === 0 ? '' : newLines.join('\n') + '\n');
      return;
    }
    const before = tree.get(p);
    if (before === null) throw new Fail('missing', p);
    const { lines, br, final } = fileLines(before);
    const found = findTier(lines, oldLines, strict);
    if (found === null) throw new Fail('no-match', p);
    if (found.occs.length > 1) throw new Fail('ambiguous', p);
    const at = found.occs[0]!;
    const n: NewLine[] = newLines.map((t) => ({ text: t, ctx: false, oPos: -1 }));
    tree.now.set(p, joinFile(applyMatched(lines, at, oldLines, n, found.tier), br, final));
  };
}

function searchReplaceEdits(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevPath: string | null = null;
  let blockEnd = 0;
  let i = 0;
  while (i < lines.length) {
    const l = lines[i]!;
    if (l.trimEnd() !== '<<<<<<< SEARCH') {
      i += 1;
      continue;
    }
    const searchLine = i + 1;
    let p: string | null = null;
    for (let j = i - 1; j >= blockEnd; j--) {
      const c = lines[j]!;
      if (blank(c)) continue;
      if (c.trim().startsWith('```')) continue;
      p = c.trim();
      break;
    }
    if (p === null) p = prevPath;
    if (p === null) throw new Exit2(`error: parse ${searchLine}`);
    const oldLines: string[] = [];
    let j = i + 1;
    while (j < lines.length && lines[j]!.trimEnd() !== '=======') {
      oldLines.push(lines[j]!);
      j += 1;
    }
    if (j >= lines.length) throw new Exit2(`error: parse ${searchLine}`);
    j += 1;
    const newLines: string[] = [];
    while (j < lines.length && lines[j]!.trimEnd() !== '>>>>>>> REPLACE') {
      newLines.push(lines[j]!);
      j += 1;
    }
    if (j >= lines.length) throw new Exit2(`error: parse ${searchLine}`);
    blockEnd = j + 1;
    i = j + 1;
    prevPath = p;
    edits.push(srEdit(p, oldLines, newLines, strict));
  }
  return edits;
}

// ------------------------------------------------------------ section 8
// V4A patches.

type V4AChunk = { anchor: string | null; eof: boolean; body: BodyLine[] };

function isSectionStart(l: string): boolean {
  return l.startsWith('*** Add File:') || l.startsWith('*** Delete File:') || l.startsWith('*** Update File:');
}

function findAnchor(lines: string[], anchor: string, from: number, strict: boolean): number {
  const max = strict ? 0 : 2;
  for (let t = 0; t <= max; t++) {
    const key = tierKey[t]!;
    const want = key(anchor);
    for (let i = from; i < lines.length; i++) {
      if (key(lines[i]!) === want) return i;
    }
  }
  return -1;
}

function v4aUpdateEdit(p: string, moveTo: string | null, chunks: V4AChunk[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(p)) throw new Fail('unsafe', p);
    if (moveTo !== null && !safe(moveTo)) throw new Fail('unsafe', moveTo);
    const before = tree.get(p);
    if (before === null) throw new Fail('missing', p);
    if (moveTo !== null && tree.get(moveTo) !== null) throw new Fail('exists', moveTo);
    let { lines, br, final } = fileLines(before);
    let cursor = 0;
    for (const ch of chunks) {
      if (ch.anchor !== null) {
        const idx = findAnchor(lines, ch.anchor, cursor, strict);
        if (idx < 0) throw new Fail('no-match', p);
        cursor = idx + 1;
      }
      const o: string[] = [];
      const n: NewLine[] = [];
      let oPos = 0;
      for (const b of ch.body) {
        if (b.kind === ' ') {
          o.push(b.text);
          n.push({ text: b.text, ctx: true, oPos });
          oPos += 1;
        } else if (b.kind === '-') {
          o.push(b.text);
          oPos += 1;
        } else {
          n.push({ text: b.text, ctx: false, oPos: -1 });
        }
      }
      if (o.length === 0) {
        const at = ch.eof ? lines.length : cursor;
        lines.splice(at, 0, ...n.map((x) => x.text));
        cursor = at + n.length;
        continue;
      }
      const found = findTierFrom(lines, o, cursor, strict);
      if (found === null) throw new Fail('no-match', p);
      let at = found.occs[0]!;
      if (ch.eof) {
        const end = found.occs.find((pos) => pos + o.length === lines.length);
        if (end === undefined) throw new Fail('no-match', p);
        at = end;
      }
      lines = applyMatched(lines, at, o, n, found.tier);
      cursor = at + n.length;
    }
    const target = moveTo ?? p;
    tree.now.set(target, joinFile(lines, br, final));
    if (moveTo !== null) {
      tree.now.set(p, null);
      tree.move(p, moveTo);
    }
  };
}

function v4aEdits(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = lines.length - 1;
  while (last >= 0 && blank(lines[last]!)) last -= 1;
  if (last < 0 || lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const edits: Edit[] = [];
  let i = first + 1;
  while (i < last) {
    const l = lines[i]!;
    if (blank(l)) {
      i += 1;
      continue;
    }
    let m = /^\*\*\* Add File: (.*)$/.exec(l);
    if (m !== null) {
      const p = m[1]!.trim();
      const secLines: string[] = [];
      let j = i + 1;
      while (j < last && !isSectionStart(lines[j]!)) {
        secLines.push(lines[j]!);
        j += 1;
      }
      while (secLines.length > 0 && secLines[secLines.length - 1] === '') secLines.pop();
      for (let k = 0; k < secLines.length; k++) {
        const sl = secLines[k]!;
        if (sl !== '' && !sl.startsWith('+')) throw new Exit2(`error: parse ${i + 2 + k}`);
      }
      const content = secLines.map((s) => (s === '' ? '' : s.slice(1)));
      edits.push((tree) => {
        if (!safe(p)) throw new Fail('unsafe', p);
        if (tree.get(p) !== null) throw new Fail('exists', p);
        tree.now.set(p, content.length === 0 ? '' : content.join('\n') + '\n');
      });
      i = j;
      continue;
    }
    m = /^\*\*\* Delete File: (.*)$/.exec(l);
    if (m !== null) {
      const p = m[1]!.trim();
      let j = i + 1;
      while (j < last && !isSectionStart(lines[j]!)) {
        if (!blank(lines[j]!)) throw new Exit2(`error: parse ${j + 1}`);
        j += 1;
      }
      edits.push((tree) => {
        if (!safe(p)) throw new Fail('unsafe', p);
        if (tree.get(p) === null) throw new Fail('missing', p);
        tree.now.set(p, null);
      });
      i = j;
      continue;
    }
    m = /^\*\*\* Update File: (.*)$/.exec(l);
    if (m !== null) {
      const p = m[1]!.trim();
      const updateLine = i + 1;
      let j = i + 1;
      // The section ends at the next section start or *** End Patch; blank
      // lines at its end are not part of it. A blank line inside the section
      // is a body line (an empty context line), including one before the
      // first chunk, and one before *** End of File.
      let secEnd = j;
      while (secEnd < last && !isSectionStart(lines[secEnd]!)) secEnd += 1;
      while (secEnd > j && blank(lines[secEnd - 1]!)) secEnd -= 1;
      let moveTo: string | null = null;
      const mm = /^\*\*\* Move to: (.*)$/.exec(lines[j] ?? '');
      if (mm !== null) {
        moveTo = mm[1]!.trim();
        j += 1;
      }
      const chunks: V4AChunk[] = [];
      let cur: V4AChunk | null = null;
      let sawChunk = false;
      const flush = (): void => {
        if (cur !== null) {
          chunks.push(cur);
          cur = null;
        }
      };
      while (j < secEnd) {
        const cl = lines[j]!;
        if (isSectionStart(cl)) break;
        if (cl.startsWith('@@')) {
          flush();
          const anchorText = cl.slice(2).trim();
          cur = { anchor: anchorText === '' ? null : anchorText, eof: false, body: [] };
          sawChunk = true;
          j += 1;
          continue;
        }
        if (cl === '*** End of File') {
          if (cur === null) throw new Exit2(`error: parse ${j + 1}`);
          cur.eof = true;
          flush();
          j += 1;
          continue;
        }
        if (cl === '' || cl.startsWith(' ') || cl.startsWith('-') || cl.startsWith('+')) {
          if (cur === null) {
            if (sawChunk) throw new Exit2(`error: parse ${j + 1}`);
            cur = { anchor: null, eof: false, body: [] };
            sawChunk = true;
          }
          cur.body.push({ kind: cl === '' ? ' ' : (cl[0] as ' ' | '-' | '+'), text: cl === '' ? '' : cl.slice(1) });
          j += 1;
          continue;
        }
        throw new Exit2(`error: parse ${j + 1}`);
      }
      flush();
      if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${updateLine}`);
      edits.push(v4aUpdateEdit(p, moveTo, chunks, strict));
      i = j;
      continue;
    }
    throw new Exit2(`error: parse ${i + 1}`);
  }
  return edits;
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
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const cmp = (a: string, b: string): number => Buffer.compare(Buffer.from(a), Buffer.from(b));
  // A move prints one `R <old> -> <new>` line, sorting by <new>, when the
  // old path existed before and does not after, and the new path did not
  // exist before and does after; it replaces that pair's D and A lines.
  const moved = new Map<string, string>();
  const consumed = new Set<string>();
  for (const [from, to] of tree.moves) {
    const wasFrom = tree.original(from);
    const nowFrom = tree.get(from);
    const wasTo = tree.original(to);
    const nowTo = tree.get(to);
    if (wasFrom !== null && nowFrom === null && wasTo === null && nowTo !== null) {
      moved.set(to, from);
      consumed.add(from);
      consumed.add(to);
    }
  }
  const rows: { key: string; line: string }[] = [];
  for (const [to, from] of moved) rows.push({ key: to, line: `R ${from} -> ${to}` });
  for (const p of [...tree.now.keys()].sort(cmp)) {
    if (consumed.has(p)) continue;
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    rows.push({ key: p, line: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((a, b) => cmp(a.key, b.key));
  if (!check) {
    for (const p of [...tree.now.keys()].sort(cmp)) {
      const was = tree.original(p);
      const now = tree.now.get(p)!;
      if (was === now) continue;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  return { code: 0, out: [...rows.map((r) => r.line), `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
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
