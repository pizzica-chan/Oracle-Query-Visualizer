import { describe, expect, it } from 'vitest';
import { parseOracleQuery } from './parser';
import type { ConditionNode } from './types';

/** 条件木を `OR(a, AND(b, c))` の形の文字列にする */
function show(node: ConditionNode | undefined): string {
  if (!node) return '-';
  if (node.type === 'and' || node.type === 'or') {
    return `${node.operator}(${(node.children ?? []).map(show).join(', ')})`;
  }
  if (node.type === 'not') return `NOT(${(node.children ?? []).map(show).join(', ')})`;
  return node.label;
}

function whereOf(sql: string): string {
  const result = parseOracleQuery(sql);
  if (!result.success) throw new Error(result.error.message);
  return show(result.query.where ?? result.query.having);
}

describe('AND と OR の優先順位（Oracle Database 23 SQL Language Reference「Condition Precedence」）', () => {
  it.each([
    ['t.a = 1 OR t.b = 2 AND t.c = 3', 'OR(t.a = 1, AND(t.b = 2, t.c = 3))'],
    ['t.a = 1 AND t.b = 2 OR t.c = 3 AND t.d = 4', 'OR(AND(t.a = 1, t.b = 2), AND(t.c = 3, t.d = 4))'],
    ['(t.a = 1 OR t.b = 2) AND t.c = 3', 'AND(OR(t.a = 1, t.b = 2), t.c = 3)'],
    ['t.a = 1 OR t.b = 2 AND (t.c = 3 OR t.d = 4) AND t.e = 5', 'OR(t.a = 1, AND(t.b = 2, OR(t.c = 3, t.d = 4), t.e = 5))'],
    ['NOT t.a = 1 OR t.b = 2 AND t.c = 3', 'OR(NOT(t.a = 1), AND(t.b = 2, t.c = 3))'],
    ['t.a BETWEEN 1 AND 5 OR t.b = 2 AND t.c = 3', 'OR(t.a BETWEEN 1 AND 5, AND(t.b = 2, t.c = 3))'],
  ])('WHERE %s', (condition, expected) => {
    expect(whereOf(`SELECT t.a FROM t WHERE ${condition}`)).toBe(expected);
  });

  it('HAVING・サブクエリの中・UPDATE・DELETE でも AND を先に結び付ける', () => {
    const expected = 'OR(t.a = 1, AND(t.b = 2, t.c = 3))';
    expect(whereOf('UPDATE t SET t.a = 1 WHERE t.a = 1 OR t.b = 2 AND t.c = 3')).toBe(expected);
    expect(whereOf('DELETE FROM t WHERE t.a = 1 OR t.b = 2 AND t.c = 3')).toBe(expected);
    expect(whereOf('SELECT t.a FROM t GROUP BY t.a HAVING COUNT(*) > 1 OR SUM(t.b) > 2 AND MAX(t.c) > 3')).toBe(
      'OR(COUNT(*) > 1, AND(SUM(t.b) > 2, MAX(t.c) > 3))',
    );
    const result = parseOracleQuery('SELECT t.a FROM t WHERE EXISTS (SELECT 1 FROM u WHERE u.a = 1 OR u.b = 2 AND u.c = 3)');
    if (!result.success) throw new Error(result.error.message);
    expect(show(result.query.where?.nestedQuery?.where)).toBe('OR(u.a = 1, AND(u.b = 2, u.c = 3))');
  });

  it('組み直しても、条件全体の範囲は元の SQL の条件全体を指す', () => {
    const sql = 'SELECT t.a FROM t WHERE t.a = 1 OR t.b = 2 AND t.c = 3';
    const result = parseOracleQuery(sql);
    if (!result.success) throw new Error(result.error.message);
    const span = result.query.where!.sourceSpan!;
    expect(sql.slice(span.start, span.end)).toBe('t.a = 1 OR t.b = 2 AND t.c = 3');
  });

  // Oracle の || は文字列の連結で、比較より先に結び付く。論理演算として組み直さない
  it('|| は文字列の連結として読み、AND / OR の組み直しに巻き込まない', () => {
    expect(whereOf("SELECT t.a FROM t WHERE t.a || 'x' = 'y' OR t.b = 1 AND t.c = 2")).toBe(
      "OR(t.a || 'x' = 'y', AND(t.b = 1, t.c = 2))",
    );
  });

  it('カンマ結合の結合条件を含む WHERE でも組み直す', () => {
    expect(whereOf('SELECT a.x FROM a, b WHERE a.id = b.id AND b.f = 1 OR a.g = 2')).toBe(
      'OR(AND(a.id = b.id, b.f = 1), a.g = 2)',
    );
  });

  // (+) を含む条件は OR でつなげない（SQL Language Reference「Joins」）。組み直した木で OR の下に来たらエラーにする
  it('(+) を含む条件が OR の下に来る WHERE はエラーにする', () => {
    const result = parseOracleQuery('SELECT a.x FROM a, b WHERE a.id = b.id(+) AND b.f = 1 OR a.g = 2');
    expect(result.success).toBe(false);
  });
});
