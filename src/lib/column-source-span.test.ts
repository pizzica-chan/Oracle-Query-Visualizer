import { describe, expect, it } from 'vitest';
import { parseOracleQuery, SAMPLE_SQL } from './parser';

describe('column sourceSpan', () => {
  it('SELECT 列ごとに異なる sourceSpan を持つ', () => {
    const result = parseOracleQuery(SAMPLE_SQL);
    expect(result.success).toBe(true);
    if (!result.success) return;

    const spans = result.query.columns.map((c) => c.sourceSpan);
    expect(spans.every(Boolean)).toBe(true);

    const unique = new Set(spans.map((s) => `${s!.start}:${s!.end}`));
    expect(unique.size).toBe(result.query.columns.length);

    for (let i = 0; i < spans.length; i++) {
      for (let j = i + 1; j < spans.length; j++) {
        expect(spans[i]!.start).not.toBe(spans[j]!.start);
      }
    }
  });

  it('UNION 各ブランチの列 sourceSpan は AS エイリアスまで伸びる', () => {
    const sql =
      'SELECT u.id AS uid FROM users u UNION SELECT o.id AS oid FROM orders o JOIN users u ON u.id = o.user_id';
    const result = parseOracleQuery(sql);
    expect(result.success, result.success ? '' : result.error.message).toBe(true);
    if (!result.success) return;

    const main = result.query.columns[0]?.sourceSpan;
    const branch0 = result.query.unionBranches?.[0]?.query.columns[0]?.sourceSpan;
    const branch1 = result.query.unionBranches?.[1]?.query.columns[0]?.sourceSpan;
    expect(main).toBeDefined();
    expect(branch0).toBeDefined();
    expect(branch1).toBeDefined();
    expect(sql.slice(main!.start, main!.end)).toBe('u.id AS uid');
    expect(sql.slice(branch0!.start, branch0!.end)).toBe('u.id AS uid');
    expect(sql.slice(branch1!.start, branch1!.end)).toBe('o.id AS oid');
  });

  it('派生テーブルの列 sourceSpan も AS エイリアスまで伸びる', () => {
    const sql =
      'SELECT t.uid FROM (SELECT u.id AS uid FROM users u JOIN orders o ON o.user_id = u.id) t';
    const result = parseOracleQuery(sql);
    expect(result.success, result.success ? '' : result.error.message).toBe(true);
    if (!result.success) return;

    const inner = result.query.tables.find((t) => t.isDerived)?.derivedQuery?.columns[0]?.sourceSpan;
    expect(inner).toBeDefined();
    expect(sql.slice(inner!.start, inner!.end)).toBe('u.id AS uid');
  });

  it('小文字 as・AS なし・引用識別子エイリアスまで sourceSpan が伸びる', () => {
    const cases: Array<{ sql: string; expected: string }> = [
      { sql: 'SELECT u.id as uid FROM users u', expected: 'u.id as uid' },
      { sql: 'SELECT u.id uid FROM users u', expected: 'u.id uid' },
      { sql: 'SELECT u.id AS "uid" FROM users u', expected: 'u.id AS "uid"' },
      {
        sql: 'SELECT u.id /* note */ AS uid FROM users u JOIN orders o ON o.user_id = u.id',
        expected: 'u.id /* note */ AS uid',
      },
    ];
    for (const { sql, expected } of cases) {
      const result = parseOracleQuery(sql);
      expect(result.success, result.success ? '' : result.error.message).toBe(true);
      if (!result.success) return;
      const span = result.query.columns[0]?.sourceSpan;
      expect(span, sql).toBeDefined();
      expect(sql.slice(span!.start, span!.end), sql).toBe(expected);
    }
  });
});
