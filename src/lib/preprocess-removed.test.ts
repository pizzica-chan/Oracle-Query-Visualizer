import { describe, expect, it } from 'vitest';
import { SQL_TEST_CASES } from './fixtures/sql-cases';
import { preprocessSqlForParser, type PreprocessResult } from './sql-preprocess';
import type { SourceSpan } from './types';

/**
 * 前処理が空白に置き換えたものは、すべてどこかに記録していなければならない。
 * 記録せずに取り除くと、その句の作用が作用説明から消え、SQL の結果を違うものとして説明してしまう
 * （SAMPLE や ORDER SIBLINGS BY の SIBLINGS を黙って取り除き、表の全部の行を読む・結果全体を並べ替えると説明していた）。
 * 新しく句を取り除くときは、記録するフィールドを作り、recordedSpans に足す。ここに足すだけでなく、作用説明にも出す
 */
function recordedSpans(pre: PreprocessResult): SourceSpan[] {
  return [
    ...pre.outerJoinMarkers.map((m) => m.sourceSpan),
    ...pre.hierarchicalClauses.map((c) => c.sourceSpan),
    ...pre.rowLimits.map((r) => r.sourceSpan),
    ...pre.hints.map((h) => h.sourceSpan),
    ...pre.nullsOrders.map((n) => n.sourceSpan),
    ...pre.aggregateClauses.map((a) => a.sourceSpan),
    ...(pre.lockingClause ? [pre.lockingClause.sourceSpan] : []),
    ...pre.tableModifiers.map((m) => m.sourceSpan),
    ...pre.orderSiblingsSpans,
  ];
}

function unrecordedBlanks(sql: string): string[] {
  const pre = preprocessSqlForParser(sql);
  const recorded = recordedSpans(pre);
  return pre.blankedSpans
    .filter((blank) => !recorded.some((span) => span.start <= blank.start && blank.end <= span.end))
    .map((blank) => sql.slice(blank.start, blank.end));
}

/** 前処理が取り除く句を 1 つずつ使う SQL。共有のケース集に無い句も、ここで必ず通す */
const REMOVED_CLAUSE_SQL = [
  'SELECT e.id FROM emp e, dept d WHERE e.dept_id = d.id(+)',
  'SELECT /*+ INDEX(e ix) */ e.id FROM emp e',
  'SELECT LEVEL FROM emp e START WITH e.mgr IS NULL CONNECT BY NOCYCLE PRIOR e.id = e.mgr ORDER SIBLINGS BY e.name',
  'SELECT e.id FROM emp e ORDER BY e.id NULLS LAST OFFSET 5 ROWS FETCH NEXT 10 ROWS ONLY',
  "SELECT LISTAGG(e.name, ',') WITHIN GROUP (ORDER BY e.name), MIN(e.sal) KEEP (DENSE_RANK FIRST ORDER BY e.d) FROM emp e",
  'SELECT e.id FROM emp e FOR UPDATE OF e.sal SKIP LOCKED',
  'SELECT * FROM emp SAMPLE BLOCK (10) SEED (1) e',
  'SELECT * FROM emp PARTITION (p1) e',
  "SELECT * FROM emp AS OF TIMESTAMP SYSTIMESTAMP - INTERVAL '1' HOUR e",
  'SELECT * FROM scott.emp@remote_db e',
];

describe('前処理で取り除いたもの', () => {
  it.each(REMOVED_CLAUSE_SQL)('空白にしたものは、すべて記録している: %s', (sql) => {
    const pre = preprocessSqlForParser(sql);
    expect(pre.blankedSpans.length).toBeGreaterThan(0);
    expect(unrecordedBlanks(sql)).toEqual([]);
  });

  it('共有のケース集の全件で、空白にしたものは、すべて記録している', () => {
    const missing = SQL_TEST_CASES.flatMap(({ sql }) => unrecordedBlanks(sql.trim()).map((text) => `${text} ← ${sql.slice(0, 60)}`));
    expect(missing).toEqual([]);
  });
});
