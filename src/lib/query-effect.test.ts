import { describe, expect, it } from 'vitest';
import {
  DELETE_SAMPLE_SQL,
  SAMPLE_SQL,
  UNION_SAMPLE_SQL,
  UPDATE_SAMPLE_SQL,
  parseOracleQuery,
} from './parser';
import type { QueryEffectFilterPart, QueryEffectSection } from './query-effect';
import {
  buildConditionEffectTree,
  buildQueryEffect,
  buildUnionQueryEffect,
  classifyTablePresenceRequirement,
  collectJoinFilterNodes,
  collectLeafTexts,
} from './query-effect';
import { applyAliasResolution } from './alias-resolver';
import type { ParsedQuery } from './types';

function lineTexts(section?: QueryEffectSection): string[] {
  return section?.lines?.map((l) => l.text) ?? [];
}

function scopeLines(sql: string): string[] {
  return lineTexts(scopeSection(sql));
}
function scopeSectionForQuery(query: ParsedQuery): QueryEffectSection | undefined {
  const effect = buildQueryEffect(query);
  return effect.sections.find((s) => s.kind === 'scope');
}

function scopeSection(sql: string): QueryEffectSection | undefined {
  const result = parseOracleQuery(sql);
  expect(result.success).toBe(true);
  if (!result.success) return undefined;
  return scopeSectionForQuery(result.query);
}

function optionalPresenceEntries(sql: string) {
  return scopeSection(sql)?.presenceGroups?.find((g) => g.kind === 'optional')?.entries ?? [];
}

function presenceJoinOnNode(join: { condition: import('./query-effect').ConditionEffectNode }) {
  return join.condition;
}

function optionalJoinConditionTexts(sql: string): string[] {
  return optionalPresenceEntries(sql).flatMap((entry) => {
    const on = entry.join ? presenceJoinOnNode(entry.join) : undefined;
    return on ? collectLeafTexts(on) : [];
  });
}

function filterSectionForQuery(query: ParsedQuery): QueryEffectSection | undefined {
  const effect = buildQueryEffect(query);
  return effect.sections.find((s) => s.kind === 'filter' && s.title === '行の絞り込み');
}

function filterSection(sql: string): QueryEffectSection | undefined {
  const result = parseOracleQuery(sql);
  expect(result.success).toBe(true);
  if (!result.success) return undefined;
  return filterSectionForQuery(result.query);
}

function joinFilterPartRoot(sql: string) {
  return filterSection(sql)?.filterParts?.find((p) => p.label === '結合条件')?.root;
}

function joinFilterNodes(sql: string) {
  const root = joinFilterPartRoot(sql);
  return root ? collectJoinFilterNodes(root) : [];
}

function filterPartTexts(part: QueryEffectFilterPart): string[] {
  return collectLeafTexts(part.root);
}

function filterLeafTexts(sql: string): string[] {
  const section = filterSection(sql);
  if (section?.filterParts) {
    return section.filterParts.flatMap(filterPartTexts);
  }
  return section?.conditionRoot ? collectLeafTexts(section.conditionRoot) : [];
}

function allLeafTexts(effect: ReturnType<typeof buildQueryEffect>): string[] {
  return effect.sections.flatMap((s) => {
    const fromPresence = (s.presenceGroups ?? []).flatMap((g) =>
      g.entries.flatMap((e) => {
        const on = e.join ? presenceJoinOnNode(e.join) : undefined;
        return on ? collectLeafTexts(on) : [];
      }),
    );
    if (s.filterParts) {
      return [...s.filterParts.flatMap(filterPartTexts), ...fromPresence];
    }
    if (s.conditionRoot) {
      return [...collectLeafTexts(s.conditionRoot), ...fromPresence];
    }
    return [...lineTexts(s), ...fromPresence];
  });
}

