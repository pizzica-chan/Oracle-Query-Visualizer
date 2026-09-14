import { describe, expect, it } from 'vitest';
import { applyAliasResolution } from './alias-resolver';
import { formatJoinDisplayType, parseOracleQuery, LEGACY_JOIN_SAMPLE_SQL } from './parser';
import { buildQueryEffect } from './query-effect';

function expectParseOk(sql: string) {
  const result = parseOracleQuery(sql);
  expect(result.success, result.success ? '' : result.error.message).toBe(true);
  return result;
}

describe('旧式外部結合演算子 (+)', () => {
  describe('結合の向き', () => {
    it('右辺に (+) が付くと左表の行がすべて残る（LEFT JOIN）', () => {
      const result = expectParseOk(
        'SELECT e.emp_no FROM employees e, departments d WHERE e.dept_no = d.dept_no(+)',
      );
      if (!result.success) return;

      expect(result.query.joins).toHaveLength(1);
      const join = result.query.joins[0]!;
      expect(join.type).toBe('LEFT JOIN');
      expect(join.isOuterJoinOperator).toBe(true);
      expect(join.fromWhereClause).toBe(true);

      const source = result.query.tables.find((t) => t.id === join.sourceId);
      const target = result.query.tables.find((t) => t.id === join.targetId);
      expect(source?.table).toBe('employees');
      expect(target?.table).toBe('departments');
    });

    it('左辺に (+) が付くと右表の行がすべて残る（RIGHT JOIN）', () => {
      const result = expectParseOk(
        'SELECT e.emp_no FROM employees e, departments d WHERE e.dept_no(+) = d.dept_no',
      );
      if (!result.success) return;
      expect(result.query.joins[0]?.type).toBe('RIGHT JOIN');
    });

    it('(+) が無いカンマ結合は INNER JOIN として読む', () => {
      const result = expectParseOk(
        'SELECT e.emp_no FROM employees e, departments d WHERE e.dept_no = d.dept_no',
      );
      if (!result.success) return;
      expect(result.query.joins[0]?.type).toBe('INNER JOIN');
      expect(result.query.joins[0]?.isOuterJoinOperator).toBeUndefined();
    });

    it('`( + )` のように空白が入っていても外部結合として読む', () => {
      const result = expectParseOk(
        'SELECT e.emp_no FROM employees e, departments d WHERE e.dept_no = d.dept_no ( + )',
      );
      if (!result.success) return;
      expect(result.query.joins[0]?.type).toBe('LEFT JOIN');
    });
  });

  describe('複数条件・複数テーブル', () => {
    it('同じテーブル対の複数条件を 1 本の JOIN にまとめる', () => {
      const result = expectParseOk(`SELECT a.id
FROM t_a a, t_b b
WHERE a.id = b.a_id(+)
  AND a.org = b.org(+)`);
      if (!result.success) return;

      expect(result.query.joins).toHaveLength(1);
      expect(result.query.joins[0]?.type).toBe('LEFT JOIN');
      expect(result.query.joins[0]?.condition).toContain('AND');
    });

    it('内部結合と外部結合が混在しても向きを取り違えない', () => {
      const result = expectParseOk(LEGACY_JOIN_SAMPLE_SQL);
      if (!result.success) return;

      const byTables = new Map(
        result.query.joins.map((join) => {
          const source = result.query.tables.find((t) => t.id === join.sourceId)?.alias;
          const target = result.query.tables.find((t) => t.id === join.targetId)?.alias;
          return [`${source}-${target}`, join.type];
        }),
      );
      expect(byTables.get('e-d')).toBe('INNER JOIN');
      expect(byTables.get('e-m')).toBe('LEFT JOIN');
      expect(byTables.get('e-b')).toBe('LEFT JOIN');
    });

    it('自己結合（同じ表を 2 回）でも別テーブルとして結合を作る', () => {
      const result = expectParseOk(
        'SELECT e.emp_no FROM employees e, employees m WHERE e.manager_no = m.emp_no(+)',
      );
      if (!result.success) return;

      expect(result.query.tables).toHaveLength(2);
      expect(result.query.joins).toHaveLength(1);
      expect(result.query.joins[0]?.type).toBe('LEFT JOIN');
    });
  });

  describe('結合条件にならない (+)', () => {
    it('リテラルとの比較に付いた (+) は JOIN にしない（外部結合側の絞り込み）', () => {
      const result = expectParseOk(`SELECT a.id
FROM t_a a, t_b b
WHERE a.id = b.a_id(+)
  AND b.status(+) = 'ACTIVE'`);
      if (!result.success) return;

      expect(result.query.joins).toHaveLength(1);
      expect(result.query.where).toBeDefined();
    });

    it('OR の下の結合条件は JOIN にしない（AND 連結のみ結合として扱う）', () => {
      const result = expectParseOk(
        'SELECT a.id FROM t_a a, t_b b WHERE a.id = b.a_id OR a.alt_id = b.a_id',
      );
      if (!result.success) return;

      expect(result.query.joins).toHaveLength(1);
      expect(result.query.joins[0]?.type).toBe('CROSS JOIN');
    });
  });

  describe('表示と位置情報', () => {
    it('条件ラベルに (+) を残す', () => {
      const result = expectParseOk(
        'SELECT e.emp_no FROM employees e, departments d WHERE e.dept_no = d.dept_no(+)',
      );
      if (!result.success) return;
      expect(result.query.joins[0]?.condition).toContain('(+)');
    });

    it('結合条件の sourceSpan が元 SQL の該当箇所を指す', () => {
      const sql = 'SELECT e.emp_no FROM employees e, departments d WHERE e.dept_no = d.dept_no(+)';
      const result = expectParseOk(sql);
      if (!result.success) return;

      const span = result.query.joins[0]?.sourceSpan;
      expect(span).toBeDefined();
      expect(sql.slice(span!.start, span!.end)).toContain('e.dept_no = d.dept_no');
    });

    it('エイリアス解決後も結合の向きが変わらない', () => {
      const result = expectParseOk(
        'SELECT e.emp_no FROM employees e, departments d WHERE e.dept_no = d.dept_no(+)',
      );
      if (!result.success) return;

      const resolved = applyAliasResolution(result.query, true, { keepSelfJoinAliases: true });
      expect(resolved.joins[0]?.type).toBe('LEFT JOIN');
    });

    it('作用説明が外部結合として説明する', () => {
      const result = expectParseOk(
        'SELECT e.emp_no FROM employees e, departments d WHERE e.dept_no = d.dept_no(+)',
      );
      if (!result.success) return;

      const effect = buildQueryEffect(result.query, 'japanese');
      const text = effect.sections
        .flatMap((section) => section.lines ?? [])
        .map((line) => line.text)
        .join('\n');
      expect(text).toContain('LEFT JOIN');
    });
  });
});

