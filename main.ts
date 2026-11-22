// mend: one patch tool for every AI edit format, as SPEC.md specifies.
// It applies unified diffs (section 6), SEARCH/REPLACE blocks (section 7),
// V4A patches (section 8) and text-editor JSON tool calls (section 9) to a
// tree of text files, atomically (section 10): every file changes or none
// does. Old lines match at three tiers (section 5): exact, trailing
// whitespace ignored, then leading and trailing whitespace ignored, with
// --strict holding it to exact matches only. Node 22, standard library
// alone; run it as `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set,
// and then this file hands over to runner.ts (the last lines below): keep
// that hand-over and runner.ts as they are, and write the CLI.

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
  /** Move chains, origin path -> current path, for R output lines. */
  readonly moves = new Map<string, string>();
  noteMove(oldP: string, newP: string): void {
    for (const [o, cur] of [...this.moves.entries()]) {
      if (cur === oldP) {
        this.moves.set(o, newP);
        return;
      }
    }
    this.moves.set(oldP, newP);
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

/** A file's lines, its line break, and whether it ends with one (SPEC section 3). */
interface FileState {
  lines: string[];
  br: '\r\n' | '\n';
  finalBreak: boolean;
}

function splitFile(text: string): FileState {
  if (text === '') return { lines: [], br: '\n', finalBreak: false };
  const nl = text.indexOf('\n');
  const br: '\r\n' | '\n' = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const finalBreak = text.endsWith(br);
  if (finalBreak) parts.pop();
  return { lines: parts, br, finalBreak };
}

function joinFile(s: FileState): string {
  if (s.lines.length === 0) return '';
  return s.lines.join(s.br) + (s.finalBreak ? s.br : '');
}

function leadingOf(line: string): string {
  const m = /^[ \t]*/.exec(line);
  return m ? m[0] : '';
}

function normLine(line: string, tier: number): string {
  if (tier === 0) return line;
  if (tier === 1) return line.replace(/[ \t]+$/, '');
  return line.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
}

function occurrencesAt(lines: string[], o: string[], tier: number, from: number): number[] {
  const out: number[] = [];
  if (o.length === 0) return out;
  for (let i = from; i + o.length <= lines.length; i++) {
    let ok = true;
    for (let j = 0; j < o.length; j++) {
      if (normLine(lines[i + j]!, tier) !== normLine(o[j]!, tier)) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

function findTier(lines: string[], o: string[], from: number, strict: boolean): { tier: number; occ: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const occ = occurrencesAt(lines, o, t, from);
    if (occ.length > 0) return { tier: t, occ };
  }
  return null;
}

interface NLine {
  text: string;
  ctx: boolean;
  oIdx: number;
}

/** Turn N lines into the lines to write (SPEC section 5). Context lines are the file's own matched lines. */
function transformN(n: NLine[], fileLines: string[], pos: number, o: string[], tier: number): string[] {
  if (tier !== 2) {
    return n.map((x) => (x.ctx ? fileLines[pos + x.oIdx]! : x.text));
  }
  const p = o.length > 0 ? leadingOf(o[0]!) : '';
  const f = fileLines.length > pos ? leadingOf(fileLines[pos]!) : '';
  return n.map((x) => {
    if (x.ctx) return fileLines[pos + x.oIdx]!;
    if (/^[ \t]*$/.test(x.text)) return x.text;
    if (x.text.startsWith(p)) return f + x.text.slice(p.length);
    return x.text;
  });
}

function stripAB(p: string): string {
  if (p.startsWith('a/') || p.startsWith('b/')) return p.slice(2);
  return p;
}

/** Unified diff (SPEC section 6). */
interface UBody {
  kind: 'ctx' | 'old' | 'new' | 'bs';
  text: string;
}
interface UHunk {
  a: number;
  body: UBody[];
}
interface USection {
  oldPath: string | null;
  newPath: string | null;
  create: boolean;
  del: boolean;
  hunks: UHunk[];
}

function headerPath(line: string): string {
  const rest = line.slice(4);
  const tab = rest.indexOf('\t');
  return (tab >= 0 ? rest.slice(0, tab) : rest).trim();
}

function applyUnifiedHunk(state: FileState, h: UHunk, d: number, strict: boolean, path: string): { state: FileState; delta: number } {
  const o: string[] = [];
  const n: NLine[] = [];
  let oIdx = 0;
  let lastCtxPlus = -1;
  for (let k = 0; k < h.body.length; k++) {
    if (h.body[k]!.kind === 'ctx' || h.body[k]!.kind === 'new') lastCtxPlus = k;
  }
  const noEolNew = lastCtxPlus >= 0 && h.body[lastCtxPlus + 1] !== undefined && h.body[lastCtxPlus + 1]!.kind === 'bs';
  for (const b of h.body) {
    if (b.kind === 'ctx') {
      o.push(b.text);
      n.push({ text: b.text, ctx: true, oIdx });
      oIdx++;
    } else if (b.kind === 'old') {
      o.push(b.text);
      oIdx++;
    } else if (b.kind === 'new') {
      n.push({ text: b.text, ctx: false, oIdx: -1 });
    }
  }
  const lines = [...state.lines];
  let finalBreak = state.finalBreak;
  if (o.length === 0) {
    const insertPos = Math.min(Math.max(h.a + d, 0), lines.length);
    const atEnd = insertPos === lines.length;
    const newLines = n.map((x) => x.text);
    lines.splice(insertPos, 0, ...newLines);
    if (atEnd && newLines.length > 0) finalBreak = !noEolNew;
    return { state: { lines, br: state.br, finalBreak }, delta: n.length };
  }
  const found = findTier(lines, o, 0, strict);
  if (found === null) throw new Fail('no-match', path);
  const target = h.a - 1 + d;
  let best = found.occ[0]!;
  let bestDist = Math.abs(best - target);
  for (const p of found.occ) {
    const dist = Math.abs(p - target);
    if (dist < bestDist) {
      best = p;
      bestDist = dist;
    }
  }
  const pos = best;
  const matchedToEnd = pos + o.length === lines.length;
  const newLines = transformN(n, lines, pos, o, found.tier);
  lines.splice(pos, o.length, ...newLines);
  if (matchedToEnd) finalBreak = !noEolNew;
  return { state: { lines, br: state.br, finalBreak }, delta: n.length - o.length };
}

function unifiedSectionEdit(s: USection, strict: boolean): Edit {
  return (tree) => {
    const oldP = s.oldPath;
    const newP = s.newPath;
    const isCreate = s.create || oldP === null;
    const isDel = s.del || newP === null;
    if (oldP !== null && !safe(oldP)) throw new Fail('unsafe', oldP);
    if (newP !== null && !safe(newP)) throw new Fail('unsafe', newP);
    if (isCreate) {
      if (newP === null) throw new Fail('unsafe', '');
      if (tree.get(newP) !== null) throw new Fail('exists', newP);
      const plus: string[] = [];
      for (const h of s.hunks) {
        for (const b of h.body) if (b.kind === 'new') plus.push(b.text);
      }
      let noEol = false;
      outer: for (let hi = s.hunks.length - 1; hi >= 0; hi--) {
        const h = s.hunks[hi]!;
        for (let k = h.body.length - 1; k >= 0; k--) {
          if (h.body[k]!.kind === 'new') {
            noEol = h.body[k + 1] !== undefined && h.body[k + 1]!.kind === 'bs';
            break outer;
          }
        }
      }
      const text = plus.length === 0 ? '' : plus.join('\n') + (noEol ? '' : '\n');
      tree.now.set(newP, text);
      return;
    }
    if (isDel) {
      if (oldP === null) throw new Fail('unsafe', '');
      if (tree.get(oldP) === null) throw new Fail('missing', oldP);
      tree.now.set(oldP, null);
      return;
    }
    if (oldP === null || newP === null) throw new Fail('unsafe', '');
    const isMove = oldP !== newP;
    if (tree.get(oldP) === null) throw new Fail('missing', oldP);
    if (isMove && tree.get(newP) !== null) throw new Fail('exists', newP);
    let state = splitFile(tree.get(oldP)!);
    let d = 0;
    for (const h of s.hunks) {
      const res = applyUnifiedHunk(state, h, d, strict, oldP);
      state = res.state;
      d += res.delta;
    }
    const text = joinFile(state);
    if (isMove) {
      tree.now.set(oldP, null);
      tree.now.set(newP, text);
      tree.noteMove(oldP, newP);
    } else {
      tree.now.set(oldP, text);
    }
  };
}

function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  const sections: USection[] = [];
  let i = 0;
  const n = lines.length;
  const isSectionStart = (idx: number): boolean => {
    if (lines[idx]!.startsWith('diff --git ')) return true;
    return lines[idx]!.startsWith('--- ') && (lines[idx + 1] ?? '').startsWith('+++ ');
  };
  while (i < n) {
    if (lines[i]!.startsWith('@@')) throw new Exit2(`error: parse ${i + 1}`);
    if (!isSectionStart(i)) {
      i++;
      continue;
    }
    let oldPath: string | null = null;
    let newPath: string | null = null;
    let hasPair = false;
    let renameOld: string | null = null;
    let renameNew: string | null = null;
    let create = false;
    let del = false;
    let consumed = false;
    if (lines[i]!.startsWith('diff --git ')) {
      const m = /^diff --git a\/(\S+) b\/(\S+)\s*$/.exec(lines[i]!);
      if (!m) throw new Exit2(`error: parse ${i + 1}`);
      oldPath = m[1]!;
      newPath = m[2]!;
      i++;
      consumed = true;
    }
    const hunks: UHunk[] = [];
    while (i < n) {
      const l = lines[i]!;
      if (l.startsWith('@@')) break;
      if (l.startsWith('--- ')) {
        const nxt = lines[i + 1];
        if (nxt === undefined || !nxt.startsWith('+++ ')) throw new Exit2(`error: parse ${i + 2}`);
        if (hasPair) break;
        const op = headerPath(l);
        const np = headerPath(nxt);
        oldPath = op === '/dev/null' ? null : stripAB(op);
        newPath = np === '/dev/null' ? null : stripAB(np);
        hasPair = true;
        i += 2;
        consumed = true;
        continue;
      }
      if (consumed && l.startsWith('diff --git ')) break;
      if (l.startsWith('+++ ')) {
        const np = headerPath(l);
        newPath = np === '/dev/null' ? null : stripAB(np);
        i++;
        consumed = true;
        continue;
      }
      if (l.startsWith('rename from ')) {
        renameOld = l.slice('rename from '.length).trim();
        i++;
        consumed = true;
        continue;
      }
      if (l.startsWith('rename to ')) {
        renameNew = l.slice('rename to '.length).trim();
        i++;
        consumed = true;
        continue;
      }
      if (l.startsWith('new file mode')) {
        create = true;
        i++;
        consumed = true;
        continue;
      }
      if (l.startsWith('deleted file mode')) {
        del = true;
        i++;
        consumed = true;
        continue;
      }
      i++;
      consumed = true;
    }
    if (!hasPair) {
      if (renameOld !== null) oldPath = stripAB(renameOld);
      if (renameNew !== null) newPath = stripAB(renameNew);
    }
    while (i < n) {
      const l = lines[i]!;
      if (!l.startsWith('@@')) break;
      const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(l);
      if (!m) throw new Exit2(`error: parse ${i + 1}`);
      const a = parseInt(m[1]!, 10);
      i++;
      const body: UBody[] = [];
      while (i < n) {
        const b = lines[i]!;
        if (b.startsWith('diff --git ')) break;
        if (b.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) break;
        if (b.startsWith(' ') || b.startsWith('-') || b.startsWith('+') || b.startsWith('\\')) {
          body.push({ kind: b[0] === ' ' ? 'ctx' : b[0] === '-' ? 'old' : b[0] === '+' ? 'new' : 'bs', text: b[0] === '\\' ? b : b.slice(1) });
          i++;
          continue;
        }
        if (b === '') {
          body.push({ kind: 'ctx', text: '' });
          i++;
          continue;
        }
        break;
      }
      while (body.length > 0 && body[body.length - 1]!.kind === 'ctx' && body[body.length - 1]!.text === '') body.pop();
      hunks.push({ a, body });
    }
    sections.push({ oldPath, newPath, create, del, hunks });
  }
  if (sections.length === 0) throw new Exit2('error: parse 1');
  return sections.map((s) => unifiedSectionEdit(s, strict));
}

/** SEARCH/REPLACE blocks (SPEC section 7). */
function searchReplaceEdit(path: string, oldLines: string[], newLines: string[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (oldLines.length === 0) {
      if (tree.get(path) !== null) throw new Fail('exists', path);
      const text = newLines.length === 0 ? '' : newLines.join('\n') + '\n';
      tree.now.set(path, text);
      return;
    }
    const cur = tree.get(path);
    if (cur === null) throw new Fail('missing', path);
    const state = splitFile(cur);
    const found = findTier(state.lines, oldLines, 0, strict);
    if (found === null) throw new Fail('no-match', path);
    if (found.occ.length > 1) throw new Fail('ambiguous', path);
    const pos = found.occ[0]!;
    const n: NLine[] = newLines.map((t) => ({ text: t, ctx: false, oIdx: -1 }));
    const replaced = transformN(n, state.lines, pos, oldLines, found.tier);
    const lines = [...state.lines];
    lines.splice(pos, oldLines.length, ...replaced);
    tree.now.set(path, joinFile({ lines, br: state.br, finalBreak: state.finalBreak }));
  };
}

function searchReplaceEdits(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevEnd = -1;
  let prevPath: string | null = null;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i++;
      continue;
    }
    const searchIdx = i;
    let path: string | null = null;
    for (let k = searchIdx - 1; k > prevEnd; k--) {
      const t = lines[k]!;
      if (blank(t)) continue;
      if (t.trim().startsWith('```')) continue;
      path = t.trim();
      break;
    }
    if (path === null) path = prevPath;
    if (path === null) throw new Exit2(`error: parse ${searchIdx + 1}`);
    let eqIdx = -1;
    for (let k = searchIdx + 1; k < lines.length; k++) {
      if (lines[k]!.trimEnd() === '=======') {
        eqIdx = k;
        break;
      }
      if (lines[k]!.trimEnd() === '<<<<<<< SEARCH') break;
    }
    let endIdx = -1;
    if (eqIdx >= 0) {
      for (let k = eqIdx + 1; k < lines.length; k++) {
        if (lines[k]!.trimEnd() === '>>>>>>> REPLACE') {
          endIdx = k;
          break;
        }
        if (lines[k]!.trimEnd() === '<<<<<<< SEARCH') break;
      }
    }
    if (eqIdx < 0 || endIdx < 0) throw new Exit2(`error: parse ${searchIdx + 1}`);
    const oldLines = lines.slice(searchIdx + 1, eqIdx);
    const newLines = lines.slice(eqIdx + 1, endIdx);
    edits.push(searchReplaceEdit(path, oldLines, newLines, strict));
    prevPath = path;
    prevEnd = endIdx;
    i = endIdx + 1;
  }
  if (edits.length === 0) throw new Exit2('error: parse 1');
  return edits;
}

