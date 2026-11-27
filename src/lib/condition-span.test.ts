import { describe, expect, it } from 'vitest';
import { parseOracleQuery } from './parser';
import { SQL_TEST_CASES } from './fixtures/sql-cases';
import type { ConditionNode, ParsedQuery } from './types';

/**
 * WHERE・HAVING・ON の条件は、どれも SQL の中の位置を持つ。位置が無いと、作用説明の条件をクリックしても SQL を選べず、
 * エディタのカーソルとも連動しない。SQL パーサーは一部のノードに位置を返さない（`NOT EXISTS (…)` に位置が無かった）ので、
 * 共有のケース集の全件で確かめる。AND と OR はまとめの見出しなので、位置を持たなくてよい
 */
function conditionsWithoutSpan(sql: string, query: ParsedQuery): string[] {
  const missing: string[] = [];
  const seen = new Set<ParsedQuery>();
  const visitCondition = (node: ConditionNode | undefined, clause: string): void => {
    if (!node) return;
    if (!node.sourceSpan && node.type !== 'and' && node.type !== 'or') {
      missing.push(`${clause} の「${node.label}」 ← ${sql.slice(0, 60).replace(/\s+/g, ' ')}`);
    }
    node.children?.forEach((child) => visitCondition(child, clause));
    if (node.nestedQuery) visitQuery(node.nestedQuery);
  };
  const visitQuery = (q: ParsedQuery): void => {
    if (seen.has(q)) return;
    seen.add(q);
    visitCondition(q.where, 'WHERE');
    visitCondition(q.having, 'HAVING');
    q.joins.forEach((join) => visitCondition(join.conditionRoot, 'ON'));
    q.tables.forEach((table) => table.derivedQuery && visitQuery(table.derivedQuery));
    q.unionBranches?.forEach((branch) => visitQuery(branch.query));
    q.ctes?.forEach((cte) => visitQuery(cte.query));
  };
  visitQuery(query);
  return missing;
}

describe('条件の位置', () => {
  it('NOT EXISTS (…) も、SQL の中の位置を持つ', () => {
    const sql = 'SELECT e.id FROM emp e WHERE e.x = 1 AND NOT EXISTS (SELECT 1 FROM bonus b WHERE b.emp_id = e.id)';
    const result = parseOracleQuery(sql);
    if (!result.success) throw new Error(result.error.message);
    const node = result.query.where?.children?.[1];
    expect(node?.sourceSpan && sql.slice(node.sourceSpan.start, node.sourceSpan.end)).toBe(
      'NOT EXISTS (SELECT 1 FROM bonus b WHERE b.emp_id = e.id)',
    );
  });

  it('共有のケース集の全件で、WHERE・HAVING・ON の条件が位置を持つ', () => {
    const missing = SQL_TEST_CASES.flatMap(({ sql }) => {
      const result = parseOracleQuery(sql);
      return result.success ? conditionsWithoutSpan(sql, result.query) : [];
    });
    expect(missing).toEqual([]);
  });
});
