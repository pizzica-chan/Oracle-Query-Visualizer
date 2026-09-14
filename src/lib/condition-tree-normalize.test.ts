import { describe, expect, it } from 'vitest';
import {
  DELETE_SAMPLE_SQL,
  parseOracleQuery,
  SAMPLE_SQL,
  UNION_SAMPLE_SQL,
  UPDATE_SAMPLE_SQL,
} from './parser';
import {
  collectConditionLeaves,
  countConditionNodes,
  normalizeConditionTree,
} from './condition-tree-normalize';
import type { ConditionNode, ParsedQuery } from './types';
import { assertParseInvariants } from './fixtures/parse-invariants';
import { SQL_TEST_CASES } from './fixtures/sql-cases';
import { analyzeEffectiveInnerJoins } from './join-effective-inner';
import { buildConditionEffectTree } from './query-effect';
import { collectSubqueriesFromCondition } from './query-utils';

function leafLabels(node: ConditionNode | undefined): string[] {
  return collectConditionLeaves(node)
    .map((n) => n.label)
    .sort();
}

function leafOrder(node: ConditionNode | undefined): string[] {
  return collectConditionLeaves(node).map((n) => n.label);
}

function leafIds(node: ConditionNode | undefined): string[] {
  return collectConditionLeaves(node)
    .map((n) => n.id)
    .sort();
}

function makeAnd(id: string, ...children: ConditionNode[]): ConditionNode {
  return { id, type: 'and', label: 'AND', children };
}

function makeOr(id: string, ...children: ConditionNode[]): ConditionNode {
  return { id, type: 'or', label: 'OR', children };
}

function leaf(id: string, label: string): ConditionNode {
  return { id, type: 'comparison', label, left: label, operator: '=', right: '1' };
}

function makeNot(id: string, child: ConditionNode): ConditionNode {
  return { id, type: 'not', label: 'NOT', children: [child] };
}

/** AND/OR グループの直下に同型グループがないこと（正規化後の不変条件） */
function assertNoNestedSameTypeGroups(node: ConditionNode | undefined): void {
  if (!node) return;

  if (node.type === 'and' || node.type === 'or') {
    for (const child of node.children ?? []) {
      expect(child.type).not.toBe(node.type);
    }
  }

  for (const child of node.children ?? []) {
    assertNoNestedSameTypeGroups(child);
  }
  if (node.nestedQuery) {
    walkQueryConditions(node.nestedQuery, assertNoNestedSameTypeGroups);
  }
}

function walkQueryConditions(
  query: ParsedQuery,
  visit: (node: ConditionNode | undefined) => void,
): void {
  visit(query.where);
  visit(query.having);
  for (const table of query.tables) {
    if (table.derivedQuery) walkQueryConditions(table.derivedQuery, visit);
  }
  for (const branch of query.unionBranches ?? []) {
    walkQueryConditions(branch.query, visit);
  }
  const walkNested = (node: ConditionNode | undefined) => {
    if (!node) return;
    if (node.nestedQuery) walkQueryConditions(node.nestedQuery, visit);
    for (const child of node.children ?? []) walkNested(child);
  };
  walkNested(query.where);
  walkNested(query.having);
}

function assertTopLevelAndIsFlat(where: ConditionNode | undefined, expectedChildCount: number): void {
  expect(where?.type).toBe('and');
  expect(where?.children).toHaveLength(expectedChildCount);
  for (const child of where?.children ?? []) {
    expect(child.type).not.toBe('and');
  }
}

function parseQuery(sql: string): ParsedQuery {
  const result = parseOracleQuery(sql);
  expect(result.success).toBe(true);
  if (!result.success) throw new Error(result.error.message);
  return result.query;
}

