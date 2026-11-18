// regime-forward/served-fingerprint.ts — EDGE-REGIME-FORWARD-W1: the fingerprint of the served code the read uses
// (CH3 F15, re-check R4, review FP and PRN, re-check N6; audit lessons 1, 8, 13 and 15).
//
// The read calls four functions of served code that other waves edit — `toBinanceSymbol`, `toBybitSymbol`,
// `toOKXInstId`, `toBitgetSymbol` (the instrument of a label) — and reads one constant, `ATR_RANGE_PER_SIGMA` (A5's
// σ per bar, through T3's bars.ts). The registration pins their five files by sha256, and the decision rests on
// those byte pins: an edit before the read needs a re-pin, an appended amendment whose pre-read audit judges the
// diff in full. This fingerprint is a necessary check on such a re-pin, never proof of completeness. It is tested
// to see the forms named in FINGERPRINT_FORMS, each on a synthetic tree, and it sees nothing else. Each covered
// piece is printed by the TypeScript printer with comments removed, so formatting and comments do not move it;
// the printer's version is registered beside the value (§10), and the guard reads a served tree byte-identical to
// its registered pins whatever the printer, and refuses any other under a printer that is not the registered one.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { SERVED_FINGERPRINT, SERVED_PRINTER, VENUES, type Venue } from './forward-spec.js';

const REPO = path.resolve(__dirname, '../../..');

/** The served files the registration pins (§10, third table). */
export const SERVED_FILES = ['src/lib/pre-trade-calc.ts', 'src/lib/adapters/binance.ts', 'src/lib/adapters/bybit.ts', 'src/lib/adapters/okx.ts', 'src/lib/adapters/bitget.ts'] as const;

/** What the read uses, by file and name. */
export const SERVED_NAMES: Readonly<Record<Venue | 'ATR', { file: string; name: string }>> = Object.freeze({
  BINANCE: { file: 'src/lib/adapters/binance.ts', name: 'toBinanceSymbol' },
  BYBIT: { file: 'src/lib/adapters/bybit.ts', name: 'toBybitSymbol' },
  OKX: { file: 'src/lib/adapters/okx.ts', name: 'toOKXInstId' },
  BITGET: { file: 'src/lib/adapters/bitget.ts', name: 'toBitgetSymbol' },
  ATR: { file: 'src/lib/pre-trade-calc.ts', name: 'ATR_RANGE_PER_SIGMA' },
});

const printer = ts.createPrinter({ removeComments: true, newLine: ts.NewLineKind.LineFeed });

/**
 * The forms the fingerprint is tested to see (re-check N6): registration §1 states each phrase verbatim, and the spec
 * suite moves the fingerprint with a synthetic case of each. It sees nothing else; the byte pins and the amendment's
 * audit decide.
 */
export const FINGERPRINT_FORMS = Object.freeze({
  body: 'the body of a symbol function',
  declaration: 'a top-level declaration that covered code reads',
  import: 'a declaration reached through a relative import',
  sigma: "the declaration of σ_bar's constant",
  statement: 'a top-level statement that is not a declaration and reads or writes a covered name',
});

/** The version of the printer whose output the fingerprint hashes (review PRN). */
export const PRINTER: string = ts.version;

/** A top-level statement that declares or imports (or is a type): never one of a file's covered statements. */
const declares = (st: ts.Statement): boolean =>
  ts.isFunctionDeclaration(st) || ts.isVariableStatement(st) || ts.isImportDeclaration(st) || ts.isImportEqualsDeclaration(st) || ts.isExportDeclaration(st)
  || ts.isInterfaceDeclaration(st) || ts.isTypeAliasDeclaration(st) || ts.isClassDeclaration(st) || ts.isEnumDeclaration(st) || ts.isModuleDeclaration(st);

interface Parsed { sf: ts.SourceFile; decls: Map<string, ts.Node>; imports: Map<string, { from: string; name: string }>; statements: ts.Statement[] }

