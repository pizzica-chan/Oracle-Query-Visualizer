import { describe, expect, it } from 'vitest';
import { Parser } from 'node-sql-parser';
import { applyAliasResolution } from './alias-resolver';
import { segmentEffectText } from './effect-text-highlight';
import {
  DELETE_SAMPLE_SQL,
  SAMPLE_SQL,
  UNION_SAMPLE_SQL,
  UPDATE_SAMPLE_SQL,
  exprToString,
  parseOracleQuery,
} from './parser';
import { buildQueryEffect, collectLeafTexts } from './query-effect';
import type { ConditionNode, ParsedQuery } from './types';

const sqlParser = new Parser();

/** SQL ソースからシングルクォート文字列リテラル（'...' / '' エスケープ対応）を抽出 */
function extractSingleQuotedLiterals(sql: string): string[] {
  const literals: string[] = [];
  let i = 0;

  while (i < sql.length) {
    if (sql[i] !== "'") {
      i += 1;
      continue;
    }

    let j = i + 1;
    while (j < sql.length) {
      if (sql[j] === "'") {
        if (sql[j + 1] === "'") {
          j += 2;
          continue;
        }
        literals.push(sql.slice(i, j + 1));
        i = j + 1;
        break;
      }
      j += 1;
    }
    if (j >= sql.length) break;
  }

  return literals;
}

function collectConditionLabels(node: ConditionNode | undefined): string[] {
  if (!node) return [];
  return [node.label, ...(node.children ?? []).flatMap(collectConditionLabels)];
}

/** 右画面の各タブが参照する表示用文字列を収集（サブクエリ・UNION 含む） */
function collectDisplayTexts(query: ParsedQuery): string[] {
  const texts: string[] = [
    ...query.columns.map((c) => c.expression),
    ...query.joins.flatMap((j) => [
      j.condition,
      ...(j.conditionRoot ? collectConditionLabels(j.conditionRoot) : []),
    ]),
    ...collectConditionLabels(query.where),
    ...collectConditionLabels(query.having),
    ...(query.setClauses ?? []).flatMap((s) => [s.label, s.value]),
    ...query.orderBy.map((o) => o.text),
  ];

  const walkCondition = (node: ConditionNode | undefined): void => {
    if (!node) return;
    if (node.nestedQuery) texts.push(...collectDisplayTexts(node.nestedQuery));
    node.children?.forEach(walkCondition);
  };
  walkCondition(query.where);
  walkCondition(query.having);
  for (const join of query.joins) walkCondition(join.conditionRoot);

  for (const table of query.tables) {
    if (table.derivedQuery) texts.push(...collectDisplayTexts(table.derivedQuery));
  }
  for (const branch of query.unionBranches ?? []) {
    texts.push(...collectDisplayTexts(branch.query));
  }

  return texts.filter(Boolean);
}

function findExistsCondition(node: ConditionNode | undefined): ConditionNode | undefined {
  if (!node) return undefined;
  if (node.type === 'exists') return node;
  for (const child of node.children ?? []) {
    const found = findExistsCondition(child);
    if (found) return found;
  }
  return undefined;
}

function parseOrThrow(sql: string): ParsedQuery {
  const result = parseOracleQuery(sql);
  expect(result.success).toBe(true);
  if (!result.success) throw new Error(result.error.message);
  return result.query;
}

function assertQuotedLiteralsPreserved(sql: string): void {
  const literals = extractSingleQuotedLiterals(sql);
  expect(literals.length).toBeGreaterThan(0);

  const query = parseOrThrow(sql);
  const display = collectDisplayTexts(query).join('\n');

  for (const literal of literals) {
    expect(display, `表示テキストに ${literal} が含まれる`).toContain(literal);
  }
}