/** V4A patches (SPEC section 8). */
interface VBody {
  kind: 'ctx' | 'old' | 'new';
  text: string;
}
interface VChunk {
  anchor: string | null;
  eof: boolean;
  body: VBody[];
}
interface VSection {
  kind: 'add' | 'del' | 'update';
  path: string;
  moveTo: string | null;
  lines: string[];
  chunks: VChunk[];
  updateLine: number;
}

function applyV4aChunk(state: FileState, ch: VChunk, cursor: number, strict: boolean, path: string): { state: FileState; cursor: number } {
  const lines = [...state.lines];
  let cur = cursor;
  if (ch.anchor !== null && ch.anchor !== '') {
    const found = findTier(lines, [ch.anchor], cur, strict);
    if (found === null) throw new Fail('no-match', path);
    cur = found.occ[0]! + 1;
  }
  const o: string[] = [];
  const n: NLine[] = [];
  let oIdx = 0;
  for (const b of ch.body) {
    if (b.kind === 'ctx') {
      o.push(b.text);
      n.push({ text: b.text, ctx: true, oIdx });
      oIdx++;
    } else if (b.kind === 'old') {
      o.push(b.text);
      oIdx++;
    } else {
      n.push({ text: b.text, ctx: false, oIdx: -1 });
    }
  }
  if (o.length === 0) {
    const insertPos = ch.eof ? lines.length : cur;
    const newLines = n.map((x) => x.text);
    lines.splice(insertPos, 0, ...newLines);
    return { state: { lines, br: state.br, finalBreak: state.finalBreak }, cursor: insertPos + newLines.length };
  }
  let pos: number | null = null;
  let tierUsed = 0;
  if (ch.eof) {
    const tiers = strict ? [0] : [0, 1, 2];
    for (const t of tiers) {
      const occ = occurrencesAt(lines, o, t, cur).filter((p) => p + o.length === lines.length);
      if (occ.length > 0) {
        pos = occ[0]!;
        tierUsed = t;
        break;
      }
    }
  } else {
    const found = findTier(lines, o, cur, strict);
    if (found !== null) {
      pos = found.occ[0]!;
      tierUsed = found.tier;
    }
  }
  if (pos === null) throw new Fail('no-match', path);
  const newLines = transformN(n, lines, pos, o, tierUsed);
  lines.splice(pos, o.length, ...newLines);
  return { state: { lines, br: state.br, finalBreak: state.finalBreak }, cursor: pos + newLines.length };
}