describe('query-effect', () => {
  it('SELECT サンプルで表示対象の要約を生成する', () => {
    const result = parseOracleQuery(SAMPLE_SQL);
    expect(result.success).toBe(true);
    if (!result.success) return;

    const narrative = buildQueryEffect(result.query, 'japanese');
    expect(narrative.action).toBe('select');
    expect(narrative.summary).toContain('表示');
    expect(narrative.summary).toContain('100');
    expect(narrative.summary).toContain('users（u）');
    expect(narrative.summary).toContain(
      `users（u） など ${result.query.tables.length} テーブルの組み合わせ`,
    );
    expect(narrative.summary).not.toContain(' AS ');

    const effect = buildQueryEffect(result.query);
    expect(effect.action).toBe('select');

    const scope = effect.sections.find((s) => s.kind === 'scope');
    expect(scope?.title).toBe('結合するテーブル');
    expect(lineTexts(scope).some((l) => l.includes('INNER JOIN'))).toBe(false);

    const filter = effect.sections.find((s) => s.kind === 'filter' && s.title === '行の絞り込み');
    expect(filter?.filterParts?.length).toBeGreaterThan(0);
    expect(joinFilterNodes(SAMPLE_SQL).some((n) => n.label === 'INNER JOIN')).toBe(true);
    expect(filterLeafTexts(SAMPLE_SQL).some((t) => t.includes("u.status = 'ACTIVE'"))).toBe(true);

    const target = effect.sections.find((s) => s.kind === 'target');
    expect(target?.title).toBe('表示対象');
    expect(lineTexts(target).some((l) => l.includes('users（u）.user_id'))).toBe(true);
    expect(effect.sections.findIndex((s) => s.kind === 'target')).toBeLessThan(
      effect.sections.findIndex((s) => s.kind === 'scope'),
    );

    expect(effect.sections.some((s) => s.kind === 'aggregate')).toBe(true);
  });

  it('オプティマイザヒントは JOIN 種別にせず作用説明に出す', () => {
    const sql = `
      SELECT /*+ ORDERED */ u.id
      FROM users u
      JOIN orders o ON o.user_id = u.id
    `;
    const result = parseOracleQuery(sql);
    expect(result.success).toBe(true);
    if (!result.success) return;

    expect(result.query.joins[0]?.type).toBe('INNER JOIN');

    const jpScope = buildQueryEffect(result.query, 'japanese').sections.find(
      (s) => s.kind === 'scope',
    );
    expect(lineTexts(jpScope).some((l) => l.includes('ORDERED'))).toBe(true);
    expect(lineTexts(jpScope).some((l) => l.includes('結果集合は変わらない'))).toBe(true);
  });

  it('旧式外部結合 (+) は LEFT JOIN として説明する', () => {
    const sql = 'SELECT e.emp_no FROM employees e, departments d WHERE e.dept_no = d.dept_no(+)';
    const result = parseOracleQuery(sql);
    expect(result.success).toBe(true);
    if (!result.success) return;

    const jpScope = buildQueryEffect(result.query, 'japanese').sections.find(
      (s) => s.kind === 'scope',
    );
    expect(lineTexts(jpScope).some((l) => l.includes('LEFT JOIN'))).toBe(true);
  });

  it('旧式外部結合 (+) の結合条件は行の絞り込みに出さない', () => {
    const sql = 'SELECT e.emp_no FROM employees e, departments d WHERE e.dept_no = d.dept_no(+)';
    const result = parseOracleQuery(sql);
    expect(result.success).toBe(true);
    if (!result.success) return;

    // 結合条件しか無いので絞り込みの節そのものが立たない（ANSI で ON に書いた場合と揃う）
    for (const mode of ['japanese', 'sql'] as const) {
      const filter = buildQueryEffect(result.query, mode).sections.find((s) => s.kind === 'filter');
      const texts = JSON.stringify(filter ?? null);
      expect(texts).not.toContain('e.dept_no');
    }
  });

  it('旧式外部結合 (+) でも本物の絞り込みは残す', () => {
    const sql = `SELECT a.id
FROM t_a a, t_b b
WHERE a.id = b.a_id(+)
  AND b.status(+) = 'ACTIVE'
  AND a.kind = 'X'`;
    const result = parseOracleQuery(sql);
    expect(result.success).toBe(true);
    if (!result.success) return;

    const filter = buildQueryEffect(result.query, 'japanese').sections.find(
      (s) => s.kind === 'filter',
    );
    const texts = JSON.stringify(filter ?? null);
    expect(texts).toContain("a.kind = 'X'");
    // 結合条件（(+) 付きの絞り込みを含む）は検索範囲側に出るので二重表示しない
    expect(texts).not.toContain('a.id = b.a_id');
    expect(texts).not.toContain('b.status');
  });

  it('CROSS JOIN に ON があるときは直積ではなく結合条件として説明する', () => {
    const sql = `
      SELECT u.id
      FROM users u
      CROSS JOIN orders o ON o.user_id = u.id
    `;
    expect(joinFilterNodes(sql).some((n) => n.label === 'CROSS JOIN')).toBe(true);

    const result = parseOracleQuery(sql);
    expect(result.success).toBe(true);
    if (!result.success) return;
    const jpScope = buildQueryEffect(result.query, 'japanese').sections.find((s) => s.kind === 'scope');
    expect(lineTexts(jpScope).some((l) => l.includes('CROSS JOIN') && l.includes('o.user_id = u.id'))).toBe(
      true,
    );
    expect(lineTexts(jpScope).some((l) => l.includes('直積'))).toBe(false);

    const sqlScope = buildQueryEffect(result.query, 'sql').sections.find((s) => s.kind === 'scope');
    expect(lineTexts(sqlScope).some((l) => l.includes('すべての組み合わせ'))).toBe(false);
  });

  it('ON のない CROSS JOIN は直積として説明する', () => {
    const sql = `
      SELECT u.id
      FROM users u
      CROSS JOIN orders o
    `;
    expect(joinFilterNodes(sql).some((n) => n.label === 'CROSS JOIN')).toBe(false);

    const result = parseOracleQuery(sql);
    expect(result.success).toBe(true);
    if (!result.success) return;
    const jpScope = buildQueryEffect(result.query, 'japanese').sections.find((s) => s.kind === 'scope');
    expect(lineTexts(jpScope).some((l) => l.includes('直積'))).toBe(true);
  });

  it('SELECT の表示対象はエイリアス解決の有無に関わらず実テーブル名とエイリアスを併記する', () => {
    const result = parseOracleQuery(SAMPLE_SQL);
    expect(result.success).toBe(true);
    if (!result.success) return;

    const unresolved = buildQueryEffect(result.query).sections.find((s) => s.kind === 'target');
    const resolved = buildQueryEffect(applyAliasResolution(result.query, true)).sections.find(
      (s) => s.kind === 'target',
    );

    expect(lineTexts(unresolved).some((l) => l.includes('users（u）.user_id'))).toBe(true);
    expect(lineTexts(resolved).some((l) => l.includes('users（u）.user_id'))).toBe(true);
    expect(lineTexts(resolved).some((l) => l.match(/(?<![（）\w])users\.id/))).toBe(false);
  });

  describe('実質 INNER JOIN の行条件説明', () => {
    it('SELECT サンプルで order_items LEFT JOIN を簡潔な結合条件として説明する', () => {
      const joins = joinFilterNodes(SAMPLE_SQL);

      const oiJoin = joins.find((n) => n.label?.includes('実質 INNER JOIN'));
      expect(oiJoin).toBeDefined();
      expect(oiJoin!.label).toMatch(/後続の結合で必須/);
      expect(collectLeafTexts(oiJoin!.children![0]!)).toEqual(['oi.order_id = o.order_id']);

      const categoriesEntry = optionalPresenceEntries(SAMPLE_SQL).find((e) =>
        e.tableLabel.includes('categories（c）'),
      );
      expect(categoriesEntry).toBeDefined();
      expect(categoriesEntry!.join?.type).toBe('LEFT JOIN');
      expect(
        collectLeafTexts(presenceJoinOnNode(categoriesEntry!.join!)!).some((l) =>
          l.includes('p.category_id'),
        ),
      ).toBe(true);
      expect(filterLeafTexts(SAMPLE_SQL).find((l) => l.includes('p.category_id = c.id'))).toBeUndefined();

      const lmEntry = optionalPresenceEntries(SAMPLE_SQL).find((e) => e.tableLabel.includes('line_metrics（lm）'));
      expect(lmEntry).toBeDefined();
      expect(lmEntry!.join?.type).toBe('LEFT JOIN');
      expect(collectLeafTexts(presenceJoinOnNode(lmEntry!.join!)!).some((l) => l.includes('lm.user_id'))).toBe(
        true,
      );
      expect(filterLeafTexts(SAMPLE_SQL).find((l) => l.includes('lm.user_id'))).toBeUndefined();

      const hotJoin = joins.find((n) =>
        collectLeafTexts(n.children![0]!).some((l) => l.includes('hot.user_id')),
      );
      expect(hotJoin?.label).toBe('INNER JOIN');
    });

    it('旧式外部結合 (+) の LEFT JOIN も WHERE で必須なら実質 INNER とする', () => {
      const sql = `SELECT a.id
FROM table_a a, table_b b
WHERE a.id = b.a_id(+)
  AND b.status = 1`;
      const join = joinFilterNodes(sql).find((n) => n.label?.includes('実質 INNER JOIN'));
      expect(join).toBeDefined();
      expect(join!.label).toContain('WHERE');
    });

    it('WHERE のみの LEFT JOIN では WHERE によりと説明する', () => {
      const sql = `
        SELECT * FROM table_a a
        LEFT JOIN table_b b ON b.a_id = a.id
        WHERE b.col = 1
      `;
      const join = joinFilterNodes(sql).find((n) =>
        collectLeafTexts(n.children![0]!).some((l) => l.includes('b.a_id = a.id')),
      );
      expect(join?.label).toMatch(/^LEFT JOIN（実質 INNER JOIN — WHERE で必須）$/);
      expect(join?.label).not.toContain('後続');
    });

    it('HAVING のみの LEFT JOIN では HAVING によりと説明する', () => {
      const sql = `
        SELECT a.id FROM table_a a
        LEFT JOIN table_b b ON b.a_id = a.id
        GROUP BY a.id
        HAVING SUM(b.q) > 1
      `;
      const join = joinFilterNodes(sql).find((n) =>
        collectLeafTexts(n.children![0]!).some((l) => l.includes('b.a_id = a.id')),
      );
      expect(join?.label).toMatch(/^LEFT JOIN（実質 INNER JOIN — HAVING で必須）$/);
    });

    it('WHERE と HAVING のみでは WHERE / HAVING によりと説明する', () => {
      const sql = `
        SELECT a.id FROM table_a a
        LEFT JOIN table_b b ON b.a_id = a.id
        WHERE b.col = 1
        GROUP BY a.id
        HAVING COUNT(b.id) > 0
      `;
      const join = joinFilterNodes(sql).find((n) =>
        collectLeafTexts(n.children![0]!).some((l) => l.includes('b.a_id = a.id')),
      );
      expect(join?.label).toBe('LEFT JOIN（実質 INNER JOIN — WHERE / HAVING で必須）');
    });

    it('実質 INNER JOIN でない LEFT JOIN は結合テーブル欄に ON 条件付きで説明する', () => {
      const sql = `
        SELECT * FROM table_a a
        LEFT JOIN table_b b ON b.a_id = a.id
      `;
      const entry = optionalPresenceEntries(sql).find((e) => e.tableLabel.includes('table_b'));
      expect(entry?.join?.type).toBe('LEFT JOIN');
      expect(collectLeafTexts(presenceJoinOnNode(entry!.join!)!).some((l) => l.includes('b.a_id = a.id'))).toBe(
        true,
      );
      expect(filterLeafTexts(sql).find((l) => l.includes('b.a_id'))).toBeUndefined();
    });

    it('OR 配下のみ nullable 参照がある場合も外部結合として任意欄に残す', () => {
      const sql = `
        SELECT * FROM table_a a
        LEFT JOIN table_b b ON b.a_id = a.id
        WHERE b.col = 1 OR b.id IS NULL
      `;
      const entry = optionalPresenceEntries(sql).find((e) => e.tableLabel.includes('table_b'));
      expect(entry?.join?.type).toBe('LEFT JOIN');
      expect(collectLeafTexts(presenceJoinOnNode(entry!.join!)!).some((l) => l.includes('b.a_id = a.id'))).toBe(
        true,
      );
    });
  });

  describe('テーブル必須・任意の分類', () => {
    it('SELECT サンプルでレコード必須・任意テーブルを羅列する', () => {
      const result = parseOracleQuery(SAMPLE_SQL);
      expect(result.success).toBe(true);
      if (!result.success) return;

      const { required, optional, effectiveInnerTableIds } =
        classifyTablePresenceRequirement(result.query);
      const requiredAliases = required.map((t) => t.alias ?? t.table);
      const optionalAliases = optional.map((t) => t.alias ?? t.table);

      expect(requiredAliases).toContain('u');
      expect(requiredAliases).toContain('o');
      expect(requiredAliases).toContain('oi');
      expect(requiredAliases).toContain('p');
      expect(requiredAliases).toContain('hot');
      expect(optionalAliases).toContain('lm');
      expect(optionalAliases).toContain('c');
      expect(effectiveInnerTableIds.has(result.query.tables.find((t) => t.alias === 'oi')!.id)).toBe(
        true,
      );

      const scope = scopeLines(SAMPLE_SQL);
      expect(scope.some((l) => l.includes('INNER JOIN'))).toBe(false);
      expect(filterLeafTexts(SAMPLE_SQL).some((l) => l === 'INNER JOIN')).toBe(true);
      expect(scope.some((l) => l.startsWith('必須'))).toBe(false);

      const scopeSectionData = scopeSection(SAMPLE_SQL);
      const requiredGroup = scopeSectionData?.presenceGroups?.find((g) => g.kind === 'required');
      const optionalGroup = scopeSectionData?.presenceGroups?.find((g) => g.kind === 'optional');
      expect(requiredGroup).toBeDefined();
      expect(optionalGroup).toBeDefined();
      expect(
        requiredGroup!.entries.some((e) => e.tableLabel.includes('order_items（oi）（実質 INNER JOIN）')),
      ).toBe(true);
      expect(optionalGroup!.entries.some((e) => e.tableLabel.includes('line_metrics（lm）'))).toBe(true);
      expect(optionalGroup!.entries.some((e) => e.tableLabel.includes('categories（c）'))).toBe(true);
      expect(optionalGroup!.entries.every((e) => e.join?.type === 'LEFT JOIN')).toBe(true);
    });

    it('レコード必須・任意はエイリアス解決の有無に関わらず実テーブル名とエイリアスを併記する', () => {
      const result = parseOracleQuery(SAMPLE_SQL);
      expect(result.success).toBe(true);
      if (!result.success) return;

      const unresolved = scopeSectionForQuery(result.query)?.presenceGroups?.find(
        (g) => g.kind === 'required',
      );
      const resolved = scopeSectionForQuery(applyAliasResolution(result.query, true))?.presenceGroups?.find(
        (g) => g.kind === 'required',
      );

      expect(unresolved?.entries.map((e) => e.tableLabel)).toContain('users（u）');
      expect(resolved?.entries.map((e) => e.tableLabel)).toContain('users（u）');
      expect(unresolved?.entries.map((e) => e.tableLabel)).not.toContain('u');
      expect(resolved?.entries.map((e) => e.tableLabel)).not.toContain('users');
    });

    it('派生テーブル表記が二重にならない', () => {
      const requiredGroup = scopeSection(SAMPLE_SQL)?.presenceGroups?.find(
        (g) => g.kind === 'required',
      );
      expect(requiredGroup).toBeDefined();
      const hotLine = requiredGroup!.entries.find((e) => e.tableLabel.includes('hot'));
      expect(hotLine).toBeDefined();
      expect(hotLine!.tableLabel).toContain('hot (派生テーブル)');
      expect(hotLine!.tableLabel.match(/派生テーブル/g)?.length).toBe(1);
    });

    it('結合するテーブル欄は必須・任意と外部結合の ON を示す', () => {
      const scope = scopeSection(SAMPLE_SQL);
      expect(scope?.title).toBe('結合するテーブル');
      expect(scope?.presenceGroups?.length).toBe(2);
      expect(scope?.presenceGroups?.find((g) => g.kind === 'required')?.label).toBe('必須');
      expect(scope?.presenceGroups?.find((g) => g.kind === 'optional')?.label).toBe('任意（外部結合）');
      expect(optionalPresenceEntries(SAMPLE_SQL).every((e) => e.join?.type === 'LEFT JOIN')).toBe(true);
      expect(optionalJoinConditionTexts(SAMPLE_SQL).some((l) => l.includes('p.category_id'))).toBe(true);
      expect(lineTexts(scope).some((l) => l.includes('INNER JOIN'))).toBe(false);
    });

    it('実質 INNER JOIN でない LEFT JOIN は任意テーブルに含める', () => {
      const result = parseOracleQuery(`
        SELECT * FROM table_a a
        LEFT JOIN table_b b ON b.a_id = a.id
      `);
      expect(result.success).toBe(true);
      if (!result.success) return;

      const { required, optional } = classifyTablePresenceRequirement(result.query);
      expect(required.map((t) => t.alias)).toEqual(['a']);
      expect(optional.map((t) => t.alias)).toEqual(['b']);
    });

    it('WHERE により実質 INNER になったテーブルは必須に含める', () => {
      const result = parseOracleQuery(`
        SELECT * FROM table_a a
        LEFT JOIN table_b b ON b.a_id = a.id
        WHERE b.col = 1
      `);
      expect(result.success).toBe(true);
      if (!result.success) return;

      const { required, optional } = classifyTablePresenceRequirement(result.query);
      expect(required.map((t) => t.alias).sort()).toEqual(['a', 'b']);
      expect(optional).toHaveLength(0);
    });

    it('LEFT JOIN の後に RIGHT JOIN すると左側チェーンは任意になる', () => {
      const result = parseOracleQuery(`
        SELECT *
        FROM a_table
        LEFT JOIN b_table ON a_table.id = b_table.id
        RIGHT JOIN c_table ON b_table.id = c_table.id
      `);
      expect(result.success).toBe(true);
      if (!result.success) return;

      const { required, optional } = classifyTablePresenceRequirement(result.query);
      expect(required.map((t) => t.table).sort()).toEqual(['c_table']);
      expect(optional.map((t) => t.table).sort()).toEqual(['a_table', 'b_table']);
    });

    it('RIGHT JOIN 後の WHERE 実質 INNER でも左側の必須テーブルは維持する', () => {
      const result = parseOracleQuery(`
        SELECT *
        FROM a_table
        LEFT JOIN b_table ON a_table.id = b_table.id
        RIGHT JOIN c_table ON b_table.id = c_table.id
        WHERE b_table.id IS NOT NULL
      `);
      expect(result.success).toBe(true);
      if (!result.success) return;

      const { required, optional } = classifyTablePresenceRequirement(result.query);
      expect(required.map((t) => t.table).sort()).toEqual(['a_table', 'b_table', 'c_table']);
      expect(optional).toHaveLength(0);
    });

    it('WHERE が RIGHT JOIN の sourceId 以外の左側を参照しても必須を維持する', () => {
      const result = parseOracleQuery(`
        SELECT *
        FROM a_table
        LEFT JOIN b_table ON a_table.id = b_table.id
        RIGHT JOIN c_table ON a_table.id = c_table.id
        WHERE a_table.id IS NOT NULL
      `);
      expect(result.success).toBe(true);
      if (!result.success) return;

      const { required, optional, effectiveInnerTableIds } = classifyTablePresenceRequirement(
        result.query,
      );
      expect(required.map((t) => t.table).sort()).toEqual(['a_table', 'c_table']);
      expect(optional.map((t) => t.table)).toEqual(['b_table']);
      expect(
        effectiveInnerTableIds.has(result.query.tables.find((t) => t.table === 'a_table')!.id),
      ).toBe(true);
    });

    it('WHERE が左側の非 sourceId を参照し ON が中間表経由でも必須チェーンを復元する', () => {
      const result = parseOracleQuery(`
        SELECT *
        FROM a_table
        LEFT JOIN b_table ON a_table.id = b_table.id
        RIGHT JOIN c_table ON b_table.id = c_table.id
        WHERE a_table.id IS NOT NULL
      `);
      expect(result.success).toBe(true);
      if (!result.success) return;

      const { required, optional } = classifyTablePresenceRequirement(result.query);
      expect(required.map((t) => t.table).sort()).toEqual(['a_table', 'b_table', 'c_table']);
      expect(optional).toHaveLength(0);
    });

    it('RIGHT JOIN の ON が中間表経由で LEFT JOIN チェーンを遡って必須にする', () => {
      const result = parseOracleQuery(`
        SELECT *
        FROM a_table
        LEFT JOIN b_table ON a_table.id = b_table.id
        LEFT JOIN c_table ON b_table.id = c_table.id
        RIGHT JOIN d_table ON c_table.id = d_table.id
        WHERE a_table.id IS NOT NULL
      `);
      expect(result.success).toBe(true);
      if (!result.success) return;

      const { required, optional } = classifyTablePresenceRequirement(result.query);
      expect(required.map((t) => t.table).sort()).toEqual(['a_table', 'b_table', 'c_table', 'd_table']);
      expect(optional).toHaveLength(0);
    });

    it('INNER JOIN 後の RIGHT JOIN（WHERE なし）では右側のみ必須になる', () => {
      const result = parseOracleQuery(`
        SELECT *
        FROM a_table
        INNER JOIN b_table ON a_table.id = b_table.id
        RIGHT JOIN c_table ON b_table.id = c_table.id
      `);
      expect(result.success).toBe(true);
      if (!result.success) return;

      const { required, optional } = classifyTablePresenceRequirement(result.query);
      expect(required.map((t) => t.table)).toEqual(['c_table']);
      expect(optional.map((t) => t.table).sort()).toEqual(['a_table', 'b_table']);
    });

    it('LEFT→INNER 後の RIGHT JOIN（WHERE なし）でも左側はすべて任意になる', () => {
      const result = parseOracleQuery(`
        SELECT *
        FROM a_table
        LEFT JOIN b_table ON a_table.id = b_table.id
        INNER JOIN c_table ON b_table.id = c_table.id
        RIGHT JOIN d_table ON c_table.id = d_table.id
      `);
      expect(result.success).toBe(true);
      if (!result.success) return;

      const { required, optional, effectiveInnerTableIds } = classifyTablePresenceRequirement(
        result.query,
      );
      expect(required.map((t) => t.table)).toEqual(['d_table']);
      expect(optional.map((t) => t.table).sort()).toEqual(['a_table', 'b_table', 'c_table']);
      expect(
        effectiveInnerTableIds.has(result.query.tables.find((t) => t.table === 'b_table')!.id),
      ).toBe(true);
    });

    it('RIGHT JOIN のみでは右テーブルが必須・左テーブルが任意になる', () => {
      const result = parseOracleQuery(`
        SELECT * FROM a_table RIGHT JOIN b_table ON a_table.id = b_table.id
      `);
      expect(result.success).toBe(true);
      if (!result.success) return;

      const { required, optional } = classifyTablePresenceRequirement(result.query);
      expect(required.map((t) => t.table)).toEqual(['b_table']);
      expect(optional.map((t) => t.table)).toEqual(['a_table']);
    });
  });

  it('UPDATE サンプルで更新対象と SET を含む', () => {
    const result = parseOracleQuery(UPDATE_SAMPLE_SQL);
    expect(result.success).toBe(true);
    if (!result.success) return;

    const effect = buildQueryEffect(result.query);
    expect(effect.action).toBe('update');
    expect(effect.summary).toContain('更新');
    expect(effect.summary).toContain('users（u）');
    expect(effect.summary).not.toContain(' AS ');
    const target = effect.sections.find((s) => s.kind === 'target');
    expect(target?.title).toBe('更新対象');
    expect(lineTexts(target).some((l) => l.includes('users（u）.status'))).toBe(true);
    expect(lineTexts(target).some((l) => l.includes('users（u）.updated_at'))).toBe(true);
    expect(
      effect.sections.some(
        (s) => s.kind === 'change' && lineTexts(s).some((l) => l.includes('INACTIVE')),
      ),
    ).toBe(true);
    expect(
      effect.sections.some(
        (s) =>
          s.filterParts?.some((p) => p.root?.type === 'and') ||
          s.conditionRoot?.type === 'and',
      ),
    ).toBe(true);
  });

  it('DELETE サンプルで削除対象テーブルを示す', () => {
    const result = parseOracleQuery(DELETE_SAMPLE_SQL);
    expect(result.success).toBe(true);
    if (!result.success) return;

    const effect = buildQueryEffect(result.query);
    expect(effect.summary).toContain('削除');
    expect(effect.summary).toContain('order_items（oi）');
    expect(effect.summary).not.toContain(' AS ');
    const target = effect.sections.find((s) => s.kind === 'target');
    expect(target?.title).toBe('削除対象');
    expect(lineTexts(target)).toContain('order_items（oi）');
    expect(effect.sections.some((s) => s.kind === 'change')).toBe(false);
  });

  it('UNION サンプルでブランチごとの効果を生成する', () => {
    const result = parseOracleQuery(UNION_SAMPLE_SQL);
    expect(result.success).toBe(true);
    if (!result.success) return;

    const unionEffect = buildUnionQueryEffect(result.query);
    expect(unionEffect?.branches).toHaveLength(3);
    expect(unionEffect?.unionNotes.some((n) => n.includes('UNION'))).toBe(true);
    expect(unionEffect?.branches[2]?.effect.summary).toContain('guest_users');
    expect(allLeafTexts(unionEffect!.branches[2]!.effect).some((t) => /NOT EXISTS/i.test(t))).toBe(
      true,
    );
    expect(allLeafTexts(unionEffect!.branches[2]!.effect).some((t) => /^関連行が存在する/.test(t))).toBe(
      false,
    );
  });

  it('EXISTS と NOT EXISTS でラベルを区別する', () => {
    const existsResult = parseOracleQuery(
      "SELECT id FROM users u WHERE EXISTS (SELECT 1 FROM orders o WHERE o.user_id = u.id)",
    );
    expect(existsResult.success).toBe(true);
    if (!existsResult.success) return;

    const notExistsResult = parseOracleQuery(
      "SELECT id FROM users u WHERE NOT EXISTS (SELECT 1 FROM orders o WHERE o.user_id = u.id)",
    );
    expect(notExistsResult.success).toBe(true);
    if (!notExistsResult.success) return;

    const existsTexts = collectLeafTexts(buildConditionEffectTree(existsResult.query.where!));
    const notExistsTexts = collectLeafTexts(buildConditionEffectTree(notExistsResult.query.where!));

    expect(existsTexts.some((t) => /^EXISTS /i.test(t))).toBe(true);
    expect(notExistsTexts.some((t) => /^NOT EXISTS /i.test(t))).toBe(true);
  });

  describe('SELECT 修飾子・集約', () => {
    it('DISTINCT で重複行除外と対象列を説明する', () => {
      const result = parseOracleQuery('SELECT DISTINCT u.dept, u.name FROM users u');
      expect(result.success).toBe(true);
      if (!result.success) return;

      const effect = buildQueryEffect(result.query);
      expect(effect.summary).toContain('重複行除外');
      const post = effect.sections.find((s) => s.title === '後処理');
      expect(lineTexts(post)).toEqual(['DISTINCT']);
    });

    it('OFFSET … ROWS FETCH NEXT … ROWS ONLY を後処理と要約に反映する', () => {
      const result = parseOracleQuery(
        'SELECT id FROM t ORDER BY id OFFSET 10 ROWS FETCH NEXT 50 ROWS ONLY',
      );
      expect(result.success).toBe(true);
      if (!result.success) return;

      expect(result.query.offset).toBe('10');
      const effect = buildQueryEffect(result.query);
      expect(effect.summary).toContain('10 行スキップ後最大 50 行');
      const post = effect.sections.find((s) => s.title === '後処理');
      expect(lineTexts(post)).toEqual([
        'ORDER BY id',
        'OFFSET 10 ROWS FETCH FIRST 50 ROWS ONLY',
      ]);
    });

    it('FETCH FIRST … PERCENT ROWS WITH TIES を要約に反映する', () => {
      const result = parseOracleQuery(
        'SELECT id FROM t ORDER BY score DESC FETCH FIRST 5 PERCENT ROWS WITH TIES',
      );
      expect(result.success).toBe(true);
      if (!result.success) return;

      const effect = buildQueryEffect(result.query);
      expect(effect.summary).toContain('最大 5%');
      const post = effect.sections.find((s) => s.title === '後処理');
      expect(lineTexts(post)).toEqual([
        'ORDER BY score DESC',
        'FETCH FIRST 5 PERCENT ROWS WITH TIES',
      ]);
    });

    it('GROUP BY なしの集約関数は全体集約として説明する', () => {
      const result = parseOracleQuery('SELECT COUNT(*) AS cnt FROM users');
      expect(result.success).toBe(true);
      if (!result.success) return;

      const effect = buildQueryEffect(result.query);
      expect(effect.summary).toContain('全体集約');
      const agg = effect.sections.find((s) => s.kind === 'aggregate');
      expect(lineTexts(agg)).toEqual(['COUNT(*) AS cnt']);
    });

    it('COUNT(DISTINCT ...) を集約セクションで説明する', () => {
      const result = parseOracleQuery('SELECT dept, COUNT(DISTINCT user_id) AS uu FROM users GROUP BY dept');
      expect(result.success).toBe(true);
      if (!result.success) return;

      const effect = buildQueryEffect(result.query);
      const agg = effect.sections.find((s) => s.kind === 'aggregate');
      expect(lineTexts(agg)).toEqual([
        'GROUP BY',
        'dept',
        'COUNT(DISTINCT user_id) AS uu',
      ]);
    });
  });

  it('buildConditionEffectTree が AND 配下を入れ子にする', () => {
    const result = parseOracleQuery('SELECT * FROM t WHERE a = 1 AND b = 2');
    expect(result.success).toBe(true);
    if (!result.success || !result.query.where) return;

    const tree = buildConditionEffectTree(result.query.where);
    expect(tree.type).toBe('and');
    expect(tree.children).toHaveLength(2);
    expect(collectLeafTexts(tree)).toHaveLength(2);
  });

  it('buildConditionEffectTree が OR グループを保持する', () => {
    const result = parseOracleQuery("SELECT * FROM t WHERE x = 1 OR y = 2 OR z = 3");
    expect(result.success).toBe(true);
    if (!result.success || !result.query.where) return;

    const tree = buildConditionEffectTree(result.query.where);
    expect(tree.type).toBe('or');
    expect(collectLeafTexts(tree)).toHaveLength(3);
  });

  it('buildConditionEffectTree が AND 内の OR を入れ子にする', () => {
    const result = parseOracleQuery('SELECT * FROM t WHERE a = 1 AND (b = 2 OR c = 3)');
    expect(result.success).toBe(true);
    if (!result.success || !result.query.where) return;

    const tree = buildConditionEffectTree(result.query.where);
    expect(tree.type).toBe('and');
    expect(tree.children?.some((c) => c.type === 'or')).toBe(true);
  });

  describe('直近修正の回帰', () => {
    function sectionIndex(effect: ReturnType<typeof buildQueryEffect>, kind: string): number {
      return effect.sections.findIndex((s) => s.kind === kind);
    }

    it('行の絞り込みは結合条件と WHERE を分けて持つ', () => {
      const section = filterSection(SAMPLE_SQL);
      expect(section?.title).toBe('行の絞り込み');
      expect(section?.filterParts?.map((p) => p.label)).toEqual(['結合条件', 'WHERE']);
    });

    it('結合条件は JOIN 種別と ON 句を行分けし ON 内の AND/OR をツリー表示する', () => {
      const joins = joinFilterNodes(SAMPLE_SQL);
      expect(joins.length).toBeGreaterThanOrEqual(4);

      const ordersJoin = joins.find((n) =>
        collectLeafTexts(n.children![0]!).some((l) => l.includes('o.user_id = u.user_id')),
      );
      expect(ordersJoin?.type).toBe('join');
      expect(ordersJoin?.label).toBe('INNER JOIN');
      expect(ordersJoin?.children?.[0]?.type).toBe('leaf');
      expect(collectLeafTexts(ordersJoin!.children![0]!)).toEqual(['o.user_id = u.user_id']);

      const productsJoin = joins.find((n) =>
        collectLeafTexts(n.children![0]!).some((l) => l.includes('p.product_id = oi.product_id')),
      );
      expect(productsJoin?.label).toBe('INNER JOIN');
      const productsOn = productsJoin!.children![0]!;
      expect(productsOn.type).toBe('and');
      expect(productsOn.children?.some((c) => c.type === 'or')).toBe(true);
      expect(collectLeafTexts(productsOn).some((l) => l.includes("p.status = 'ACTIVE'"))).toBe(true);
      expect(collectLeafTexts(productsOn).some((l) => l.includes('p.clearance_flg = 1'))).toBe(true);

      const wherePart = filterSection(SAMPLE_SQL)?.filterParts?.find((p) => p.label === 'WHERE');
      expect(wherePart?.root.type).toBe('and');
      expect(wherePart?.root.children?.some((c) => c.type === 'or')).toBe(true);
    });

    it('SELECT のセクション順は 表示対象 → 結合するテーブル → 行の絞り込み', () => {
      const result = parseOracleQuery(SAMPLE_SQL);
      expect(result.success).toBe(true);
      if (!result.success) return;

      const effect = buildQueryEffect(result.query);
      const kinds = effect.sections.map((s) => `${s.kind}:${s.title ?? ''}`);

      expect(kinds[0]).toBe('target:表示対象');
      expect(kinds[1]).toBe('scope:結合するテーブル');
      expect(sectionIndex(effect, 'target')).toBeLessThan(sectionIndex(effect, 'scope'));
      expect(sectionIndex(effect, 'scope')).toBeLessThan(sectionIndex(effect, 'filter'));
    });

    it('UPDATE / DELETE も操作対象セクションが先頭に来る', () => {
      const update = parseOracleQuery(UPDATE_SAMPLE_SQL);
      const del = parseOracleQuery(DELETE_SAMPLE_SQL);
      expect(update.success && del.success).toBe(true);
      if (!update.success || !del.success) return;

      const updateEffect = buildQueryEffect(update.query);
      const deleteEffect = buildQueryEffect(del.query);

      expect(updateEffect.sections[0]?.kind).toBe('target');
      expect(updateEffect.sections[0]?.title).toBe('更新対象');
      expect(updateEffect.sections.find((s) => s.kind === 'scope')?.title).toBe('対象テーブル');

      expect(deleteEffect.sections[0]?.kind).toBe('target');
      expect(deleteEffect.sections[0]?.title).toBe('削除対象');
      expect(deleteEffect.sections.some((s) => s.title === '対象の範囲')).toBe(false);
    });

    it('要約行のテーブル表記は SELECT / UPDATE / DELETE で users（u）形式に統一される', () => {
      const selectResult = parseOracleQuery(SAMPLE_SQL);
      const updateResult = parseOracleQuery(UPDATE_SAMPLE_SQL);
      const deleteResult = parseOracleQuery(DELETE_SAMPLE_SQL);
      expect(selectResult.success && updateResult.success && deleteResult.success).toBe(true);
      if (!selectResult.success || !updateResult.success || !deleteResult.success) return;

      const select = buildQueryEffect(selectResult.query);
      const update = buildQueryEffect(updateResult.query);
      const del = buildQueryEffect(deleteResult.query);

      expect(select.summary).toContain('users（u）');
      expect(update.summary).toContain('users（u）');
      expect(del.summary).toContain('order_items（oi）');
      expect(select.summary).not.toContain(' AS ');
      expect(update.summary).not.toContain(' AS ');
      expect(del.summary).not.toContain(' AS ');
    });

    it('エイリアス解決 ON でも要約・表示対象・レコード必須欄は併記形式を維持する', () => {
      const raw = parseOracleQuery(SAMPLE_SQL);
      expect(raw.success).toBe(true);
      if (!raw.success) return;

      const resolvedQuery = applyAliasResolution(raw.query, true);
      const unresolvedEffect = buildQueryEffect(raw.query);
      const resolvedEffect = buildQueryEffect(resolvedQuery);

      expect(unresolvedEffect.summary).toContain('users（u）');
      expect(resolvedEffect.summary).toContain('users（u）');

      const unresolvedTarget = lineTexts(unresolvedEffect.sections.find((s) => s.kind === 'target'));
      const resolvedTarget = lineTexts(resolvedEffect.sections.find((s) => s.kind === 'target'));
      expect(unresolvedTarget.some((l) => l.includes('users（u）.user_id'))).toBe(true);
      expect(resolvedTarget.some((l) => l.includes('users（u）.user_id'))).toBe(true);

      const required = (effect: ReturnType<typeof buildQueryEffect>) =>
        effect.sections
          .find((s) => s.kind === 'scope')
          ?.presenceGroups?.find((g) => g.kind === 'required')
          ?.entries.map((e) => e.tableLabel) ?? [];

      expect(required(unresolvedEffect)).toContain('users（u）');
      expect(required(resolvedEffect)).toContain('users（u）');
    });

    it('JOIN がない SELECT は scope タイトルを対象テーブルにする', () => {
      const result = parseOracleQuery("SELECT id, name FROM users WHERE status = 'active'");
      expect(result.success).toBe(true);
      if (!result.success) return;

      const scope = buildQueryEffect(result.query).sections.find((s) => s.kind === 'scope');
      expect(scope?.title).toBe('対象テーブル');
      expect(scope?.lines?.some((l) => l.text.includes('users'))).toBe(true);
      expect(scope?.presenceGroups).toBeUndefined();
    });

    it('結合するテーブルの必須欄に実質 INNER JOIN 表記と派生テーブル単一表記を維持する', () => {
      const scope = scopeSection(SAMPLE_SQL);
      const required = scope?.presenceGroups?.find((g) => g.kind === 'required');

      expect(
        required?.entries.some((e) => e.tableLabel.includes('order_items（oi）（実質 INNER JOIN）')),
      ).toBe(true);

      const hot = required?.entries.find((e) => e.tableLabel.includes('hot'));
      expect(hot?.tableLabel).toContain('hot (派生テーブル)');
      expect(hot?.tableLabel.match(/派生テーブル/g)?.length).toBe(1);
    });

    it('WHERE の NOT EXISTS ラベルが EXISTS と混同しない', () => {
      const result = parseOracleQuery(`
        SELECT id FROM guest_users g
        WHERE g.trial_ends_at < NOW()
          AND NOT EXISTS (SELECT 1 FROM orders o WHERE o.user_id = g.id)
      `);
      expect(result.success).toBe(true);
      if (!result.success) return;

      const texts = collectLeafTexts(buildConditionEffectTree(result.query.where!));
      expect(texts.some((t) => /^NOT EXISTS /i.test(t))).toBe(true);
      expect(texts.some((t) => /^EXISTS /i.test(t) && !/^NOT EXISTS /i.test(t))).toBe(false);
    });
  });

  describe('japanese モード（作用説明タブ）', () => {
    it('検索範囲に JOIN を日本語文章で説明し、結合条件セクションは出さない', () => {
      const result = parseOracleQuery(SAMPLE_SQL);
      expect(result.success).toBe(true);
      if (!result.success) return;

      const effect = buildQueryEffect(result.query, 'japanese');
      const scope = effect.sections.find((s) => s.kind === 'scope');
      expect(scope?.title).toBe('検索範囲');
      expect(lineTexts(scope).some((l) => l.includes('を起点に行の組み合わせを構成'))).toBe(true);
      expect(lineTexts(scope).some((l) => /を INNER JOIN — 結合条件「/.test(l))).toBe(true);
      expect(lineTexts(scope).some((l) => /を LEFT JOIN — 結合条件「/.test(l))).toBe(true);

      const required = scope?.presenceGroups?.find((g) => g.kind === 'required');
      const optional = scope?.presenceGroups?.find((g) => g.kind === 'optional');
      expect(required?.label).toBe('レコード必須');
      expect(optional?.label).toBe('レコード任意（外部結合）');
      expect(optional?.entries.every((e) => !e.join)).toBe(true);

      const filter = effect.sections.find((s) => s.kind === 'filter');
      expect(filter?.title).toBe('行の絞り込み（WHERE）');
      expect(filter?.filterParts).toBeUndefined();
      expect(filter?.conditionRoot).toBeDefined();
    });

    it('条件・集約・後処理を自然言語で説明する', () => {
      const result = parseOracleQuery(
        "SELECT dept, COUNT(*) FROM users WHERE name LIKE '%a%' GROUP BY dept ORDER BY dept FETCH FIRST 10 ROWS ONLY",
      );
      expect(result.success).toBe(true);
      if (!result.success) return;

      const effect = buildQueryEffect(result.query, 'japanese');
      const filter = effect.sections.find((s) => s.kind === 'filter');
      expect(collectLeafTexts(filter!.conditionRoot!).some((t) => t.startsWith('パターン一致 —'))).toBe(
        true,
      );

      const agg = effect.sections.find((s) => s.kind === 'aggregate');
      expect(lineTexts(agg).some((l) => l.includes('ごとに集約'))).toBe(true);

      const post = effect.sections.find((s) => s.title === '後処理');
      expect(lineTexts(post).some((l) => l.includes('並び順'))).toBe(true);
      expect(lineTexts(post).some((l) => l.includes('件数上限'))).toBe(true);
    });

    it('EXISTS / IN を日本語フレーズ付きで説明する', () => {
      const result = parseOracleQuery(
        'SELECT id FROM users u WHERE EXISTS (SELECT 1 FROM orders o WHERE o.user_id = u.id) AND u.id IN (SELECT user_id FROM admins)',
      );
      expect(result.success).toBe(true);
      if (!result.success) return;

      const tree = buildConditionEffectTree(result.query.where!, 'japanese');
      const texts = collectLeafTexts(tree);
      expect(texts.some((t) => t.startsWith('別の SELECT が返した値のどれかと一致 —'))).toBe(true);
      expect(texts.some((t) => t.startsWith('関連行が存在するものだけ —'))).toBe(true);
    });

    it('IN (リテラル) と NOT IN を平易な日本語で説明する', () => {
      const inLiteral = parseOracleQuery("SELECT id FROM users WHERE status IN ('active', 'pending')");
      const notInLiteral = parseOracleQuery('SELECT id FROM users WHERE id NOT IN (1, 2, 3)');
      expect(inLiteral.success && notInLiteral.success).toBe(true);
      if (!inLiteral.success || !notInLiteral.success) return;

      const inTexts = collectLeafTexts(
        buildConditionEffectTree(inLiteral.query.where!, 'japanese'),
      );
      const notInTexts = collectLeafTexts(
        buildConditionEffectTree(notInLiteral.query.where!, 'japanese'),
      );
      expect(inTexts.some((t) => t.startsWith('次の値のどれかと一致 —'))).toBe(true);
      expect(notInTexts.some((t) => t.startsWith('次の値のどれとも一致しない —'))).toBe(true);
    });
  });
});