/** A file's top-level declarations by name (a function, or the statement of a variable), its relative imports and its other statements. */
function topLevel(sf: ts.SourceFile): Omit<Parsed, 'sf'> {
  const decls = new Map<string, ts.Node>(), imports = new Map<string, { from: string; name: string }>(), statements: ts.Statement[] = [];
  for (const st of sf.statements) {
    if (ts.isFunctionDeclaration(st) && st.name) decls.set(st.name.text, st);
    else if (ts.isVariableStatement(st)) for (const d of st.declarationList.declarations) { if (ts.isIdentifier(d.name)) decls.set(d.name.text, st); }
    else if (ts.isImportDeclaration(st) && ts.isStringLiteral(st.moduleSpecifier) && st.moduleSpecifier.text.startsWith('.') && !st.importClause?.isTypeOnly) {
      const nb = st.importClause?.namedBindings;
      if (nb && ts.isNamedImports(nb)) for (const e of nb.elements) if (!e.isTypeOnly) imports.set(e.name.text, { from: st.moduleSpecifier.text, name: (e.propertyName ?? e.name).text });
    }
    if (!declares(st)) statements.push(st);
  }
  return { decls, imports, statements };
}

/** The identifiers a node reads: every identifier except a property name after a dot or the key of an object literal. */
function readsOf(node: ts.Node): Set<string> {
  const out = new Set<string>();
  const visit = (n: ts.Node): void => {
    if (ts.isIdentifier(n)) {
      const p = n.parent;
      const isKey = (ts.isPropertyAccessExpression(p) && p.name === n) || (ts.isPropertyAssignment(p) && p.name === n);
      if (!isKey) out.add(n.text);
    }
    ts.forEachChild(n, visit);
  };
  visit(node);
  return out;
}

export type SourceOf = (file: string) => string;

/**
 * The printed source of `name` in `file`, of every top-level declaration it reads, transitively, keyed `file#name`,
 * and of every top-level statement of a visited file that is not a declaration and reads or writes a covered name
 * of that file (its own or one it imports), keyed `file#(statements)` in source order; what such a statement reads
 * is covered in turn, to a fixed point (review FP). A name that is not declared there refuses (thrown): the
 * fingerprint never silently covers less.
 */
export function closureOf(file: string, name: string, sourceOf: SourceOf): Record<string, string> {
  const out: Record<string, string> = {}, queue: Array<[string, string]> = [[file, name]];
  const parsed = new Map<string, Parsed>(), taken = new Map<string, Set<ts.Statement>>();
  const fileOf = (f: string): Parsed => {
    let p = parsed.get(f);
    if (!p) { const sf = ts.createSourceFile(f, sourceOf(f), ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS); p = { sf, ...topLevel(sf) }; parsed.set(f, p); }
    return p;
  };
  const importOf = (f: string, imp: { from: string; name: string }): [string, string] => [path.posix.join(path.posix.dirname(f), imp.from.replace(/\.js$/, '.ts')), imp.name];
  const follow = (f: string, p: Parsed, ids: Set<string>, self: string | null): void => {
    for (const id of ids) {
      if (id !== self && p.decls.has(id)) queue.push([f, id]);
      const imp = p.imports.get(id);
      if (imp) queue.push(importOf(f, imp));
    }
  };
  for (;;) {
    while (queue.length) {
      const [f, n] = queue.shift() as [string, string];
      const key = `${f}#${n}`;
      if (key in out) continue;
      const p = fileOf(f), node = p.decls.get(n);
      if (!node) throw new Error(`served-fingerprint: ${n} is not a top-level declaration of ${f}`);
      out[key] = printer.printNode(ts.EmitHint.Unspecified, node, p.sf);
      follow(f, p, readsOf(node), n);
    }
    // the statements that read or write what is covered, and what they read in turn
    let grew = false;
    for (const [f, p] of parsed) {
      const covered = new Set<string>([...p.decls.keys()].filter((n) => `${f}#${n}` in out));
      for (const [local, imp] of p.imports) { const [g, n] = importOf(f, imp); if (`${g}#${n}` in out) covered.add(local); }
      const mine = taken.get(f) ?? new Set<ts.Statement>();
      taken.set(f, mine);
      for (const st of p.statements) {
        if (mine.has(st)) continue;
        const ids = readsOf(st);
        if (![...ids].some((id) => covered.has(id))) continue;
        mine.add(st); grew = true;
        follow(f, p, ids, null);
      }
      if (mine.size) out[`${f}#(statements)`] = p.statements.filter((st) => mine.has(st)).map((st) => printer.printNode(ts.EmitHint.Unspecified, st, p.sf)).join('\n');
    }
    if (!grew && !queue.length) return out;
  }
}