function v4aSectionEdit(s: VSection, strict: boolean): Edit {
  return (tree) => {
    if (!safe(s.path)) throw new Fail('unsafe', s.path);
    if (s.moveTo !== null && !safe(s.moveTo)) throw new Fail('unsafe', s.moveTo);
    if (s.kind === 'add') {
      if (tree.get(s.path) !== null) throw new Fail('exists', s.path);
      const text = s.lines.length === 0 ? '' : s.lines.join('\n') + '\n';
      tree.now.set(s.path, text);
      return;
    }
    if (s.kind === 'del') {
      if (tree.get(s.path) === null) throw new Fail('missing', s.path);
      tree.now.set(s.path, null);
      return;
    }
    const cur = tree.get(s.path);
    if (cur === null) throw new Fail('missing', s.path);
    if (s.moveTo !== null && tree.get(s.moveTo) !== null) throw new Fail('exists', s.moveTo);
    let state = splitFile(cur);
    let cursor = 0;
    for (const ch of s.chunks) {
      const res = applyV4aChunk(state, ch, cursor, strict, s.path);
      state = res.state;
      cursor = res.cursor;
    }
    const text = joinFile(state);
    if (s.moveTo !== null) {
      tree.now.set(s.path, null);
      tree.now.set(s.moveTo, text);
      tree.noteMove(s.path, s.moveTo);
    } else {
      tree.now.set(s.path, text);
    }
  };
}

