import { describe, expect, it } from 'vitest';
import {
  parseOracleQuery,
  SAMPLE_SQL,
  UPDATE_SAMPLE_SQL,
  DELETE_SAMPLE_SQL,
  UNION_SAMPLE_SQL,
} from './parser';
import { assertParseInvariants } from './fixtures/parse-invariants';
import { SQL_TEST_CASES, collectConditionTypes, tableNames } from './fixtures/sql-cases';
import type { ConditionNode } from './types';
import { collectAllNestedQueries } from './query-utils';

function flattenConditionLabels(node: ConditionNode | undefined): string[] {
  if (!node) return [];
  return [node.label, ...(node.children ?? []).flatMap(flattenConditionLabels)];
}

const ALL_CATEGORIES = [
  'basic',
  'oracle',
  'complex',
  'dirty',
  'edge',
  'update',
  'delete',
  'union',
  'subquery',
  'regression',
  'error',
] as const;

describe('parseOracleQuery', () => {
  describe('SAMPLE_SQL（ゴールデン）', () => {
    it('サンプルクエリをエラーなく解析し構造が一致する', () => {
      const result = parseOracleQuery(SAMPLE_SQL);
      expect(result.success).toBe(true);
      if (!result.success) return;

      expect(result.query.statementType).toBe('SELECT');
      expect(result.query.tables).toHaveLength(7);
      expect(result.query.joins).toHaveLength(6);
      expect(result.query.tables.some((t) => t.isDerived)).toBe(true);
      expect(result.query.where?.type).toBe('and');
      expect(result.query.having).toBeDefined();
      expect(result.query.limit).toBe('100');
      expect(result.query.groupBy).toHaveLength(9);
      expect(result.query.orderBy).toHaveLength(2);

      const wTypes = collectConditionTypes(result.query.where);
      expect(wTypes).toContain('or');
      expect(wTypes).toContain('like');
      expect(wTypes).toContain('in');
      expect(wTypes).toContain('between');
      expect(wTypes).toContain('exists');
      expect(result.query.having?.label).toContain('SUM(oi.quantity)');

      const nested = collectAllNestedQueries(result.query);
      expect(nested.length).toBeGreaterThanOrEqual(4);
      expect(nested.some((q) => q.tables.some((t) => t.table === 'payments'))).toBe(true);
      expect(nested.some((q) => q.tables.some((t) => t.table === 'banned_users'))).toBe(true);

      expect(result.query.where?.sourceSpan).toBeDefined();
      expect(result.query.tables[0]?.sourceSpan).toBeDefined();
      expect(result.query.joins[0]?.sourceSpan).toBeDefined();
      expect(result.query.columns[0]?.sourceSpan).toBeDefined();
      expect(result.query.groupBy[0]?.sourceSpan).toBeDefined();
      expect(result.query.orderBy[0]?.sourceSpan).toBeDefined();
      expect(result.query.limitSpan).toBeDefined();

      expect(() => assertParseInvariants(result.query, 'SAMPLE_SQL')).not.toThrow();
    });
  });

  describe('UPDATE_SAMPLE_SQL（ゴールデン）', () => {
    it('UPDATEサンプルをエラーなく解析し構造が一致する', () => {
      const result = parseOracleQuery(UPDATE_SAMPLE_SQL);
      expect(result.success).toBe(true);
      if (!result.success) return;

      expect(result.query.statementType).toBe('UPDATE');
      expect(result.query.tables).toHaveLength(1);
      expect(result.query.joins).toHaveLength(0);
      expect(result.query.setClauses).toHaveLength(3);
      expect(result.query.where?.type).toBe('and');
      expect(result.query.setClauses?.every((s) => s.table === 'u')).toBe(true);
      // 相関サブクエリを値に持つ SET
      expect(result.query.setClauses?.some((s) => s.value.includes('SELECT'))).toBe(true);
      expect(collectConditionTypes(result.query.where)).toContain('exists');

      expect(() => assertParseInvariants(result.query, 'UPDATE_SAMPLE_SQL')).not.toThrow();
    });
  });

  describe('DELETE_SAMPLE_SQL（ゴールデン）', () => {
    it('DELETEサンプルをエラーなく解析し構造が一致する', () => {
      const result = parseOracleQuery(DELETE_SAMPLE_SQL);
      expect(result.success).toBe(true);
      if (!result.success) return;

      expect(result.query.statementType).toBe('DELETE');
      expect(result.query.tables).toHaveLength(1);
      expect(result.query.joins).toHaveLength(0);
      expect(result.query.deleteTargets).toHaveLength(1);
      expect(result.query.deleteTargets?.[0]?.name).toBe('order_items');
      expect(result.query.where?.type).toBe('and');

      const wTypes = collectConditionTypes(result.query.where);
      expect(wTypes).toContain('is_null');
      expect(wTypes).toContain('exists');
      expect(wTypes).toContain('in');
      const labels = flattenConditionLabels(result.query.where);
      expect(labels.some((l) => l.toUpperCase().includes('NOT IN'))).toBe(true);

      expect(() => assertParseInvariants(result.query, 'DELETE_SAMPLE_SQL')).not.toThrow();
    });
  });

  describe('UNION_SAMPLE_SQL（ゴールデン）', () => {
    it('UNIONサンプルを全ブランチ解析し構造が一致する', () => {
      const result = parseOracleQuery(UNION_SAMPLE_SQL);
      expect(result.success).toBe(true);
      if (!result.success) return;

      expect(result.query.unionBranches).toHaveLength(3);
      expect(result.query.unionBranches?.[1]?.operator).toBe('UNION ALL');
      expect(result.query.unionBranches?.[2]?.operator).toBe('MINUS');
      expect(tableNames(result.query).join()).toBe('users,orders,order_items,products');
      expect(result.query.unionBranches?.[0]?.query.joins.length).toBeGreaterThanOrEqual(3);
      expect(result.query.unionBranches?.[1]?.query.tables[0]?.table).toBe('archived_users');
      expect(result.query.unionBranches?.[1]?.query.joins.length).toBeGreaterThanOrEqual(1);
      expect(result.query.unionBranches?.[2]?.query.tables[0]?.table).toBe('guest_users');
      expect(result.query.unionBranches?.[2]?.query.joins.length).toBeGreaterThanOrEqual(1);

      const branch2Where = result.query.unionBranches?.[2]?.query.where;
      const types = collectConditionTypes(branch2Where);
      expect(types).toContain('exists');
      expect(types).toContain('comparison');

      expect(() => assertParseInvariants(result.query, 'UNION_SAMPLE_SQL')).not.toThrow();

      for (const branch of result.query.unionBranches ?? []) {
        expect(branch.sourceSpan?.start).toBeGreaterThanOrEqual(0);
        expect(branch.sourceSpan?.end).toBeGreaterThan(branch.sourceSpan!.start);
        expect(UNION_SAMPLE_SQL.slice(branch.sourceSpan!.start, branch.sourceSpan!.end)).toMatch(
          /SELECT/i,
        );
      }
    });
  });

  it('IN / EXISTS 内サブクエリに sourceSpan を付与する', () => {
    const sql =
      "SELECT id FROM users u WHERE u.id IN (SELECT user_id FROM orders WHERE total > 100)";
    const result = parseOracleQuery(sql);
    expect(result.success).toBe(true);
    if (!result.success) return;

    const inNode = result.query.where?.children?.[0] ?? result.query.where;
    expect(inNode?.type).toBe('in');
    const nested = inNode?.nestedQuery;
    expect(nested?.sourceSpan).toBeDefined();
    expect(sql.slice(nested!.sourceSpan!.start, nested!.sourceSpan!.end)).toMatch(/SELECT/i);

    const existsResult = parseOracleQuery(
      'SELECT id FROM users u WHERE EXISTS (SELECT 1 FROM orders o WHERE o.user_id = u.id)',
    );
    expect(existsResult.success).toBe(true);
    if (!existsResult.success) return;
    const existsNode = existsResult.query.where;
    expect(existsNode?.nestedQuery?.sourceSpan).toBeDefined();
  });

  describe.each(ALL_CATEGORIES)('category: %s', (category) => {
    const cases = SQL_TEST_CASES.filter((c) => c.category === category);

    it.each(cases)('$name', (testCase) => {
      const result = parseOracleQuery(testCase.sql);

      if (testCase.expectSuccess) {
        expect(result.success, `parse failed: ${!result.success ? result.error.message : ''}`).toBe(true);
        if (!result.success) return;
        testCase.assert?.(result.query);
        expect(() => assertParseInvariants(result.query, testCase.name)).not.toThrow();
      } else {
        expect(result.success).toBe(false);
        if (!result.success && testCase.errorContains) {
          expect(result.error.message).toContain(testCase.errorContains);
        }
      }
    });
  });

  describe('JOIN条件の詳細', () => {
    it('各JOINに ON 条件文字列が付く', () => {
      const result = parseOracleQuery(`
        SELECT * FROM a
        INNER JOIN b ON a.id = b.a_id
        LEFT JOIN c ON c.b_id = b.id
      `);
      expect(result.success).toBe(true);
      if (!result.success) return;

      expect(result.query.joins[0]?.condition).toBe('a.id = b.a_id');
      expect(result.query.joins[0]?.type).toBe('INNER JOIN');
      expect(result.query.joins[1]?.type).toBe('LEFT JOIN');
      expect(result.query.joins[0]?.sourceId).not.toBe(result.query.joins[0]?.targetId);
    });

    it('JOIN の source/target は実在テーブル ID を指す', () => {
      const result = parseOracleQuery('SELECT * FROM a JOIN b ON a.id = b.a_id JOIN c ON c.b_id = b.id');
      expect(result.success).toBe(true);
      if (!result.success) return;

      const ids = new Set(result.query.tables.map((t) => t.id));
      for (const join of result.query.joins) {
        expect(ids.has(join.sourceId)).toBe(true);
        expect(ids.has(join.targetId)).toBe(true);
      }
    });
  });

  describe('行制限句（OFFSET / FETCH）', () => {
    it('FETCH FIRST … ROWS ONLY を limit として読む', () => {
      const result = parseOracleQuery('SELECT id FROM t ORDER BY id FETCH FIRST 50 ROWS ONLY');
      expect(result.success).toBe(true);
      if (!result.success) return;
      expect(result.query.limit).toBe('50');
      expect(result.query.offset).toBeUndefined();
      expect(result.query.rowLimitSpan).toBeDefined();
    });

    it('OFFSET … ROWS FETCH NEXT … ROWS ONLY を offset と limit に分解する', () => {
      const result = parseOracleQuery(
        'SELECT id FROM t ORDER BY id OFFSET 10 ROWS FETCH NEXT 50 ROWS ONLY',
      );
      expect(result.success).toBe(true);
      if (!result.success) return;
      expect(result.query.limit).toBe('50');
      expect(result.query.offset).toBe('10');
    });

    it('WITH TIES と PERCENT を区別する', () => {
      const result = parseOracleQuery(
        'SELECT id FROM t ORDER BY score DESC FETCH FIRST 10 PERCENT ROWS WITH TIES',
      );
      expect(result.success).toBe(true);
      if (!result.success) return;
      expect(result.query.limit).toBe('10');
      expect(result.query.rowLimitPercent).toBe(true);
      expect(result.query.rowLimitWithTies).toBe(true);
    });

    it('行制限句の span は元 SQL 上の位置を指す', () => {
      const sql = 'SELECT id FROM t ORDER BY id FETCH FIRST 50 ROWS ONLY';
      const result = parseOracleQuery(sql);
      expect(result.success).toBe(true);
      if (!result.success) return;
      const span = result.query.rowLimitSpan!;
      expect(sql.slice(span.start, span.end)).toBe('FETCH FIRST 50 ROWS ONLY');
    });
  });

  describe('WHERE条件ツリー', () => {
    it('LIKE条件は like タイプになる', () => {
      const result = parseOracleQuery("SELECT id FROM t WHERE name LIKE '%foo%'");
      expect(result.success).toBe(true);
      if (!result.success) return;

      const labels = flattenConditionLabels(result.query.where);
      expect(labels.some((l) => l.includes('LIKE'))).toBe(true);
      expect(result.query.where?.type).toBe('like');
    });

    it('IN条件は in タイプになる', () => {
      const result = parseOracleQuery('SELECT id FROM t WHERE status IN (1, 2, 3)');
      expect(result.success).toBe(true);
      if (!result.success) return;
      expect(result.query.where?.type).toBe('in');
    });
  });

  describe('テーブルメタデータ', () => {
    it('エイリアスが displayName に反映される', () => {
      const result = parseOracleQuery('SELECT u.id FROM users u');
      expect(result.success).toBe(true);
      if (!result.success) return;
      expect(result.query.tables[0]?.alias).toBe('u');
      expect(result.query.tables[0]?.displayName).toBe('u');
    });

    it('スキーマ付きテーブル名を解釈する', () => {
      const result = parseOracleQuery('SELECT id FROM mydb.users');
      expect(result.success).toBe(true);
      if (!result.success) return;
      expect(result.query.tables[0]?.schema).toBe('mydb');
      expect(result.query.tables[0]?.table).toBe('users');
    });
  });

  it('バッククォート付き列参照を正しく文字列化する', () => {
    const result = parseOracleQuery('SELECT `u`.`id`, `u`.`name` FROM users u');
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.query.columns.map((c) => c.expression)).toEqual(['u.id', 'u.name']);
  });
});

describe('parseOracleQuery 統計', () => {
  it('成功ケースが一定数以上ある', () => {
    const successCount = SQL_TEST_CASES.filter((c) => c.expectSuccess).length;
    expect(successCount).toBeGreaterThanOrEqual(45);
  });

  it('失敗ケースが一定数以上ある', () => {
    const errorCount = SQL_TEST_CASES.filter((c) => !c.expectSuccess).length;
    expect(errorCount).toBeGreaterThanOrEqual(5);
  });

  it('union / subquery / regression カテゴリが存在する', () => {
    const cats = new Set(SQL_TEST_CASES.map((c) => c.category));
    expect(cats.has('union')).toBe(true);
    expect(cats.has('subquery')).toBe(true);
    expect(cats.has('regression')).toBe(true);
  });
});
