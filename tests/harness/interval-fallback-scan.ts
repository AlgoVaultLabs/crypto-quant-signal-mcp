/**
 * interval-fallback-scan.ts — OPS-SERVED-CANDLE-TRUTH-W1 CH2. The AST half of the no-silent-interval-fallback gate
 * (tests/unit/adapter-history-contract.test.ts, "structure").
 *
 * Until CH2, fourteen adapters wrote `INTERVAL_MAP[interval] || '1h'` and two wrote `?? <default>`, so a timeframe the
 * venue did not serve was fetched as the default bar and returned under the label the caller asked for. Every adapter
 * now asks `resolveVenueInterval` (src/lib/adapters/_interval.ts), which refuses instead. This scan keeps the pattern
 * from coming back. It parses one adapter source and reports:
 *   - every `||` / `??` / `?:` fallback whose tested side reads a timeframe-keyed map, or reads `resolveVenueInterval`;
 *   - every `||` / `??` / `?:` whose fallback is an interval-token literal (`'1h'`, `'60min'`, `'Hour4'`, `'MINUTE_5'`),
 *     whatever it falls back from — the planted `|| '1h'` the gate is proven on;
 *   - the map each `resolveVenueInterval` call resolves, with its keys: the served map, as the source states it.
 * A timeframe-keyed map is an object literal whose keys are all timeframe tokens (`1m`, `8h`, `1d`, `1w`, `1M`).
 */
import ts from 'typescript';

const TF_KEY = /^\d+[mhdwM]$/;
/** An interval-token string in any venue notation the adapters use (served-interval.ts parseIntervalToken),
 *  bare-number minutes excepted: `|| '1'` / `|| '0'` are numeric defaults, not bars. */
const INTERVAL_TOKEN = /^(\d+(m|h|d|w|H|D|W|M)|(Min|Hour|Day)\d+|\d+(min|hour|day)|(MINUTE|HOUR|DAY|WEEK)_\d+)$/;

export interface ResolvedMap { name: string; keys: string[]; line: number }
export interface IntervalScan { file: string; fallbacks: string[]; resolvedMaps: ResolvedMap[]; timeframeMaps: string[]; mapKeys: Record<string, string[]> }

function unwrap(e: ts.Expression): ts.Expression {
  let x = e;
  while (ts.isParenthesizedExpression(x) || ts.isAsExpression(x) || ts.isNonNullExpression(x) || ts.isSatisfiesExpression(x) || ts.isTypeAssertionExpression(x)) x = x.expression;
  if (ts.isCallExpression(x) && x.arguments.length === 1 && x.expression.getText() === 'Object.freeze') return unwrap(x.arguments[0]);
  return x;
}

function propName(p: ts.ObjectLiteralElementLike): string | null {
  if (!ts.isPropertyAssignment(p) && !ts.isShorthandPropertyAssignment(p)) return null;
  const n = p.name;
  if (ts.isIdentifier(n) || ts.isStringLiteral(n) || ts.isNumericLiteral(n)) return n.text;
  return null;
}

export function scanIntervalSource(source: string, file: string): IntervalScan {
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const line = (n: ts.Node) => sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1;
  const at = (n: ts.Node) => `${file}:${line(n)}: ${n.getText(sf).replace(/\s+/g, ' ').slice(0, 120)}`;

  // 1. the timeframe-keyed maps this file declares
  const maps = new Map<string, string[]>();
  const collect = (n: ts.Node): void => {
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer) {
      const init = unwrap(n.initializer);
      if (ts.isObjectLiteralExpression(init) && init.properties.length > 0) {
        const keys = init.properties.map(propName);
        if (keys.every((k): k is string => k !== null && TF_KEY.test(k))) maps.set(n.name.text, keys as string[]);
      }
    }
    ts.forEachChild(n, collect);
  };
  collect(sf);

  const readsMap = (e: ts.Node): boolean => {
    let hit = false;
    const walk = (n: ts.Node): void => {
      if (hit) return;
      if (ts.isElementAccessExpression(n) && ts.isIdentifier(unwrap(n.expression)) && maps.has((unwrap(n.expression) as ts.Identifier).text)) { hit = true; return; }
      if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === 'resolveVenueInterval') { hit = true; return; }
      ts.forEachChild(n, walk);
    };
    walk(e);
    return hit;
  };
  const isToken = (e: ts.Expression): boolean => {
    const x = unwrap(e);
    return (ts.isStringLiteral(x) || ts.isNoSubstitutionTemplateLiteral(x)) && INTERVAL_TOKEN.test(x.text);
  };

  // 2. the fallbacks, and the maps resolveVenueInterval resolves
  const fallbacks: string[] = [];
  const resolvedMaps: ResolvedMap[] = [];
  const visit = (n: ts.Node): void => {
    if (ts.isBinaryExpression(n) && (n.operatorToken.kind === ts.SyntaxKind.BarBarToken || n.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken)) {
      if (readsMap(n.left) || isToken(n.right)) fallbacks.push(at(n));
    } else if (ts.isBinaryExpression(n) && (n.operatorToken.kind === ts.SyntaxKind.BarBarEqualsToken || n.operatorToken.kind === ts.SyntaxKind.QuestionQuestionEqualsToken)) {
      if (readsMap(n.left) || isToken(n.right)) fallbacks.push(at(n));
    } else if (ts.isConditionalExpression(n)) {
      if (readsMap(n.condition) || isToken(n.whenTrue) || isToken(n.whenFalse)) fallbacks.push(at(n));
    }
    if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === 'resolveVenueInterval') {
      const arg = n.arguments[0] ? unwrap(n.arguments[0]) : null;
      const name = arg && ts.isIdentifier(arg) ? arg.text : `<${arg?.getText(sf) ?? 'none'}>`;
      resolvedMaps.push({ name, keys: maps.get(name) ?? [], line: line(n) });
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return { file, fallbacks, resolvedMaps, timeframeMaps: [...maps.keys()], mapKeys: Object.fromEntries(maps) };
}