function v4aEdits(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let k = lines.length - 1; k >= 0; k--) {
    if (!blank(lines[k]!)) {
      last = k;
      break;
    }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const sections: VSection[] = [];
  let i = first + 1;
  while (i < last) {
    if (blank(lines[i]!)) {
      i++;
      continue;
    }
    const l = lines[i]!;
    let kind: 'add' | 'del' | 'update' | null = null;
    let path = '';
    if (l.startsWith('*** Add File:')) {
      kind = 'add';
      path = l.slice('*** Add File:'.length).trim();
    } else if (l.startsWith('*** Delete File:')) {
      kind = 'del';
      path = l.slice('*** Delete File:'.length).trim();
    } else if (l.startsWith('*** Update File:')) {
      kind = 'update';
      path = l.slice('*** Update File:'.length).trim();
    } else {
      throw new Exit2(`error: parse ${i + 1}`);
    }
    const updateLine = i + 1;
    i++;
    if (kind === 'add') {
      const fileLines: string[] = [];
      while (i < last) {
        const b = lines[i]!;
        if (b.startsWith('*** Add File:') || b.startsWith('*** Delete File:') || b.startsWith('*** Update File:')) break;
        if (b.startsWith('+')) {
          fileLines.push(b.slice(1));
          i++;
          continue;
        }
        if (b === '') {
          fileLines.push('');
          i++;
          continue;
        }
        throw new Exit2(`error: parse ${i + 1}`);
      }
      while (fileLines.length > 0 && fileLines[fileLines.length - 1] === '') fileLines.pop();
      sections.push({ kind, path, moveTo: null, lines: fileLines, chunks: [], updateLine });
      continue;
    }
    if (kind === 'del') {
      while (i < last && blank(lines[i]!)) i++;
      sections.push({ kind, path, moveTo: null, lines: [], chunks: [], updateLine });
      continue;
    }
    let moveTo: string | null = null;
    let j = i;
    while (j < last && blank(lines[j]!)) j++;
    if (j < last && lines[j]!.startsWith('*** Move to:')) {
      moveTo = lines[j]!.slice('*** Move to:'.length).trim();
      i = j + 1;
    }
    const chunks: VChunk[] = [];
    let cur: VChunk | null = null;
    const closeChunk = (): void => {
      if (cur !== null) {
        chunks.push(cur);
        cur = null;
      }
    };
    while (i < last) {
      const b = lines[i]!;
      if (b.startsWith('*** Add File:') || b.startsWith('*** Delete File:') || b.startsWith('*** Update File:')) break;
      if (b.startsWith('@@')) {
        closeChunk();
        cur = { anchor: b.slice(2).trim(), eof: false, body: [] };
        i++;
        continue;
      }
      if (b.trim() === '*** End of File') {
        if (cur === null) cur = { anchor: null, eof: true, body: [] };
        else cur.eof = true;
        closeChunk();
        i++;
        continue;
      }
      if (b.startsWith(' ') || b.startsWith('-') || b.startsWith('+') || b === '') {
        if (cur === null) cur = { anchor: null, eof: false, body: [] };
        cur.body.push({ kind: b === '' ? 'ctx' : b[0] === ' ' ? 'ctx' : b[0] === '-' ? 'old' : 'new', text: b === '' ? '' : b.slice(1) });
        i++;
        continue;
      }
      throw new Exit2(`error: parse ${i + 1}`);
    }
    closeChunk();
    if (chunks.length > 0) {
      const lastChunk = chunks[chunks.length - 1]!;
      while (lastChunk.body.length > 0 && lastChunk.body[lastChunk.body.length - 1]!.kind === 'ctx' && lastChunk.body[lastChunk.body.length - 1]!.text === '') lastChunk.body.pop();
    }
    if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${updateLine}`);
    sections.push({ kind, path, moveTo, lines: [], chunks, updateLine });
  }
  if (sections.length === 0) throw new Exit2('error: parse 1');
  return sections.map((s) => v4aSectionEdit(s, strict));
}

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
            : kind === 'v4a'
              ? v4aEdits(lines, strict)
              : [];
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
  const changed: string[] = [];
  for (const p of [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    changed.push(p);
    if (check) continue;
    if (now === null) rmSync(p, { force: true });
    else {
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, now);
    }
  }
  const dels = new Set<string>();
  const adds = new Set<string>();
  const mods = new Set<string>();
  for (const p of changed) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === null) adds.add(p);
    else if (now === null) dels.add(p);
    else mods.add(p);
  }
  interface Row {
    key: string;
    text: string;
  }
  const rowObjs: Row[] = [];
  const usedAdd = new Set<string>();
  const usedDel = new Set<string>();
  for (const [origin, cur] of [...tree.moves.entries()]) {
    if (dels.has(origin) && adds.has(cur) && tree.original(origin) !== null && tree.original(cur) === null) {
      rowObjs.push({ key: cur, text: `R ${origin} -> ${cur}` });
      usedDel.add(origin);
      usedAdd.add(cur);
    }
  }
  for (const p of dels) if (!usedDel.has(p)) rowObjs.push({ key: p, text: `D ${p}` });
  for (const p of adds) if (!usedAdd.has(p)) rowObjs.push({ key: p, text: `A ${p}` });
  for (const p of mods) rowObjs.push({ key: p, text: `M ${p}` });
  rowObjs.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  const rows = rowObjs.map((r) => r.text);
  return { code: 0, out: [...rows, `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
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