describe('文字列リテラルのクォート保持', () => {
  describe('exprToString（AST → 表示文字列）', () => {
    it('single_quote_string に外側のクォートを付与する', () => {
      const ast = sqlParser.astify("SELECT 'hello'", { database: 'MySQL' }) as {
        columns: Array<{ expr: { type: string; value: string } }>;
      };
      expect(ast.columns[0]!.expr.type).toBe('single_quote_string');
      expect(exprToString(ast.columns[0]!.expr)).toBe("'hello'");
    });

    it('空文字列リテラルを正しく表現する', () => {
      const ast = sqlParser.astify("SELECT ''", { database: 'MySQL' }) as {
        columns: Array<{ expr: { type: string; value: string } }>;
      };
      expect(exprToString(ast.columns[0]!.expr)).toBe("''");
    });

    it('文字列内のシングルクォートを SQL 形式でエスケープする', () => {
      const sql = "SELECT 'it''s fine'";
      const ast = sqlParser.astify(sql, { database: 'MySQL' }) as {
        columns: Array<{ expr: { type: string; value: string } }>;
      };
      expect(exprToString(ast.columns[0]!.expr)).toBe("'it''s fine'");
    });

    it('IN リスト内の複数リテラルそれぞれにクォートを付与する', () => {
      const ast = sqlParser.astify("SELECT id FROM t WHERE status IN ('a', 'b')", {
        database: 'MySQL',
      }) as { where: { right: { type: string; value: unknown[] } } };
      const list = ast.where.right.value as Array<{ type: string; value: string }>;
      expect(exprToString(list[0])).toBe("'a'");
      expect(exprToString(list[1])).toBe("'b'");
    });

    it('double_quote_string にダブルクォートを付与する', () => {
      const ast = sqlParser.astify('SELECT "hello"', { database: 'MySQL' }) as {
        columns: Array<{ expr: { type: string; value: string } }>;
      };
      expect(ast.columns[0]!.expr.type).toBe('double_quote_string');
      expect(exprToString(ast.columns[0]!.expr)).toBe('"hello"');
    });

    it('数値リテラルにはクォートを付けない', () => {
      const ast = sqlParser.astify('SELECT 42', { database: 'MySQL' }) as {
        columns: Array<{ expr: { type: string; value: number } }>;
      };
      expect(exprToString(ast.columns[0]!.expr)).toBe('42');
    });
  });

  describe('句ごとのパース結果', () => {
    it('WHERE の比較式にクォートを残す', () => {
      const query = parseOrThrow("SELECT id FROM users WHERE status = 'active'");
      const labels = collectConditionLabels(query.where);
      expect(labels.some((l) => l.includes("status = 'active'"))).toBe(true);
      expect(labels.some((l) => /status\s*=\s*active\b/.test(l))).toBe(false);
    });

    it('LIKE パターンのクォートを残す', () => {
      const query = parseOrThrow("SELECT id FROM users WHERE email LIKE '%@example.com'");
      const labels = collectConditionLabels(query.where);
      expect(labels.some((l) => l.includes("LIKE '%@example.com'"))).toBe(true);
    });

    it('JOIN ON 内の文字列リテラルにクォートを付ける', () => {
      const query = parseOrThrow(`
        SELECT *
        FROM table_a a
        INNER JOIN table_b b ON b.kind = 'primary'
      `);
      expect(query.joins[0]?.condition).toBe("b.kind = 'primary'");
      expect(query.joins[0]?.conditionRoot?.right).toBe("'primary'");
    });

    it('JOIN ON の AND/OR 配下でもクォートを残す', () => {
      const query = parseOrThrow(`
        SELECT *
        FROM a
        JOIN b ON b.x = 1 AND (b.status = 'active' OR b.flag = 'Y')
      `);
      const labels = collectConditionLabels(query.joins[0]?.conditionRoot);
      expect(labels.some((l) => l.includes("b.status = 'active'"))).toBe(true);
      expect(labels.some((l) => l.includes("b.flag = 'Y'"))).toBe(true);
    });

    it('SET 句の値にクォートを残す', () => {
      const query = parseOrThrow("UPDATE users SET status = 'inactive' WHERE id = 1");
      expect(query.setClauses?.[0]?.value).toBe("'inactive'");
      expect(query.setClauses?.[0]?.label).toBe("status = 'inactive'");
    });

    it('SELECT 列の文字列リテラルにクォートを残す', () => {
      const query = parseOrThrow("SELECT id, 'active' AS source FROM users");
      expect(query.columns[1]?.expression).toBe("'active'");
    });

    it('IN 句の括弧内リテラルにクォートを残す', () => {
      const query = parseOrThrow("SELECT id FROM t WHERE status IN ('pending', 'hold')");
      const labels = collectConditionLabels(query.where);
      expect(labels.some((l) => l.includes("IN ('pending', 'hold')"))).toBe(true);
    });

    it('EXISTS サブクエリ内の文字列リテラルにクォートを残す', () => {
      const query = parseOrThrow(`
        SELECT u.id FROM users u
        WHERE EXISTS (
          SELECT 1 FROM payments p WHERE p.order_id = u.id AND p.status = 'paid'
        )
      `);
      const exists = findExistsCondition(query.where);
      const subLabels = collectConditionLabels(exists?.nestedQuery?.where);
      expect(subLabels.some((l) => l.includes("p.status = 'paid'"))).toBe(true);
    });

    it('エスケープを含む WHERE 条件を SQL 形式で復元する', () => {
      const sql = "SELECT id FROM t WHERE note = 'it''s fine'";
      const ast = sqlParser.astify(sql, { database: 'MySQL' }) as {
        where: { right: { type: string; value: string } };
      };
      expect(['it\'s fine', "it''s fine"]).toContain(ast.where.right.value);

      const query = parseOrThrow(sql);
      expect(query.where?.label).toBe("note = 'it''s fine'");
      expect(query.where?.right).toBe("'it''s fine'");
    });
  });

  describe('サンプル SQL 全体', () => {
    it('SELECT サンプルの文字列リテラルをすべて保持する', () => {
      assertQuotedLiteralsPreserved(SAMPLE_SQL);
    });

    it('UPDATE サンプルの文字列リテラルをすべて保持する', () => {
      assertQuotedLiteralsPreserved(UPDATE_SAMPLE_SQL);
    });

    it('DELETE サンプルの文字列リテラルをすべて保持する', () => {
      assertQuotedLiteralsPreserved(DELETE_SAMPLE_SQL);
    });

    it('UNION サンプルの文字列リテラルをすべて保持する', () => {
      assertQuotedLiteralsPreserved(UNION_SAMPLE_SQL);
    });

    it('SELECT サンプルの主要な条件表示にクォート付きリテラルが含まれる', () => {
      const query = parseOrThrow(SAMPLE_SQL);
      const texts = collectDisplayTexts(query);

      expect(texts.some((t) => t.includes("u.status = 'ACTIVE'"))).toBe(true);
      expect(texts.some((t) => t.includes("TO_DATE('2024-01-01', 'YYYY-MM-DD')"))).toBe(true);
      expect(texts.some((t) => t.includes("LIKE '%@example.com'"))).toBe(true);
      expect(texts.some((t) => t.includes("p.status = 'ACTIVE'"))).toBe(true);
      expect(texts.some((t) => t.includes("pay.status = 'PAID'"))).toBe(true);
    });
  });

  describe('作用説明・エイリアス解決', () => {
    it('作用説明の行の絞り込みにクォート付き WHERE を表示する', () => {
      const query = parseOrThrow(SAMPLE_SQL);
      const effect = buildQueryEffect(query);
      const filter = effect.sections.find((s) => s.kind === 'filter' && s.title === '行の絞り込み');
      const wherePart = filter?.filterParts?.find((p) => p.label === 'WHERE');
      const leafTexts = wherePart?.root ? collectLeafTexts(wherePart.root) : [];

      expect(leafTexts.some((t) => t.includes("u.status = 'ACTIVE'"))).toBe(true);
      expect(leafTexts.some((t) => t.includes("TO_DATE('2024-01-01', 'YYYY-MM-DD')"))).toBe(true);
    });

    it('作用説明の結合条件 ON にクォート付きリテラルを表示する', () => {
      const query = parseOrThrow(SAMPLE_SQL);
      const effect = buildQueryEffect(query);
      const filter = effect.sections.find((s) => s.kind === 'filter' && s.title === '行の絞り込み');
      const joinPart = filter?.filterParts?.find((p) => p.label === '結合条件');
      const leafTexts = joinPart?.root ? collectLeafTexts(joinPart.root) : [];

      expect(leafTexts.some((t) => t.includes("p.status = 'ACTIVE'"))).toBe(true);
    });

    it('エイリアス解決後も文字列リテラルのクォートを落とさない', () => {
      const query = parseOrThrow(SAMPLE_SQL);
      const resolved = applyAliasResolution(query, true);
      const texts = collectDisplayTexts(resolved);

      expect(texts.some((t) => t.includes("status = 'ACTIVE'"))).toBe(true);
      expect(texts.some((t) => t.includes("p.status = 'ACTIVE'") || t.includes("products.status = 'ACTIVE'"))).toBe(true);
      expect(texts.some((t) => t.includes("LIKE '%@example.com'"))).toBe(true);
      expect(texts.some((t) => t.includes("= 'PAID'"))).toBe(true);
    });
  });

  describe('作用説明ハイライト', () => {
    it('シングルクォート文字列を欠落なくセグメント化する', () => {
      const query = parseOrThrow("SELECT id FROM users WHERE status = 'active'");
      const input = "u.status = 'active' AND o.status = 'pending'";
      const restored = segmentEffectText(input, query).map((s) => s.text).join('');
      expect(restored).toBe(input);
    });

    it('エスケープを含む文字列リテラルを1セグメントとして扱う', () => {
      const query = parseOrThrow("SELECT id FROM t WHERE note = 'it''s fine'");
      const input = "note = 'it''s fine'";
      const segments = segmentEffectText(input, query);
      expect(segments.some((s) => s.kind === 'string' && s.text === "'it''s fine'")).toBe(true);
      expect(segments.map((s) => s.text).join('')).toBe(input);
    });

    it('複数の文字列リテラルをそれぞれハイライトする', () => {
      const query = parseOrThrow("SELECT id FROM t WHERE status IN ('a', 'b')");
      const input = "status IN ('a', 'b')";
      const stringSegments = segmentEffectText(input, query).filter((s) => s.kind === 'string');
      expect(stringSegments.map((s) => s.text)).toEqual(["'a'", "'b'"]);
    });
  });

  describe('回帰防止', () => {
    const regressionCases: Array<{ name: string; sql: string; mustContain: string[]; mustNotContain?: string[] }> = [
      {
        name: 'WHERE 比較',
        sql: "SELECT id FROM users WHERE status = 'active'",
        mustContain: ["status = 'active'"],
        mustNotContain: ['status = active'],
      },
      {
        name: 'JOIN ON',
        sql: "SELECT * FROM a JOIN b ON b.kind = 'primary'",
        mustContain: ["b.kind = 'primary'"],
        mustNotContain: ['b.kind = primary'],
      },
      {
        name: 'SET 句',
        sql: "UPDATE users SET status = 'inactive' WHERE id = 1",
        mustContain: ["status = 'inactive'"],
        mustNotContain: ["status = 'inactive'".replace(/'/g, '')], // status = inactive
      },
      {
        name: 'SELECT 列リテラル',
        sql: "SELECT 'guest' AS role FROM users",
        mustContain: ["'guest'"],
        mustNotContain: ['= guest'],
      },
    ];

    for (const { name, sql, mustContain, mustNotContain } of regressionCases) {
      it(`クォートなしの裸値に戻らない: ${name}`, () => {
        const display = collectDisplayTexts(parseOrThrow(sql)).join('\n');
        for (const text of mustContain) {
          expect(display).toContain(text);
        }
        for (const text of mustNotContain ?? []) {
          expect(display).not.toContain(text);
        }
      });
    }

    it('exprToString が single_quote_string で裸の値を返さない', () => {
      const ast = sqlParser.astify("SELECT 'active'", { database: 'MySQL' }) as {
        columns: Array<{ expr: { type: string; value: string } }>;
      };
      const rendered = exprToString(ast.columns[0]!.expr);
      expect(rendered).toBe("'active'");
      expect(rendered).not.toBe('active');
      expect(rendered.startsWith("'")).toBe(true);
      expect(rendered.endsWith("'")).toBe(true);
    });
  });
});
