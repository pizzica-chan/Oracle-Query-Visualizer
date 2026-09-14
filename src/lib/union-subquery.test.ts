import { describe, expect, it } from 'vitest';
import { assertParseInvariants } from './fixtures/parse-invariants';
import { collectConditionTypes, findCondition } from './fixtures/sql-cases';
import {
  parseOracleQuery,
  UNION_SAMPLE_SQL,
  SAMPLE_SQL,
  UPDATE_SAMPLE_SQL,
  DELETE_SAMPLE_SQL,
} from './parser';
import { collectAllNestedQueries, countNestedItems, hasUnion } from './query-utils';

describe('UNION / サブクエリ', () => {
  it('UNION_SAMPLE_SQL を全ブランチ解析する', () => {
    const result = parseOracleQuery(UNION_SAMPLE_SQL);
    expect(result.success).toBe(true);
    if (!result.success) return;

    expect(hasUnion(result.query)).toBe(true);
    expect(result.query.unionBranches?.length).toBe(3);
    expect(result.query.unionBranches?.[1]?.operator).toBe('UNION ALL');
    expect(result.query.unionBranches?.[2]?.operator).toBe('MINUS');
    expect(() => assertParseInvariants(result.query)).not.toThrow();
  });

  it('各 UNION ブランチは独立した ParsedQuery を持つ', () => {
    const result = parseOracleQuery(UNION_SAMPLE_SQL);
    expect(result.success).toBe(true);
    if (!result.success) return;

    const branches = result.query.unionBranches ?? [];
    const tableSets = branches.map((b) => b.query.tables.map((t) => t.table).join(','));
    expect(tableSets[0]).toBe('users,orders,order_items,products');
    expect(tableSets[1]).toContain('archived_users');
    expect(tableSets[2]).toContain('guest_users');
    expect(branches[0]?.query.joins.length).toBeGreaterThanOrEqual(3);
    expect(branches[1]?.query.tables.some((t) => t.isDerived)).toBe(true);
    expect(new Set(branches.map((b) => b.id)).size).toBe(3);
  });

  it('IN (SELECT ...) のサブクエリを展開する', () => {
    const result = parseOracleQuery(
      'SELECT id FROM users u WHERE u.id IN (SELECT user_id FROM orders WHERE total > 100)',
    );
    expect(result.success).toBe(true);
    if (!result.success) return;

    const inNode = findCondition(result.query.where, (n) => n.type === 'in');
    expect(inNode?.nestedQuery).toBeDefined();
    expect(inNode?.nestedQuery?.tables[0]?.table).toBe('orders');
    expect(inNode?.nestedQuery?.where).toBeDefined();
  });

  it('NOT IN (SELECT ...) のサブクエリを展開する', () => {
    const result = parseOracleQuery(
      'SELECT id FROM users WHERE id NOT IN (SELECT user_id FROM banned_users)',
    );
    expect(result.success).toBe(true);
    if (!result.success) return;

    const inNode = findCondition(
      result.query.where,
      (n) => n.type === 'in' && n.operator === 'NOT IN',
    );
    expect(inNode?.nestedQuery?.tables[0]?.table).toBe('banned_users');
  });

  it('EXISTS サブクエリを展開する', () => {
    const result = parseOracleQuery(
      'SELECT id FROM users u WHERE EXISTS (SELECT 1 FROM orders o WHERE o.user_id = u.id)',
    );
    expect(result.success).toBe(true);
    if (!result.success) return;

    const nested = collectAllNestedQueries(result.query);
    expect(nested.length).toBeGreaterThanOrEqual(1);
    expect(nested.some((q) => q.tables.some((t) => t.table === 'orders'))).toBe(true);
  });

  it('NOT EXISTS サブクエリを展開する', () => {
    const result = parseOracleQuery(
      'SELECT id FROM users u WHERE NOT EXISTS (SELECT 1 FROM orders o WHERE o.user_id = u.id)',
    );
    expect(result.success).toBe(true);
    if (!result.success) return;

    const ex = findCondition(
      result.query.where,
      (n) => n.type === 'exists' && n.label.toUpperCase().includes('NOT'),
    );
    expect(ex?.nestedQuery?.tables[0]?.table).toBe('orders');
  });

  it('スカラー比較サブクエリを展開する', () => {
    const result = parseOracleQuery(
      'SELECT id FROM users WHERE score = (SELECT MAX(score) FROM users)',
    );
    expect(result.success).toBe(true);
    if (!result.success) return;

    const sq = findCondition(result.query.where, (n) => n.type === 'subquery');
    expect(sq?.operator).toBe('=');
    expect(sq?.nestedQuery?.columns.some((c) => c.expression.includes('MAX'))).toBe(true);
  });

  it('派生テーブルを展開する', () => {
    const result = parseOracleQuery(
      'SELECT * FROM (SELECT id FROM users) t JOIN orders o ON o.uid = t.id',
    );
    expect(result.success).toBe(true);
    if (!result.success) return;

    const derived = result.query.tables.find((t) => t.isDerived);
    expect(derived).toBeDefined();
    expect(derived?.derivedQuery?.tables[0]?.table).toBe('users');
    expect(result.query.joins).toHaveLength(1);
  });

  it('UNION ブランチ内の NOT EXISTS も収集する', () => {
    const result = parseOracleQuery(UNION_SAMPLE_SQL);
    expect(result.success).toBe(true);
    if (!result.success) return;

    const nested = collectAllNestedQueries(result.query);
    expect(nested.some((q) => q.tables.some((t) => t.table === 'orders'))).toBe(true);

    const branch2 = result.query.unionBranches?.[2]?.query;
    expect(collectConditionTypes(branch2?.where)).toContain('exists');
  });

  it('全サンプル SQL が UNION/サブクエリ検出可能', () => {
    const samples = [
      { sql: SAMPLE_SQL, expectUnion: false, expectSubqueries: true },
      { sql: UPDATE_SAMPLE_SQL, expectUnion: false, expectSubqueries: false },
      { sql: DELETE_SAMPLE_SQL, expectUnion: false, expectSubqueries: false },
      { sql: UNION_SAMPLE_SQL, expectUnion: true, expectSubqueries: true },
    ];

    for (const { sql, expectUnion, expectSubqueries } of samples) {
      const result = parseOracleQuery(sql);
      expect(result.success).toBe(true);
      if (!result.success) continue;
      expect(hasUnion(result.query)).toBe(expectUnion);
      if (expectSubqueries) {
        expect(collectAllNestedQueries(result.query).length).toBeGreaterThan(0);
      }
      expect(() => assertParseInvariants(result.query)).not.toThrow();
    }
  });

  it('countNestedItems が UNION サンプルで正しい数を返す', () => {
    const result = parseOracleQuery(UNION_SAMPLE_SQL);
    expect(result.success).toBe(true);
    if (!result.success) return;

    const { unions, subqueries } = countNestedItems(result.query);
    expect(unions).toBe(3);
    expect(subqueries).toBeGreaterThanOrEqual(1);
  });
});