/** The fingerprint over the five names' source closures; `declarations` counts the declarations covered. */
export function fingerprintOf(sourceOf: SourceOf): { sha256: string; declarations: number } {
  const parts: Record<string, Record<string, string>> = {};
  for (const k of [...VENUES, 'ATR'] as const) parts[k] = closureOf(SERVED_NAMES[k].file, SERVED_NAMES[k].name, sourceOf);
  const text = JSON.stringify(Object.fromEntries(Object.entries(parts).map(([k, v]) => [k, Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b)))])));
  const declarations = Object.values(parts).reduce((s, v) => s + Object.keys(v).filter((k) => !k.endsWith('#(statements)')).length, 0);
  return { sha256: crypto.createHash('sha256').update(text).digest('hex'), declarations };
}

/** The FIRST pin row of each served file: the bytes the fingerprint was registered over (a re-pin appends a later row). */
export function firstPinsOf(registrationText: string): Map<string, string> {
  const first = new Map<string, string>();
  for (const m of registrationText.matchAll(/^\|\s*`([^`]+)`\s*\|\s*`([0-9a-f]{64})`\s*\|/gm)) {
    if ((SERVED_FILES as readonly string[]).includes(m[1]) && !first.has(m[1])) first.set(m[1], m[2]);
  }
  return first;
}

export interface Want { fingerprint: string; printer: string }

/** The values a read judges by: the registered ones, or a test seam's own — never the registered fingerprint (lesson 10). */
export function servedWant(seam: Want | null): Want {
  if (seam === null) return { fingerprint: SERVED_FINGERPRINT, printer: SERVED_PRINTER };
  if (seam.fingerprint === SERVED_FINGERPRINT) throw new Error('a test seam never judges by the registered served fingerprint');
  return seam;
}

/**
 * The guard's served check (pure): every served file present and pinned; byte-identical to its FIRST pins → read,
 * whatever the printer (the fingerprint is then checked only under the registered printer); otherwise — a file
 * re-pinned by an amendment — refused under any printer but the registered one, and judged by the fingerprint
 * under it. Never throws.
 */
export function servedRefusalOf(x: { registration: string; sourceOf: (file: string) => string | null; printer: string; want: Want }): string | null {
  const first = firstPinsOf(x.registration);
  const texts = new Map<string, string>();
  for (const f of SERVED_FILES) {
    if (!first.has(f)) return `served ${f} is not pinned`;
    const t = x.sourceOf(f);
    if (t === null) return `served ${f} is missing`;
    texts.set(f, t);
  }
  const identical = SERVED_FILES.every((f) => crypto.createHash('sha256').update(texts.get(f) as string).digest('hex') === first.get(f));
  if (x.printer !== x.want.printer) {
    return identical ? null : `the TypeScript printer ${x.printer} is not the registered ${x.want.printer}, and a served file differs from its registered pin: the fingerprint cannot judge the edit (printer mismatch)`;
  }
  try {
    const got = fingerprintOf((f) => { const t = texts.get(f) ?? x.sourceOf(f); if (t === null) throw new Error(`${f} is missing`); return t; }).sha256;
    return got === x.want.fingerprint ? null : `the served code's source fingerprint ${got.slice(0, 12)} differs from the registered ${x.want.fingerprint.slice(0, 12)}: a symbol function, a map it reads, a statement that changes one, or σ_bar changed`;
  } catch (e) {
    return `the served code's fingerprint: ${(e as Error).message.split('\n')[0]}`;
  }
}

/** The served check over a checkout: its registration (already shown byte-equal to origin/main) and its served files. */
export function servedRefusal(repo: string, registrationFile: string, seam: Want | null): string | null {
  let want: Want;
  try { want = servedWant(seam); } catch (e) { return (e as Error).message; }
  let registration: string;
  try { registration = fs.readFileSync(path.join(repo, registrationFile), 'utf8'); } catch (e) { return `the registration: ${(e as Error).message.split('\n')[0]}`; }
  return servedRefusalOf({ registration, printer: PRINTER, want, sourceOf: (f) => { try { return fs.readFileSync(path.join(repo, f), 'utf8'); } catch { return null; } } });
}