describe('normalizeConditionTree', () => {
  describe('単体: 構造変換', () => {
    it('左結合 AND チェーンを1つの AND グループにまとめる', () => {
      const tree = makeAnd(
        'and-1',
        makeAnd('and-2', makeAnd('and-3', leaf('a', 'A'), leaf('b', 'B')), leaf('c', 'C')),
        leaf('d', 'D'),
      );
      const normalized = normalizeConditionTree(tree);
      expect(normalized.type).toBe('and');
      expect(normalized.children?.map((c) => c.label)).toEqual(['A', 'B', 'C', 'D']);
      expect(countConditionNodes(normalized, 'and')).toBe(1);
    });

    it('左結合 OR チェーンを1つの OR グループにまとめる', () => {
      const tree = makeOr(
        'or-1',
        makeOr('or-2', makeOr('or-3', leaf('a', 'A'), leaf('b', 'B')), leaf('c', 'C')),
        leaf('d', 'D'),
      );
      const normalized = normalizeConditionTree(tree);
      expect(normalized.type).toBe('or');
      expect(normalized.children?.map((c) => c.label)).toEqual(['A', 'B', 'C', 'D']);
      expect(countConditionNodes(normalized, 'or')).toBe(1);
    });

    it('右側だけが連鎖する AND チェーンも1段にまとめる', () => {
      const tree = makeAnd(
        'and-1',
        leaf('a', 'A'),
        makeAnd('and-2', leaf('b', 'B'), makeAnd('and-3', leaf('c', 'C'), leaf('d', 'D'))),
      );
      const normalized = normalizeConditionTree(tree);
      expect(normalized.type).toBe('and');
      expect(normalized.children?.map((c) => c.label)).toEqual(['A', 'B', 'C', 'D']);
    });

    it('AND と OR を混在させた構造は型をまたいで潰さない', () => {
      const tree = makeAnd('and-1', leaf('a', 'A'), makeOr('or-1', leaf('b', 'B'), leaf('c', 'C')), leaf('d', 'D'));
      const normalized = normalizeConditionTree(tree);
      expect(normalized.children?.map((c) => c.type)).toEqual(['comparison', 'or', 'comparison']);
      expect(countConditionNodes(normalized, 'or')).toBe(1);
    });

    it('子1つの AND はラップを外す', () => {
      const inner = makeOr('or-1', leaf('a', 'A'), leaf('b', 'B'));
      const normalized = normalizeConditionTree(makeAnd('and-1', inner));
      expect(normalized.type).toBe('or');
    });

    it('子1つの OR もラップを外す', () => {
      const inner = makeAnd('and-1', leaf('a', 'A'), leaf('b', 'B'));
      const normalized = normalizeConditionTree(makeOr('or-1', inner));
      expect(normalized.type).toBe('and');
    });
  });

  describe('単体: NOT 境界', () => {
    it('NOT の内側だけまとめ、NOT をまたいでフラット化しない', () => {
      const tree = makeAnd(
        'and-1',
        leaf('a', 'A'),
        makeNot('not-1', makeAnd('and-2', leaf('b', 'B'), leaf('c', 'C'))),
      );
      const normalized = normalizeConditionTree(tree);
      expect(normalized.type).toBe('and');
      expect(normalized.children).toHaveLength(2);
      expect(normalized.children?.[0]?.label).toBe('A');
      expect(normalized.children?.[1]?.type).toBe('not');
      expect(normalized.children?.[1]?.children?.[0]?.type).toBe('and');
      expect(normalized.children?.[1]?.children?.[0]?.children?.map((c) => c.label)).toEqual(['B', 'C']);
    });

    it('NOT 内の OR にネストした AND は OR の子として残し、AND だけまとめる', () => {
      const tree = makeNot(
        'not-1',
        makeOr('or-1', leaf('d', 'D'), makeAnd('and-1', leaf('e', 'E'), leaf('f', 'F'))),
      );
      const normalized = normalizeConditionTree(tree);
      expect(normalized.type).toBe('not');
      const orNode = normalized.children?.[0];
      expect(orNode?.type).toBe('or');
      expect(orNode?.children?.map((c) => c.type)).toEqual(['comparison', 'and']);
      expect(orNode?.children?.[1]?.children?.map((c) => c.label)).toEqual(['E', 'F']);
      expect(countConditionNodes(orNode, 'and')).toBe(1);
    });

    it('NOT (A AND B) AND C では NOT グループが独立して残る', () => {
      const tree = makeAnd(
        'and-1',
        makeNot('not-1', makeAnd('and-2', leaf('a', 'A'), leaf('b', 'B'))),
        leaf('c', 'C'),
      );
      const normalized = normalizeConditionTree(tree);
      expect(normalized.type).toBe('and');
      expect(normalized.children?.map((c) => c.type)).toEqual(['not', 'comparison']);
      expect(normalized.children?.[0]?.children?.[0]?.children?.map((c) => c.label)).toEqual(['A', 'B']);
    });
  });

  describe('単体: 不変条件', () => {
    it('葉ノードの label 集合は正規化前後で一致する', () => {
      const tree = makeAnd(
        'and-1',
        makeAnd('and-2', makeAnd('and-3', leaf('a', 'A'), leaf('b', 'B')), leaf('c', 'C')),
        makeOr('or-1', leaf('d', 'D'), leaf('e', 'E')),
      );
      expect(leafLabels(normalizeConditionTree(tree))).toEqual(leafLabels(tree));
    });

    it('葉ノードの出現順序を保つ', () => {
      const tree = makeAnd(
        'and-1',
        makeAnd('and-2', leaf('1', 'first'), leaf('2', 'second')),
        makeAnd('and-3', leaf('3', 'third'), leaf('4', 'fourth')),
      );
      expect(leafOrder(normalizeConditionTree(tree))).toEqual(['first', 'second', 'third', 'fourth']);
    });

    it('葉ノード ID は正規化で失われない', () => {
      const tree = makeAnd(
        'and-1',
        makeAnd('and-2', leaf('id-a', 'A'), leaf('id-b', 'B')),
        leaf('id-c', 'C'),
      );
      expect(leafIds(normalizeConditionTree(tree))).toEqual(leafIds(tree));
    });

    it('二重適用しても結果が変わらない', () => {
      const tree = makeAnd('and-1', makeAnd('and-2', leaf('a', 'A'), leaf('b', 'B')), leaf('c', 'C'));
      const once = normalizeConditionTree(tree);
      const twice = normalizeConditionTree(once);
      expect(twice).toEqual(once);
    });

    it('正規化後は同型グループの冗長入れ子がない', () => {
      const tree = makeAnd(
        'and-1',
        makeAnd('and-2', leaf('a', 'A'), leaf('b', 'B')),
        makeOr('or-1', makeOr('or-2', leaf('c', 'C'), leaf('d', 'D')), leaf('e', 'E')),
      );
      assertNoNestedSameTypeGroups(normalizeConditionTree(tree));
    });
  });

  describe('解析結果との統合', () => {
    it('SAMPLE_SQL の WHERE はトップレベル AND 1 つに7条件が並ぶ', () => {
      const query = parseQuery(SAMPLE_SQL);
      assertTopLevelAndIsFlat(query.where, 7);

      const existsNode = query.where?.children?.find((c) => c.type === 'exists');
      const existsWhere = existsNode?.nestedQuery?.where;
      expect(existsWhere?.type).toBe('and');
      expect(existsWhere?.children).toHaveLength(3);
      expect(countConditionNodes(existsWhere, 'and')).toBe(1);

      const orNode = query.where?.children?.find((c) => c.type === 'or');
      expect(orNode?.children?.map((c) => c.type)).toEqual(['comparison', 'like']);

      expect(() => assertParseInvariants(query, 'SAMPLE_SQL')).not.toThrow();
    });

    it('SAMPLE_SQL の HAVING はサブクエリ比較1本のまま', () => {
      const query = parseQuery(SAMPLE_SQL);
      expect(query.having?.type).toBe('subquery');
      expect(query.having?.label).toContain('SUM(oi.quantity)');
      assertNoNestedSameTypeGroups(query.having);
    });

    it('深くネストした WHERE をフラットな AND 7 条件として解釈する', () => {
      const query = parseQuery(`
        SELECT id FROM t WHERE
          a = 1
          AND (b = 2 OR c = 3)
          AND NOT (d = 4 OR (e = 5 AND f = 6))
          AND g IN (10, 20, 30)
          AND h NOT IN (1, 2)
          AND i BETWEEN 1 AND 99
          AND j NOT BETWEEN 0 AND 5
      `);
      assertTopLevelAndIsFlat(query.where, 7);
      // NOT 内の AND はトップレベルには出ないが、NOT 配下には1つ残る
      expect(countConditionNodes(query.where, 'and')).toBe(2);

      const notNode = query.where?.children?.find((c) => c.type === 'not');
      expect(notNode).toBeDefined();
      const orInsideNot = notNode?.children?.[0];
      expect(orInsideNot?.type).toBe('or');
      expect(orInsideNot?.children?.map((c) => c.type)).toEqual(['comparison', 'and']);
      expect(orInsideNot?.children?.[1]?.children?.map((c) => c.label)).toEqual(['e = 5', 'f = 6']);
    });

    it('括弧だらけの WHERE も AND 2 条件に正規化する', () => {
      const query = parseQuery('SELECT id FROM t WHERE (((((status = 1))))) AND ((((type = 2))))');
      assertTopLevelAndIsFlat(query.where, 2);
    });

    it('連続比較演算子の WHERE も AND 1 段にまとめる', () => {
      const query = parseQuery(
        'SELECT id FROM t WHERE a <> 0 AND b != 1 AND c >= 2 AND d <= 3 AND e > 4 AND f < 5',
      );
      assertTopLevelAndIsFlat(query.where, 6);
    });

    it.each([
      ['SELECT', SAMPLE_SQL],
      ['UPDATE', UPDATE_SAMPLE_SQL],
      ['DELETE', DELETE_SAMPLE_SQL],
      ['UNION', UNION_SAMPLE_SQL],
    ] as const)('%s サンプル全体で同型グループの冗長入れ子がない', (_label, sql) => {
      const query = parseQuery(sql);
      walkQueryConditions(query, assertNoNestedSameTypeGroups);
    });
  });

  describe('SQL フィクスチャ横断', () => {
    it.each(
      SQL_TEST_CASES.filter((c) => c.expectSuccess && /WHERE|HAVING|AND|OR|NOT/i.test(c.sql)).map((c) => [
        c.name,
        c.sql,
      ]),
    )('成功ケース「%s」で WHERE/HAVING が正規化されている', (_name, sql) => {
      const query = parseQuery(sql);
      walkQueryConditions(query, assertNoNestedSameTypeGroups);
      expect(() => assertParseInvariants(query, _name)).not.toThrow();
    });
  });

  describe('下流処理との互換', () => {
    it('SAMPLE_SQL の実質 INNER JOIN 分析結果は変わらない', () => {
      const query = parseQuery(SAMPLE_SQL);
      const analysis = analyzeEffectiveInnerJoins(query);
      const oiJoin = query.joins.find((j) => j.condition.includes('oi.order_id'));
      const oiAnalysis = analysis.find((a) => a.joinId === oiJoin?.id);
      expect(oiAnalysis?.reasons.map((r) => r.label).sort()).toMatchSnapshot();
    });

    it('SAMPLE_SQL のサブクエリ収集件数は変わらない', () => {
      const query = parseQuery(SAMPLE_SQL);
      expect(collectSubqueriesFromCondition(query.where).length).toBeGreaterThanOrEqual(3);
      expect(collectSubqueriesFromCondition(query.having).length).toBeGreaterThanOrEqual(1);
    });

    it('深ネスト WHERE の buildConditionEffectTree はトップ AND 7 グループを維持する', () => {
      const query = parseQuery(`
        SELECT id FROM t WHERE
          a = 1
          AND (b = 2 OR c = 3)
          AND NOT (d = 4 OR (e = 5 AND f = 6))
          AND g IN (10, 20, 30)
          AND h NOT IN (1, 2)
          AND i BETWEEN 1 AND 99
          AND j NOT BETWEEN 0 AND 5
      `);
      const effectRoot = buildConditionEffectTree(query.where!);
      expect(effectRoot.type).toBe('and');
      expect(effectRoot.children).toHaveLength(7);
      expect(collectConditionLeaves(query.where)).toHaveLength(10);
    });

    it('SAMPLE_SQL の buildConditionEffectTree も WHERE 7 グループを維持する', () => {
      const query = parseQuery(SAMPLE_SQL);
      const effectRoot = buildConditionEffectTree(query.where!);
      expect(effectRoot.type).toBe('and');
      expect(effectRoot.children).toHaveLength(7);
      expect(collectConditionLeaves(query.where)).toHaveLength(8);
    });
  });
});