describe('JOIN 図での表示', () => {
  it('(+) 由来の辺は種別に (+) を併記する', () => {
    const result = parseOracleQuery(
      'SELECT e.emp_no FROM employees e, departments d WHERE e.dept_no = d.dept_no(+)',
    );
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(formatJoinDisplayType(result.query.joins[0]!)).toBe('LEFT JOIN（(+)）');
  });

  it('WHERE 由来の内部結合は種別に WHERE を併記する', () => {
    const result = parseOracleQuery(
      'SELECT e.emp_no FROM employees e, departments d WHERE e.dept_no = d.dept_no',
    );
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(formatJoinDisplayType(result.query.joins[0]!)).toBe('INNER JOIN（WHERE）');
  });

  it('FROM 句に書かれた JOIN には併記しない', () => {
    const result = parseOracleQuery(
      'SELECT e.emp_no FROM employees e JOIN departments d ON e.dept_no = d.dept_no',
    );
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(formatJoinDisplayType(result.query.joins[0]!)).toBe('INNER JOIN');
  });

  it('条件のないカンマ結合は CROSS JOIN のまま', () => {
    const result = parseOracleQuery('SELECT a.id FROM t_a a, t_b b WHERE a.flag = 1');
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(formatJoinDisplayType(result.query.joins[0]!)).toBe('CROSS JOIN');
  });
});
