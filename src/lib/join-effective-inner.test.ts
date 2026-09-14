import { describe, expect, it } from 'vitest';
import { SAMPLE_SQL, parseOracleQuery } from './parser';
import type { ParsedQuery } from './types';
import {
  analyzeEffectiveInnerJoins,
  effectiveInnerAnalysisByJoinId,
  formatEffectiveInnerCausePhrase,
  formatEffectiveInnerJoinScopeLine,
  normalizeEffectiveInnerJoins,
} from './join-effective-inner';

function parseSql(sql: string): ParsedQuery {
  const result = parseOracleQuery(sql);
  expect(result.success).toBe(true);
  if (!result.success) throw new Error(result.error.message);
  return result.query;
}

function leftJoinByCondition(query: ParsedQuery, fragment: string) {
  return query.joins.find((j) => j.type === 'LEFT JOIN' && j.condition.includes(fragment));
}

function analysisForJoin(query: ParsedQuery, joinId: string) {
  return analyzeEffectiveInnerJoins(query).find((a) => a.joinId === joinId);
}

describe('join-effective-inner', () => {
  describe('analyzeEffectiveInnerJoins', () => {
    describe('後続 INNER JOIN', () => {
      it('サンプル SQL で order_items LEFT JOIN を inner_join / where / having で検出する', () => {
        const query = parseSql(SAMPLE_SQL);
        const oiJoin = leftJoinByCondition(query, 'oi.order_id');
        expect(oiJoin).toBeDefined();

        const analysis = analysisForJoin(query, oiJoin!.id);
        expect(analysis).toBeDefined();
        expect(analysis!.reasons.some((r) => r.kind === 'inner_join' && r.label.includes('products'))).toBe(
          true,
        );
        expect(analysis!.reasons.some((r) => r.kind === 'where' && r.label.includes('oi.quantity'))).toBe(true);
        expect(analysis!.reasons.some((r) => r.kind === 'having' && r.label.includes('oi.quantity'))).toBe(
          true,
        );
      });

      it('文字列リテラル内の `b.` はテーブル参照として数えない', () => {
        const query = parseSql(`
          SELECT a.id FROM table_a a
          LEFT JOIN table_b b ON b.a_id = a.id
          WHERE a.note = 'b.id'
        `);
        expect(analyzeEffectiveInnerJoins(query)).toHaveLength(0);
      });

      it('自己結合で片方が無別名なら、共有する識別子を根拠にしない', () => {
        // `users.` は無別名側の参照。u2 への絞り込みと区別できないので根拠にできない
        const query = parseSql(`
          SELECT users.id FROM users
          LEFT JOIN users u2 ON u2.manager_id = users.id
          WHERE users.status = 1
        `);
        expect(analyzeEffectiveInnerJoins(query)).toHaveLength(0);
      });

      it('自己結合でも別名で区別できれば検出する', () => {
        const query = parseSql(`
          SELECT u1.id FROM users u1
          LEFT JOIN users u2 ON u2.manager_id = u1.id
          WHERE u2.status = 1
        `);
        const analyses = analyzeEffectiveInnerJoins(query);
        expect(analyses).toHaveLength(1);
        expect(analyses[0]!.reasons.some((r) => r.kind === 'where')).toBe(true);
      });

      it('自己結合の無別名インスタンス自身への絞り込みは根拠にできる', () => {
        // RIGHT JOIN で nullable になるのは無別名側。`users.` は別名を持たない
        // そのインスタンスを一意に指すので、共有名として捨ててはいけない
        const query = parseSql(`
          SELECT users.id FROM users
          RIGHT JOIN users u2 ON u2.manager_id = users.id
          WHERE users.status = 1
        `);
        const analyses = analyzeEffectiveInnerJoins(query);
        expect(analyses).toHaveLength(1);
        expect(analyses[0]!.reasons.some((r) => r.kind === 'where')).toBe(true);
      });

      it('nullable を参照しない後続 INNER JOIN だけでは検出しない', () => {
        const query = parseSql(`
          SELECT * FROM table_a a
          LEFT JOIN table_b b ON b.a_id = a.id
          INNER JOIN table_c c ON c.a_id = a.id
        `);
        expect(analyzeEffectiveInnerJoins(query)).toHaveLength(0);
      });

      it('nullable を参照する後続 INNER JOIN を検出する', () => {
        const query = parseSql(`
          SELECT * FROM table_a a
          LEFT JOIN table_b b ON b.a_id = a.id
          INNER JOIN table_c c ON c.b_id = b.id
        `);
        const bJoin = leftJoinByCondition(query, 'b.a_id');
        const analysis = analysisForJoin(query, bJoin!.id);
        expect(analysis?.reasons.some((r) => r.kind === 'inner_join')).toBe(true);
      });

      it('暗黙の JOIN 種別も inner_join 理由として扱う', () => {
        const query = parseSql(`
          SELECT * FROM table_a a
          LEFT JOIN table_b b ON b.a_id = a.id
          JOIN table_c c ON c.b_id = b.id
        `);
        const bJoin = leftJoinByCondition(query, 'b.a_id');
        const analysis = analysisForJoin(query, bJoin!.id);
        expect(analysis?.reasons.some((r) => r.kind === 'inner_join')).toBe(true);
      });

      it('nullable を参照する後続 INNER JOIN も実質 INNER として検出する', () => {
        const query = parseSql(`
          SELECT * FROM table_a a
          LEFT JOIN table_b b ON b.a_id = a.id
          INNER JOIN table_c c ON c.b_id = b.id
        `);
        const bJoin = leftJoinByCondition(query, 'b.a_id');
        const analysis = analysisForJoin(query, bJoin!.id);
        expect(
          analysis?.reasons.some((r) => r.kind === 'inner_join' && r.label.includes('INNER JOIN')),
        ).toBe(true);
        expect(formatEffectiveInnerCausePhrase(analysis!.reasons)).toBe('後続の INNER JOIN により');
      });

      it('nullable を参照する後続 CROSS JOIN ON も実質 INNER として検出する', () => {
        const query = parseSql(`
          SELECT * FROM table_a a
          LEFT JOIN table_b b ON b.a_id = a.id
          CROSS JOIN table_c c ON c.b_id = b.id
        `);
        const bJoin = leftJoinByCondition(query, 'b.a_id');
        const analysis = analysisForJoin(query, bJoin!.id);
        expect(analysis?.reasons.some((r) => r.kind === 'inner_join' && r.label.includes('CROSS JOIN'))).toBe(
          true,
        );
        expect(formatEffectiveInnerCausePhrase(analysis!.reasons)).toBe('後続の CROSS JOIN により');
      });

      it('ON のない後続 CROSS JOIN は実質 INNER にしない', () => {
        const query = parseSql(`
          SELECT * FROM table_a a
          LEFT JOIN table_b b ON b.a_id = a.id
          CROSS JOIN table_c c
        `);
        const bJoin = leftJoinByCondition(query, 'b.a_id');
        const analysis = analysisForJoin(query, bJoin!.id);
        expect(analysis?.reasons.some((r) => r.kind === 'inner_join')).toBeFalsy();
      });

      it('nullable を参照する後続 CROSS JOIN USING も実質 INNER として検出する', () => {
        const query = parseSql(`
          SELECT * FROM table_a a
          LEFT JOIN table_b b ON b.a_id = a.id
          CROSS JOIN table_c c USING (id)
        `);
        const bJoin = leftJoinByCondition(query, 'b.a_id');
        const analysis = analysisForJoin(query, bJoin!.id);
        expect(analysis?.reasons.some((r) => r.kind === 'inner_join' && r.label.includes('CROSS JOIN'))).toBe(
          true,
        );
      });

      it('RIGHT JOIN で nullable 側を参照する後続 INNER JOIN を検出する', () => {
        const query = parseSql(`
          SELECT a.id, b.name, d.val
          FROM table_a a
          RIGHT JOIN table_b b ON b.a_id = a.id
          INNER JOIN table_d d ON d.a_id = a.id
        `);
        const rightJoin = query.joins.find((j) => j.type === 'RIGHT JOIN');
        const analysis = analysisForJoin(query, rightJoin!.id);
        expect(analysis?.reasons.some((r) => r.kind === 'inner_join' && r.label.includes('table_d'))).toBe(
          true,
        );
        expect(analysis?.nullableTableIds).toEqual([
          query.tables.find((t) => t.alias === 'a' || t.table === 'table_a')!.id,
        ]);
      });

      it('LEFT JOIN 後の RIGHT JOIN で左側の非 sourceId への WHERE も検出する', () => {
        const query = parseSql(`
          SELECT *
          FROM a_table
          LEFT JOIN b_table ON a_table.id = b_table.id
          RIGHT JOIN c_table ON a_table.id = c_table.id
          WHERE a_table.id IS NOT NULL
        `);
        const rightJoin = query.joins.find((j) => j.type === 'RIGHT JOIN')!;
        const analysis = analysisForJoin(query, rightJoin.id);
        const aId = query.tables.find((t) => t.table === 'a_table')!.id;
        expect(analysis?.reasons.some((r) => r.kind === 'where' && r.label.includes('a_table.id'))).toBe(
          true,
        );
        expect(analysis?.nullableTableIds).toEqual([aId]);
      });
    });

    describe('WHERE / HAVING', () => {
      it('LEFT JOIN のみでは検出しない', () => {
        const query = parseSql(`
          SELECT * FROM table_a a
          LEFT JOIN table_b b ON b.a_id = a.id
        `);
        expect(analyzeEffectiveInnerJoins(query)).toHaveLength(0);
      });

      it('WHERE の nullable 列参照のみで where 理由を付ける', () => {
        const query = parseSql(`
          SELECT * FROM table_a a
          LEFT JOIN table_b b ON b.a_id = a.id
          WHERE b.col = 1
        `);
        const analysis = analysisForJoin(query, leftJoinByCondition(query, 'b.a_id')!.id);
        expect(analysis?.reasons).toEqual([
          expect.objectContaining({ kind: 'where', label: expect.stringContaining('b.col') }),
        ]);
      });

      it('HAVING の nullable 列参照のみで having 理由を付ける', () => {
        const query = parseSql(`
          SELECT a.id FROM table_a a
          LEFT JOIN table_b b ON b.a_id = a.id
          GROUP BY a.id
          HAVING SUM(b.q) > 1
        `);
        const analysis = analysisForJoin(query, leftJoinByCondition(query, 'b.a_id')!.id);
        expect(analysis?.reasons.some((r) => r.kind === 'having' && r.label.includes('b.q'))).toBe(true);
        expect(analysis?.reasons.some((r) => r.kind === 'inner_join')).toBe(false);
      });

      it('WHERE と HAVING の両方がある場合は両方の理由を持つ', () => {
        const query = parseSql(`
          SELECT a.id FROM table_a a
          LEFT JOIN table_b b ON b.a_id = a.id
          WHERE b.col = 1
          GROUP BY a.id
          HAVING COUNT(b.id) > 0
        `);
        const analysis = analysisForJoin(query, leftJoinByCondition(query, 'b.a_id')!.id);
        expect(analysis?.reasons.some((r) => r.kind === 'where')).toBe(true);
        expect(analysis?.reasons.some((r) => r.kind === 'having')).toBe(true);
        expect(analysis?.reasons.some((r) => r.kind === 'inner_join')).toBe(false);
      });

      it('BETWEEN / IN / LIKE も where 理由として検出する', () => {
        const between = parseSql(`
          SELECT * FROM table_a a LEFT JOIN table_b b ON b.a_id = a.id
          WHERE b.qty BETWEEN 1 AND 10
        `);
        const inQuery = parseSql(`
          SELECT * FROM table_a a LEFT JOIN table_b b ON b.a_id = a.id
          WHERE b.status IN (1, 2)
        `);
        const like = parseSql(`
          SELECT * FROM table_a a LEFT JOIN table_b b ON b.a_id = a.id
          WHERE b.name LIKE '%x%'
        `);

        for (const query of [between, inQuery, like]) {
          const analysis = analysisForJoin(query, leftJoinByCondition(query, 'b.a_id')!.id);
          expect(analysis?.reasons.some((r) => r.kind === 'where')).toBe(true);
        }
      });

      it('nullable 列の IS NULL は null 許容として検出しない', () => {
        const query = parseSql(`
          SELECT * FROM table_a a
          LEFT JOIN table_b b ON b.a_id = a.id
          WHERE b.id IS NULL
        `);
        expect(analyzeEffectiveInnerJoins(query)).toHaveLength(0);
      });

      it('IFNULL / COALESCE で包んだ nullable 参照だけでは検出しない', () => {
        const ifnull = parseSql(`
          SELECT * FROM table_a a
          LEFT JOIN table_b b ON b.a_id = a.id
          WHERE IFNULL(b.total, 0) = 0
        `);
        const coalesce = parseSql(`
          SELECT * FROM table_a a
          LEFT JOIN table_b b ON b.a_id = a.id
          WHERE COALESCE(b.total, 0) = 0
        `);
        expect(analyzeEffectiveInnerJoins(ifnull)).toHaveLength(0);
        expect(analyzeEffectiveInnerJoins(coalesce)).toHaveLength(0);
      });

      it('IFNULL と同時に裸の nullable 参照があれば where 理由を付ける', () => {
        const query = parseSql(`
          SELECT * FROM table_a a
          LEFT JOIN table_b b ON b.a_id = a.id
          WHERE IFNULL(b.total, 0) = 0 AND b.id = 1
        `);
        const analysis = analysisForJoin(query, leftJoinByCondition(query, 'b.a_id')!.id);
        expect(analysis?.reasons.some((r) => r.kind === 'where' && r.label.includes('b.id'))).toBe(true);
        expect(analysis?.reasons.some((r) => r.label.includes('IFNULL'))).toBe(false);
      });

      it('IFNULL の外側に裸の nullable 参照があれば検出する', () => {
        const query = parseSql(`
          SELECT * FROM table_a a
          LEFT JOIN table_b b ON b.a_id = a.id
          WHERE IFNULL(b.total, 0) = b.other
        `);
        const analysis = analysisForJoin(query, leftJoinByCondition(query, 'b.a_id')!.id);
        expect(analysis?.reasons.some((r) => r.kind === 'where')).toBe(true);
      });

      it('旧式外部結合 (+) でも WHERE の nullable 参照を検出する', () => {
        const query = parseSql(`SELECT a.id
FROM table_a a, table_b b
WHERE a.id = b.a_id(+)
  AND b.quantity > 0`);
        const analyses = analyzeEffectiveInnerJoins(query);
        expect(analyses.length).toBeGreaterThan(0);
        expect(
          analyses.some((a) =>
            a.reasons.some((r) => r.kind === 'where' && r.label.includes('b.quantity')),
          ),
        ).toBe(true);
      });
    });

    describe('OR 配下の保守的スキップ', () => {
      it('OR 直下の nullable 参照は検出しない', () => {
        const query = parseSql(`
          SELECT * FROM table_a a
          LEFT JOIN table_b b ON b.a_id = a.id
          WHERE b.col = 1 OR b.id IS NULL
        `);
        expect(analyzeEffectiveInnerJoins(query)).toHaveLength(0);
      });

      it('AND 直下の nullable 参照は OR グループ外なら検出する', () => {
        const query = parseSql(`
          SELECT * FROM table_a a
          LEFT JOIN table_b b ON b.a_id = a.id
          WHERE (b.col = 1 OR a.id = 1) AND b.id = 2
        `);
        const analysis = analysisForJoin(query, leftJoinByCondition(query, 'b.a_id')!.id);
        expect(analysis?.reasons.some((r) => r.kind === 'where' && r.label.includes('b.id'))).toBe(true);
      });

      it('OR グループ内のみの nullable 参照は AND と混在していても検出しない', () => {
        const query = parseSql(`
          SELECT * FROM table_a a
          LEFT JOIN table_b b ON b.a_id = a.id
          WHERE a.status = 1 AND (b.col = 1 OR b.id IS NULL)
        `);
        expect(analyzeEffectiveInnerJoins(query)).toHaveLength(0);
      });
    });

    describe('複数 LEFT JOIN の独立性', () => {
      it('サンプル SQL では categories LEFT JOIN は検出しない', () => {
        const query = parseSql(SAMPLE_SQL);
        const cJoin = query.joins.find((j) => j.type === 'LEFT JOIN' && j.condition.includes('p.category_id'));
        expect(cJoin).toBeDefined();
        expect(analyzeEffectiveInnerJoins(query).some((a) => a.joinId === cJoin!.id)).toBe(false);
      });

      it('同一クエリ内で検出対象と非対象の LEFT JOIN が混在する', () => {
        const query = parseSql(`
          SELECT u.id, o.order_no, p.name, c.name
          FROM users u
          INNER JOIN orders o ON o.user_id = u.id
          LEFT JOIN order_items oi ON oi.order_id = o.id
          INNER JOIN products p ON p.id = oi.product_id
          LEFT JOIN categories c ON c.id = p.category_id
        `);
        const analyses = analyzeEffectiveInnerJoins(query);
        expect(analyses).toHaveLength(1);
        expect(analyses[0]!.joinId).toBe(leftJoinByCondition(query, 'oi.order_id')!.id);
      });
    });

    describe('effectiveInnerAnalysisByJoinId', () => {
      it('検出結果を joinId キーの Map で返す', () => {
        const query = parseSql(SAMPLE_SQL);
        const map = effectiveInnerAnalysisByJoinId(query);
        const oiJoin = leftJoinByCondition(query, 'oi.order_id')!;

        expect(map.size).toBe(1);
        expect(map.get(oiJoin.id)?.reasons.length).toBeGreaterThan(0);
        expect(map.has(leftJoinByCondition(query, 'p.category_id')!.id)).toBe(false);
      });
    });

    describe('normalizeEffectiveInnerJoins', () => {
      it('実質 INNER JOIN の LEFT JOIN を INNER JOIN に正規化する', () => {
        const query = parseSql(`
          SELECT * FROM table_a a
          LEFT JOIN table_b b ON b.a_id = a.id
          WHERE b.col = 1
        `);
        const normalized = normalizeEffectiveInnerJoins(query);
        expect(normalized.joins.find((j) => j.condition.includes('b.a_id'))?.type).toBe('INNER JOIN');
      });

      it('実質 INNER JOIN でない LEFT JOIN はそのまま残す', () => {
        const query = parseSql(`
          SELECT * FROM table_a a
          LEFT JOIN table_b b ON b.a_id = a.id
        `);
        const normalized = normalizeEffectiveInnerJoins(query);
        expect(normalized.joins[0]?.type).toBe('LEFT JOIN');
      });

      it('CTE 内の実質 INNER JOIN も再帰的に正規化する', () => {
        const query = parseSql(`
          WITH paid AS (
            SELECT u.id, o.total
            FROM users u
            LEFT JOIN orders o ON u.id = o.user_id
            WHERE o.status = 'paid'
          )
          SELECT id FROM paid
        `);
        const normalized = normalizeEffectiveInnerJoins(query);
        expect(normalized.ctes?.[0]?.query.joins[0]?.type).toBe('INNER JOIN');
      });

      it('派生テーブル内の実質 INNER JOIN も再帰的に正規化する', () => {
        const query = parseSql(`
          SELECT p.id
          FROM (
            SELECT u.id
            FROM users u
            LEFT JOIN orders o ON u.id = o.user_id
            WHERE o.status = 'paid'
          ) p
        `);
        const derived = normalizeEffectiveInnerJoins(query).tables.find((t) => t.isDerived);
        expect(derived?.derivedQuery?.joins[0]?.type).toBe('INNER JOIN');
      });

      it('ignoreHavingReasons では HAVING 単独理由の LEFT JOIN を正規化しない', () => {
        const query = parseSql(`
          SELECT a.id, COUNT(b.id) AS cnt
          FROM table_a a
          LEFT JOIN table_b b ON b.a_id = a.id
          GROUP BY a.id
          HAVING COUNT(b.id) >= 0
        `);
        const withHaving = normalizeEffectiveInnerJoins(query);
        expect(withHaving.joins[0]?.type).toBe('INNER JOIN');

        const withoutHaving = normalizeEffectiveInnerJoins(query, { ignoreHavingReasons: true });
        expect(withoutHaving.joins[0]?.type).toBe('LEFT JOIN');
      });

      it('ignoreHavingReasons でも WHERE 理由があれば正規化する', () => {
        const query = parseSql(`
          SELECT a.id, COUNT(b.id) AS cnt
          FROM table_a a
          LEFT JOIN table_b b ON b.a_id = a.id
          WHERE b.col = 1
          GROUP BY a.id
          HAVING COUNT(b.id) >= 0
        `);
        const normalized = normalizeEffectiveInnerJoins(query, { ignoreHavingReasons: true });
        expect(normalized.joins[0]?.type).toBe('INNER JOIN');
      });
    });

    describe('旧式外部結合 (+)', () => {
      it('結合条件が WHERE に残っていても実質 INNER にしない', () => {
        const query = parseSql(
          'SELECT e.emp_no FROM employees e, departments d WHERE e.dept_no = d.dept_no(+)',
        );
        expect(query.joins[0]?.type).toBe('LEFT JOIN');
        expect(analyzeEffectiveInnerJoins(query)).toHaveLength(0);
      });

      it('(+) 付きの定数比較は結合条件の一部なので絞り込みに数えない', () => {
        const query = parseSql(`SELECT a.id
FROM t_a a, t_b b
WHERE a.id = b.a_id(+)
  AND b.status(+) = 'ACTIVE'`);
        expect(query.joins[0]?.type).toBe('LEFT JOIN');
        expect(analyzeEffectiveInnerJoins(query)).toHaveLength(0);
      });

      it('(+) を付け忘れた絞り込みは実質 INNER として検出する', () => {
        const query = parseSql(`SELECT a.id
FROM t_a a, t_b b
WHERE a.id = b.a_id(+)
  AND b.status = 'ACTIVE'`);
        const analysis = analysisForJoin(query, query.joins[0]!.id);
        expect(analysis).toBeDefined();
        expect(analysis!.reasons.some((r) => r.kind === 'where' && r.label.includes('b.status'))).toBe(
          true,
        );
      });

      it('複数の (+) 結合を持つサンプルで両方 LEFT JOIN のまま残る', () => {
        const query = parseSql(`SELECT e.emp_no, NVL(b.bonus_amount, 0) AS bonus_amount
FROM employees e, departments d, employees m, bonuses b
WHERE e.dept_no = d.dept_no
  AND e.manager_no = m.emp_no(+)
  AND e.emp_no = b.emp_no(+)
  AND b.fiscal_year(+) = 2024
  AND d.location IN ('TOKYO', 'OSAKA')
  AND e.hired_at >= TO_DATE('2015-04-01', 'YYYY-MM-DD')
ORDER BY d.dept_name, e.emp_no`);
        expect(analyzeEffectiveInnerJoins(query)).toHaveLength(0);
        expect(normalizeEffectiveInnerJoins(query).joins.filter((j) => j.type === 'LEFT JOIN')).toHaveLength(
          2,
        );
      });
    });
  });

  describe('formatEffectiveInnerCausePhrase', () => {
    it('inner_join がある場合は INNER JOIN のみを原因として返す', () => {
      expect(formatEffectiveInnerCausePhrase([{ kind: 'inner_join', label: 'INNER JOIN p' }])).toBe(
        '後続の INNER JOIN により',
      );
      expect(
        formatEffectiveInnerCausePhrase([
          { kind: 'inner_join', label: 'CROSS JOIN c', joinType: 'CROSS JOIN' },
        ]),
      ).toBe('後続の CROSS JOIN により');
      expect(
        formatEffectiveInnerCausePhrase([
          { kind: 'inner_join', label: 'INNER JOIN p' },
          { kind: 'where', label: 'WHERE: oi.q = 1' },
          { kind: 'having', label: 'HAVING: SUM(oi.q) > 1' },
        ]),
      ).toBe('後続の INNER JOIN により');
    });

    it('WHERE / HAVING のみの場合は該当句のみを列挙する', () => {
      expect(formatEffectiveInnerCausePhrase([{ kind: 'where', label: 'WHERE: b.col = 1' }])).toBe(
        'WHERE により',
      );
      expect(formatEffectiveInnerCausePhrase([{ kind: 'having', label: 'HAVING: SUM(b.q) > 1' }])).toBe(
        'HAVING により',
      );
      expect(
        formatEffectiveInnerCausePhrase([
          { kind: 'where', label: 'WHERE: b.col = 1' },
          { kind: 'having', label: 'HAVING: SUM(b.q) > 1' },
        ]),
      ).toBe('WHERE / HAVING により');
    });
  });

  describe('formatEffectiveInnerJoinScopeLine', () => {
    const nullableTable = {
      id: 'tbl-oi',
      table: 'order_items',
      alias: 'oi',
      displayName: 'oi',
    };

    it('LEFT JOIN では結論ファーストで説明し INNER JOIN 原因を優先する', () => {
      const line = formatEffectiveInnerJoinScopeLine(
        {
          id: 'join-1',
          type: 'LEFT JOIN',
          sourceId: 'tbl-o',
          targetId: 'tbl-oi',
          condition: 'oi.order_id = o.id',
        },
        'o',
        nullableTable,
        [
          { kind: 'inner_join', label: 'INNER JOIN products（p）' },
          { kind: 'where', label: 'WHERE: oi.quantity BETWEEN 1 AND 10' },
        ],
      );

      expect(line.startsWith('o と order_items（oi）は実質 INNER JOIN')).toBe(true);
      expect(line).toContain('後続の INNER JOIN により');
      expect(line).toContain('SQL上は LEFT JOIN');
      expect(line).not.toMatch(/^o の行をすべて残し/);
    });

    it('WHERE のみの場合は WHERE によりと記載する', () => {
      const line = formatEffectiveInnerJoinScopeLine(
        {
          id: 'join-1',
          type: 'LEFT JOIN',
          sourceId: 'tbl-a',
          targetId: 'tbl-b',
          condition: 'b.a_id = a.id',
        },
        'a',
        { id: 'tbl-b', table: 'table_b', alias: 'b', displayName: 'b' },
        [{ kind: 'where', label: 'WHERE: b.col = 1' }],
      );

      expect(line).toContain('WHERE により');
      expect(line).not.toContain('INNER JOIN により');
    });

    it('RIGHT JOIN でも preserved / nullable の向きに合わせて説明する', () => {
      const line = formatEffectiveInnerJoinScopeLine(
        {
          id: 'join-r',
          type: 'RIGHT JOIN',
          sourceId: 'tbl-a',
          targetId: 'tbl-b',
          condition: 'b.a_id = a.id',
        },
        'b',
        { id: 'tbl-a', table: 'table_a', alias: 'a', displayName: 'a' },
        [{ kind: 'inner_join', label: 'INNER JOIN table_d（d）' }],
      );

      expect(line.startsWith('b と table_a（a）は実質 INNER JOIN')).toBe(true);
      expect(line).toContain('SQL上は RIGHT JOIN');
      expect(line).toContain('後続の INNER JOIN により');
    });
  });
});
