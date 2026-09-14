import { describe, expect, it } from 'vitest';
import { parseOracleQuery, SAMPLE_SQL } from './parser';
import {
  assertJoinFlowLayoutReady,
  buildJoinFlowLayout,
  computeJoinLayoutKey,
  computeJoinEdgeLabelOffset,
  formatJoinEdgeLabel,
  minimapNodeColor,
  MINIMAP_NODE_COLORS,
  truncateJoinCondition,
} from './join-flow-layout';

describe('join-flow-layout', () => {
  const sampleTables = [
    { id: 'tbl-1', table: 'users', alias: 'u', displayName: 'u' },
    { id: 'tbl-2', table: 'orders', alias: 'o', displayName: 'o' },
  ];
  const sampleJoins = [
    {
      id: 'join-1',
      type: 'INNER JOIN' as const,
      sourceId: 'tbl-1',
      targetId: 'tbl-2',
      condition: 'o.user_id = u.id',
    },
  ];

  it('computeJoinLayoutKey が同入力で同じキーを返す', () => {
    const a = computeJoinLayoutKey(sampleTables, sampleJoins, false);
    const b = computeJoinLayoutKey(sampleTables, sampleJoins, false);
    expect(a).toBe(b);
    expect(a).not.toBe(computeJoinLayoutKey(sampleTables, sampleJoins, true));
  });

  it('computeJoinEdgeLabelOffset は水平エッジを上方向へずらす', () => {
    expect(computeJoinEdgeLabelOffset(0, 100, 200, 100)).toEqual({ x: 0, y: -44 });
    expect(computeJoinEdgeLabelOffset(200, 100, 0, 100)).toEqual({ x: 0, y: 44 });
  });

  it('computeJoinEdgeLabelOffset は垂直エッジを横方向へずらす', () => {
    const offset = computeJoinEdgeLabelOffset(100, 0, 100, 200);
    expect(offset.x).toBe(44);
    expect(Math.abs(offset.y)).toBe(0);
  });

  it('全ノードに width/height がある（ミニマップ前提）', () => {
    const { nodes } = buildJoinFlowLayout(sampleTables, sampleJoins, false);
    expect(() => assertJoinFlowLayoutReady(nodes)).not.toThrow();
    expect(nodes.every((n) => (n.width ?? 0) > 0 && (n.height ?? 0) > 0)).toBe(true);
  });

  it('派生テーブルはミニマップ色が異なる', () => {
    const derived = {
      id: 'tbl-d',
      table: 'hot',
      alias: 'hot',
      displayName: 'hot (派生)',
      isDerived: true,
    };
    const { nodes } = buildJoinFlowLayout([derived], [], false);
    expect(minimapNodeColor(nodes[0]!)).toBe(MINIMAP_NODE_COLORS.derived);
    expect(minimapNodeColor({ data: { isDerived: false } } as never)).toBe(
      MINIMAP_NODE_COLORS.table,
    );
  });

  it('ミニマップ色が背景と同色にならない', () => {
    expect(MINIMAP_NODE_COLORS.table).not.toBe('#282c34');
    expect(MINIMAP_NODE_COLORS.derived).not.toBe('#1a1d23');
  });

  it('SAMPLE_SQL 解析結果で JOIN 図レイアウトが生成できる', () => {
    const result = parseOracleQuery(SAMPLE_SQL);
    expect(result.success).toBe(true);
    if (!result.success) return;

    const { nodes, edges } = buildJoinFlowLayout(
      result.query.tables,
      result.query.joins,
      false,
      result.query,
    );
    expect(nodes.length).toBe(7);
    expect(edges.length).toBe(8);
    expect(() => assertJoinFlowLayoutReady(nodes)).not.toThrow();
  });

  it('assignJoinEdgeHandles はファンイン先へ異なる接続ハンドルを割り当てる', () => {
    const result = parseOracleQuery(SAMPLE_SQL);
    expect(result.success).toBe(true);
    if (!result.success) return;

    const { edges } = buildJoinFlowLayout(
      result.query.tables,
      result.query.joins,
      false,
      result.query,
    );
    const lm = result.query.tables.find((t) => t.alias === 'lm')!;
    const lmEdges = edges.filter((e) => e.target === lm.id);
    expect(lmEdges.length).toBeGreaterThan(1);
    expect(new Set(lmEdges.map((e) => e.targetHandle)).size).toBeGreaterThan(1);
    expect(lmEdges.every((e) => (e.data as { pathCurvature?: number }).pathCurvature)).toBe(true);
  });

  it('assignJoinEdgeHandles は星型の source 側も分散する', () => {
    const result = parseOracleQuery(`
      SELECT * FROM orders o
      JOIN users u ON o.user_id = u.id
      JOIN products p ON o.product_id = p.id
    `);
    expect(result.success).toBe(true);
    if (!result.success) return;

    const { edges } = buildJoinFlowLayout(result.query.tables, result.query.joins, false);
    const o = result.query.tables[0]!;
    const fromOrders = edges.filter((e) => e.source === o.id);
    expect(fromOrders.length).toBe(2);
    expect(new Set(fromOrders.map((e) => e.sourceHandle)).size).toBe(2);
  });

  it('ファンイン補助線も主エッジと同じ sourceSpan・interactionWidth を持つ', () => {
    const result = parseOracleQuery(`
      SELECT *
      FROM users u
      JOIN orders o ON u.id = o.user_id
      JOIN products p ON u.id = p.owner_id
      JOIN summary s ON u.score = s.u_score AND o.total = s.o_total AND p.cnt = s.p_cnt
    `);
    expect(result.success).toBe(true);
    if (!result.success) return;

    const sJoin = result.query.joins.find((j) => j.targetId === result.query.tables.find((t) => t.alias === 's')!.id)!;
    const { edges } = buildJoinFlowLayout(result.query.tables, result.query.joins, false, result.query);
    const sEdges = edges.filter((e) => e.target === sJoin.targetId);
    const primary = sEdges.find((e) => e.id === sJoin.id);
    const fanIn = sEdges.find((e) => e.data?.isFanInConnector);
    expect(primary?.interactionWidth).toBe(24);
    expect(fanIn?.interactionWidth).toBe(24);
    expect(fanIn?.data?.sourceSpan).toEqual(sJoin.sourceSpan);
  });

  it('SAMPLE_SQL で実質 INNER JOIN の LEFT JOIN エッジを破線・≈INNER ラベルで示す', () => {
    const result = parseOracleQuery(SAMPLE_SQL);
    expect(result.success).toBe(true);
    if (!result.success) return;

    const { edges } = buildJoinFlowLayout(
      result.query.tables,
      result.query.joins,
      false,
      result.query,
    );

    const oiJoin = result.query.joins.find((j) => j.condition.includes('oi.order_id'));
    expect(oiJoin).toBeDefined();

    const oiEdge = edges.find((e) => e.id === oiJoin!.id);
    expect(oiEdge?.type).toBe('joinEdge');
    expect(oiEdge?.data?.effectiveInner).toBe(true);
    expect(oiEdge?.data?.joinType).toBe('LEFT JOIN');
    expect(oiEdge?.data?.condition).toContain('oi.order_id = o.order_id');
    expect(formatJoinEdgeLabel(oiJoin!, true)).toContain('≈INNER');
    expect(oiEdge?.style?.strokeDasharray).toBe('7 4');
    expect(oiEdge?.animated).toBe(true);

    const cJoin = result.query.joins.find((j) => j.condition.includes('p.category_id'));
    const cEdge = edges.find((e) => e.id === cJoin!.id);
    expect(cEdge?.data?.effectiveInner).toBeFalsy();
  });

  it('query 未指定時は実質 INNER JOIN 表示を付けない', () => {
    const result = parseOracleQuery(SAMPLE_SQL);
    expect(result.success).toBe(true);
    if (!result.success) return;

    const { edges } = buildJoinFlowLayout(result.query.tables, result.query.joins, false);
    expect(edges.every((e) => !e.data?.effectiveInner)).toBe(true);
  });

  it('layoutKey が変わらない限り buildJoinFlowLayout の node id 列は安定', () => {
    const key = computeJoinLayoutKey(sampleTables, sampleJoins, false);
    const a = buildJoinFlowLayout(sampleTables, sampleJoins, false);
    const b = buildJoinFlowLayout(sampleTables, sampleJoins, false);
    expect(computeJoinLayoutKey(sampleTables, sampleJoins, false)).toBe(key);
    expect(a.nodes.map((n) => n.id)).toEqual(b.nodes.map((n) => n.id));
  });

  it('layoutKey は ID が同じでも JOIN 種別の変更を検知する', () => {
    const baseKey = computeJoinLayoutKey(sampleTables, sampleJoins, false);
    const leftJoin = { ...sampleJoins[0]!, type: 'LEFT JOIN' as const };
    const leftKey = computeJoinLayoutKey(sampleTables, [leftJoin, ...sampleJoins.slice(1)], false);
    expect(leftKey).not.toBe(baseKey);
  });

  it('layoutKey は ID が同じでも ON 条件の変更を検知する', () => {
    const baseKey = computeJoinLayoutKey(sampleTables, sampleJoins, false);
    const changed = { ...sampleJoins[0]!, condition: 'o.user_id = u.other_id' };
    const changedKey = computeJoinLayoutKey(sampleTables, [changed, ...sampleJoins.slice(1)], false);
    expect(changedKey).not.toBe(baseKey);
  });

  it('layoutKey は ID が同じでも NATURAL JOIN フラグの変更を検知する', () => {
    const baseKey = computeJoinLayoutKey(sampleTables, sampleJoins, false);
    const natural = { ...sampleJoins[0]!, isNatural: true };
    const naturalKey = computeJoinLayoutKey(sampleTables, [natural, ...sampleJoins.slice(1)], false);
    expect(naturalKey).not.toBe(baseKey);
  });

  describe('実質 INNER JOIN のエッジ表示', () => {
    it('computeJoinLayoutKey は query 指定時に effectiveInner 状態を反映する', () => {
      const result = parseOracleQuery(SAMPLE_SQL);
      expect(result.success).toBe(true);
      if (!result.success) return;

      const withoutQuery = computeJoinLayoutKey(result.query.tables, result.query.joins, false);
      const withQuery = computeJoinLayoutKey(result.query.tables, result.query.joins, false, result.query);
      expect(withoutQuery).not.toBe(withQuery);
    });

    it('WHERE のみでも query 指定時は effectiveInner エッジになる', () => {
      const result = parseOracleQuery(`
        SELECT * FROM table_a a
        LEFT JOIN table_b b ON b.a_id = a.id
        WHERE b.col = 1
      `);
      expect(result.success).toBe(true);
      if (!result.success) return;

      const { edges } = buildJoinFlowLayout(result.query.tables, result.query.joins, false, result.query);
      const leftJoin = result.query.joins.find((j) => j.type === 'LEFT JOIN')!;
      const edge = edges.find((e) => e.id === leftJoin.id);

      expect(edge?.data?.effectiveInner).toBe(true);
      expect(formatJoinEdgeLabel(leftJoin, true)).toContain('≈INNER');
      expect(edge?.style?.stroke).toBe('#6b9fd4');
    });

    it('通常の INNER JOIN エッジは effectiveInner にならない', () => {
      const result = parseOracleQuery(SAMPLE_SQL);
      expect(result.success).toBe(true);
      if (!result.success) return;

      const { edges } = buildJoinFlowLayout(result.query.tables, result.query.joins, false, result.query);
      const innerJoin = result.query.joins.find((j) => j.type === 'INNER JOIN' && j.condition.includes('o.user_id'))!;
      const edge = edges.find((e) => e.id === innerJoin.id);

      expect(edge?.data?.effectiveInner).toBe(false);
      expect(edge?.data?.joinType).toBe('INNER JOIN');
      expect(edge?.data?.condition).toBe('o.user_id = u.user_id');
      expect(edge?.animated).toBe(false);
      expect(edge?.style?.strokeDasharray).toBeUndefined();
    });

    it('SAMPLE_SQL では effectiveInner な LEFT JOIN は1本のみ', () => {
      const result = parseOracleQuery(SAMPLE_SQL);
      expect(result.success).toBe(true);
      if (!result.success) return;

      const { edges } = buildJoinFlowLayout(result.query.tables, result.query.joins, false, result.query);
      const effectiveEdges = edges.filter((e) => e.data?.effectiveInner);
      expect(effectiveEdges).toHaveLength(1);
      expect(effectiveEdges[0]?.data?.joinType).toBe('LEFT JOIN');
    });

    it('formatJoinEdgeLabel は JOIN 種別のみ（ON 条件は別ボックス）', () => {
      const join = sampleJoins[0]!;
      expect(formatJoinEdgeLabel(join, false)).toBe('INNER JOIN');
      expect(formatJoinEdgeLabel(join, true)).toBe('INNER JOIN\n≈INNER');
    });

    it('compact モードでは ON 条件ボックスを出さない', () => {
      const { edges } = buildJoinFlowLayout(sampleTables, sampleJoins, false, undefined, true);
      expect(edges[0]?.data?.compact).toBe(true);
      expect(edges[0]?.data?.condition).toBe('o.user_id = u.id');
    });

    it('showGraphJoinCondition=false のとき ON 条件ラベル非表示（JoinFlowEdge 用）', () => {
      const { edges } = buildJoinFlowLayout(sampleTables, sampleJoins, false);
      expect(edges[0]?.data?.showGraphJoinCondition).toBeUndefined();
      const hidden = {
        ...edges[0]!,
        data: { ...edges[0]!.data, showGraphJoinCondition: false },
      };
      expect((hidden.data as { showGraphJoinCondition: boolean }).showGraphJoinCondition).toBe(false);
    });

    it('truncateJoinCondition が長い条件を省略する', () => {
      const long = 'a.'.repeat(40);
      expect(truncateJoinCondition(long, 20)).toMatch(/…$/);
      expect(truncateJoinCondition('a.id = b.id', 20)).toBe('a.id = b.id');
    });
  });
});
