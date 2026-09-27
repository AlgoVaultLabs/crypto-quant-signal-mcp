// ads1/ddl-parity.ts — EDGE-ADS1-SCORECARD-W1-V2 CH2 R3. PURE.
//
// `directional_labels` is declared twice: the schema-as-code migrations (019 CREATE + every later
// ALTER … ADD COLUMN) and the DDL the labeler applies before it writes (`DIRECTIONAL_LABELS_DDL_PG`).
// Two copies of one schema drift silently — the labeler would keep writing a column set the migrations
// no longer describe. This computes both column sets from the SQL text and compares them; the vitest
// test and `ddl-parity-check.js` (the CH2 gate's leg) both call it, so there is one comparison.

/** Remove `--` line comments (the migrations annotate every column). */
export function stripSqlComments(sql: string): string {
  return sql.replace(/--[^\n]*/g, '');
}

/** Column names declared by `CREATE TABLE [IF NOT EXISTS] <table> ( … )`. Constraint lines are skipped. */
export function columnsOfCreate(sql: string, table: string): string[] {
  const s = stripSqlComments(sql);
  const re = new RegExp(`CREATE\\s+TABLE\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?${table}\\s*\\(`, 'i');
  const m = re.exec(s);
  if (!m) return [];
  // take the balanced parenthesised body
  let depth = 1;
  let i = m.index + m[0].length;
  const start = i;
  for (; i < s.length && depth > 0; i++) {
    if (s[i] === '(') depth++;
    else if (s[i] === ')') depth--;
  }
  const body = s.slice(start, i - 1);
  // split on top-level commas
  const parts: string[] = [];
  let d = 0, cur = '';
  for (const ch of body) {
    if (ch === '(') d++;
    if (ch === ')') d--;
    if (ch === ',' && d === 0) { parts.push(cur); cur = ''; } else cur += ch;
  }
  parts.push(cur);
  return parts
    .map((p) => p.trim())
    .filter((p) => p.length > 0 && !/^(PRIMARY\s+KEY|CONSTRAINT|UNIQUE|CHECK|FOREIGN\s+KEY)\b/i.test(p))
    .map((p) => p.split(/\s+/)[0].toLowerCase());
}

/** Column names added by `ALTER TABLE [IF EXISTS] <table> ADD [COLUMN] [IF NOT EXISTS] <col>`. */
export function columnsOfAlterAdd(sql: string, table: string): string[] {
  const s = stripSqlComments(sql);
  const re = new RegExp(
    `ALTER\\s+TABLE\\s+(?:IF\\s+EXISTS\\s+)?${table}\\s+ADD\\s+(?:COLUMN\\s+)?(?:IF\\s+NOT\\s+EXISTS\\s+)?([A-Za-z_][A-Za-z0-9_]*)`,
    'gi',
  );
  const out: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(s)) !== null) out.push(m[1].toLowerCase());
  return out;
}

export function columnSet(sqls: string[], table: string): Set<string> {
  const cols = new Set<string>();
  for (const sql of sqls) {
    for (const c of columnsOfCreate(sql, table)) cols.add(c);
    for (const c of columnsOfAlterAdd(sql, table)) cols.add(c);
  }
  return cols;
}

export interface DdlParity {
  verdict: 'PASS' | 'FAIL';
  columns: number;
  onlyInApplied: string[];
  onlyInMigrations: string[];
}

/** Compare the labeler's applied DDL with the migrations (forward files only, never `*.down.sql`). */
export function ddlParity(appliedDdl: string, migrationSqls: string[], table = 'directional_labels'): DdlParity {
  const applied = columnSet([appliedDdl], table);
  const migrated = columnSet(migrationSqls, table);
  const onlyInApplied = [...applied].filter((c) => !migrated.has(c)).sort();
  const onlyInMigrations = [...migrated].filter((c) => !applied.has(c)).sort();
  return {
    verdict: onlyInApplied.length === 0 && onlyInMigrations.length === 0 && applied.size > 0 ? 'PASS' : 'FAIL',
    columns: applied.size,
    onlyInApplied,
    onlyInMigrations,
  };
}
