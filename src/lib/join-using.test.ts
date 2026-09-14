import { describe, expect, it } from 'vitest';
import { parseOracleQuery } from './parser';
import { buildQueryEffect, collectJoinFilterNodes, collectLeafTexts } from './query-effect';
import { resolveJoinConditionExpression } from './join-condition';

describe('JOIN USING', () => {
  it('単一列の USING を解釈し condition と conditionRoot を付与する', () => {
    const result = parseOracleQuery(`
      SELECT *
      FROM users u
      INNER JOIN orders o USING (user_id)
    `);
    expect(result.success).toBe(true);
    if (!result.success) return;

    const join = result.query.joins[0]!;
    expect(join.condition).toBe('USING (user_id)');
    expect(join.conditionRoot?.type).toBe('comparison');
    expect(join.conditionRoot?.label).toBe('u.user_id = o.user_id');
    expect(resolveJoinConditionExpression(join)).toBe('u.user_id = o.user_id');
    expect(join.conditionParts).toEqual({
      left: 'u.user_id',
      operator: '=',
      right: 'o.user_id',
    });
  });

  it('複数列の USING は AND ツリーに展開する', () => {
    const result = parseOracleQuery(`
      SELECT *
      FROM table_a a
      LEFT JOIN table_b b USING (x, y)
    `);
    expect(result.success).toBe(true);
    if (!result.success) return;

    const join = result.query.joins[0]!;
    expect(join.condition).toBe('USING (x, y)');
    expect(join.conditionRoot?.type).toBe('and');
    const labels =
      join.conditionRoot?.type === 'and'
        ? join.conditionRoot.children?.map((c) => c.label)
        : [];
    expect(labels).toEqual(['a.x = b.x', 'a.y = b.y']);
    expect(resolveJoinConditionExpression(join)).toBe('a.x = b.x AND a.y = b.y');
  });

  it('作用説明の行の絞り込みで USING を ON 句として表示する', () => {
    const result = parseOracleQuery(`
      SELECT u.id
      FROM users u
      INNER JOIN orders o USING (user_id)
      WHERE u.status = 'active'
    `);
    expect(result.success).toBe(true);
    if (!result.success) return;

    const effect = buildQueryEffect(result.query);
    const filter = effect.sections.find((s) => s.title === '行の絞り込み');
    const joinPart = filter?.filterParts?.find((p) => p.label === '結合条件');
    const joinNode = joinPart?.root ? collectJoinFilterNodes(joinPart.root)[0] : undefined;
    expect(joinNode?.label).toBe('INNER JOIN');
    expect(collectLeafTexts(joinNode!.children![0]!)).toEqual(['u.user_id = o.user_id']);
  });

  it('外部結合の USING は結合するテーブル欄の任意テーブル配下に表示する', () => {
    const result = parseOracleQuery(`
      SELECT *
      FROM users u
      LEFT JOIN profiles p USING (user_id)
    `);
    expect(result.success).toBe(true);
    if (!result.success) return;

    const optional = buildQueryEffect(result.query).sections
      .find((s) => s.title === '結合するテーブル')
      ?.presenceGroups?.find((g) => g.kind === 'optional');
    const entry = optional?.entries.find((e) => e.tableLabel.includes('profiles'));
    expect(entry?.join?.type).toBe('LEFT JOIN');
    expect(collectLeafTexts(entry!.join!.condition)).toEqual(['u.user_id = p.user_id']);
  });
});
