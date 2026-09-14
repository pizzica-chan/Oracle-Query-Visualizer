import { ORACLE_SQL_TEST_CASES } from './oracle-cases';
import type { ConditionNode, ParsedQuery } from '../types';

export type SqlTestCategory =
  | 'basic'
  | 'oracle'
  | 'complex'
  | 'dirty'
  | 'edge'
  | 'update'
  | 'delete'
  | 'union'
  | 'subquery'
  | 'regression'
  | 'error';

export interface SqlTestCase {
  name: string;
  category: SqlTestCategory;
  sql: string;
  expectSuccess: boolean;
  /** 成功時の追加検証 */
  assert?: (query: ParsedQuery) => void;
  /** 失敗時にエラーメッセージに含まれる文字列 */
  errorContains?: string;
}

export function assertSuccess(result: { success: boolean }): asserts result is { success: true; query: ParsedQuery } {
  if (!result.success) {
    throw new Error(`Expected success but got: ${JSON.stringify(result)}`);
  }
}

export function collectConditionTypes(root: ConditionNode | undefined): ConditionNode['type'][] {
  if (!root) return [];
  const types = [root.type];
  for (const child of root.children ?? []) {
    types.push(...collectConditionTypes(child));
  }
  return types;
}

export function tableNames(query: ParsedQuery): string[] {
  return query.tables.map((t) => t.table);
}

export function joinTypes(query: ParsedQuery): string[] {
  return query.joins.map((j) => j.type);
}

export function hasOrNode(node: ConditionNode | undefined): boolean {
  if (!node) return false;
  if (node.type === 'or') return true;
  return (node.children ?? []).some(hasOrNode);
}

export function findCondition(
  root: ConditionNode | undefined,
  predicate: (n: ConditionNode) => boolean,
): ConditionNode | undefined {
  if (!root) return undefined;
  if (predicate(root)) return root;
  for (const child of root.children ?? []) {
    const found = findCondition(child, predicate);
    if (found) return found;
  }
  return undefined;
}

export function countConditionsOfType(
  root: ConditionNode | undefined,
  type: ConditionNode['type'],
): number {
  if (!root) return 0;
  let count = root.type === type ? 1 : 0;
  for (const child of root.children ?? []) {
    count += countConditionsOfType(child, type);
  }
  return count;
}

function exLabelIncludesNot(node: ConditionNode): boolean {
  return node.label.toUpperCase().includes('NOT EXISTS');
}

export const SQL_TEST_CASES: SqlTestCase[] = [
  // --- basic ---
  {
    name: '単一テーブル・単純WHERE',
    category: 'basic',
    sql: "SELECT id, name FROM users WHERE status = 'active'",
    expectSuccess: true,
    assert: (q) => {
      if (tableNames(q).join() !== 'users') throw new Error('table mismatch');
      if (q.joins.length !== 0) throw new Error('no joins expected');
      if (q.where?.type !== 'comparison') throw new Error('where type');
    },
  },
  {
    name: 'SELECT * のみ',
    category: 'basic',
    sql: 'SELECT * FROM products',
    expectSuccess: true,
    assert: (q) => {
      if (q.columns[0]?.expression !== '*') throw new Error('expected *');
    },
  },

  // --- complex ---
  {
    name: 'サンプルクエリ（多段JOIN + 複合WHERE + HAVING）',
    category: 'complex',
    sql: `SELECT
  u.id, u.name, u.email,
  o.order_no, o.total_amount,
  p.product_name, c.category_name
FROM users u
INNER JOIN orders o ON o.user_id = u.id
LEFT JOIN order_items oi ON oi.order_id = o.id
INNER JOIN products p ON p.id = oi.product_id
LEFT JOIN categories c ON c.id = p.category_id
WHERE u.status = 'active'
  AND o.created_at >= TO_DATE('2024-01-01', 'YYYY-MM-DD')
  AND (o.total_amount > 1000 OR u.email LIKE '%@example.com')
  AND p.category_id IN (1, 2, 3)
  AND oi.quantity BETWEEN 1 AND 10
GROUP BY u.id, u.name, u.email, o.order_no, o.total_amount, p.product_name, c.category_name
HAVING SUM(oi.quantity) > 5
ORDER BY o.created_at DESC, o.total_amount DESC
FETCH FIRST 100 ROWS ONLY`,
    expectSuccess: true,
    assert: (q) => {
      if (q.tables.length !== 5) throw new Error(`expected 5 tables, got ${q.tables.length}`);
      if (q.joins.length !== 4) throw new Error(`expected 4 joins, got ${q.joins.length}`);
      const wTypes = collectConditionTypes(q.where);
      if (!wTypes.includes('and')) throw new Error('missing and');
      if (!wTypes.includes('or')) throw new Error('missing or');
      if (!wTypes.includes('like')) throw new Error('missing like');
      if (!wTypes.includes('in')) throw new Error('missing in');
      if (!wTypes.includes('between')) throw new Error('missing between');
      if (!q.having) throw new Error('missing having');
      if (q.groupBy.length !== 7) throw new Error(`groupBy count ${q.groupBy.length}`);
      if (q.orderBy.length !== 2) throw new Error('orderBy count');
      if (q.limit !== '100') throw new Error(`limit ${q.limit}`);
    },
  },
  {
    name: 'RIGHT JOIN + FULL JOIN + CROSS JOIN 混在',
    category: 'complex',
    sql: `SELECT a.id, b.name, c.val
FROM schema_a.table_a a
RIGHT JOIN table_b b ON b.a_id = a.id
FULL JOIN table_c c ON c.b_id = b.id
CROSS JOIN table_d d
WHERE a.deleted_at IS NULL AND b.score > 0`,
    expectSuccess: true,
    assert: (q) => {
      const types = joinTypes(q);
      if (!types.includes('RIGHT JOIN')) throw new Error('missing RIGHT JOIN');
      if (!types.includes('FULL JOIN')) throw new Error('missing FULL JOIN');
      if (!types.includes('CROSS JOIN')) throw new Error('missing CROSS JOIN');
      if (q.tables[0]?.schema !== 'schema_a') throw new Error('schema');
      const wTypes = collectConditionTypes(q.where);
      if (!wTypes.includes('is_null')) throw new Error('missing IS NULL');
    },
  },
  {
    name: '深くネストした WHERE（AND/OR/NOT）',
    category: 'complex',
    sql: `SELECT id FROM t WHERE
      a = 1
      AND (b = 2 OR c = 3)
      AND NOT (d = 4 OR (e = 5 AND f = 6))
      AND g IN (10, 20, 30)
      AND h NOT IN (1, 2)
      AND i BETWEEN 1 AND 99
      AND j NOT BETWEEN 0 AND 5`,
    expectSuccess: true,
    assert: (q) => {
      const types = collectConditionTypes(q.where);
      if (!types.includes('not')) throw new Error('missing not');
      if (types.filter((t) => t === 'in').length < 2) throw new Error('expected 2 in nodes');
      if (types.filter((t) => t === 'between').length < 2) throw new Error('expected 2 between nodes');
    },
  },
  {
    name: '集約関数・CASE・DISTINCT',
    category: 'complex',
    sql: `SELECT DISTINCT
  u.dept,
  COUNT(*) AS cnt,
  SUM(o.amount) AS total,
  CASE WHEN u.vip = 1 THEN 'VIP' ELSE 'NORMAL' END AS tier
FROM users u
LEFT JOIN orders o ON o.user_id = u.id
WHERE o.status IS NOT NULL
GROUP BY u.dept, tier
HAVING COUNT(*) >= 10
ORDER BY total DESC
OFFSET 10 ROWS FETCH NEXT 50 ROWS ONLY`,
    expectSuccess: true,
    assert: (q) => {
      if (!q.distinct) throw new Error('distinct expected');
      if (q.limit !== '50') throw new Error(`limit ${q.limit}`);
      if (q.offset !== '10') throw new Error(`offset ${q.offset}`);
      if (!q.having) throw new Error('having expected');
      if (q.columns.some((c) => c.alias === 'cnt')) {
        /* ok */
      } else {
        throw new Error('alias cnt');
      }
    },
  },
  {
    name: '引用識別子（大文字小文字を保持する "..."）',
    category: 'complex',
    sql: 'SELECT "U"."ID", "O"."TOTAL" AS "SumTotal" FROM "MY_DB"."USERS" "U" JOIN "ORDERS" "O" ON "O"."USER_ID" = "U"."ID"',
    expectSuccess: true,
    assert: (q) => {
      if (q.tables.length !== 2) throw new Error('2 tables');
      if (q.joins.length !== 1) throw new Error('1 join');
    },
  },
  {
    name: '複数JOIN条件（AND結合）',
    category: 'complex',
    sql: 'SELECT * FROM a JOIN b ON a.id = b.a_id AND a.org = b.org AND a.ver = b.ver WHERE a.flag = 1',
    expectSuccess: true,
    assert: (q) => {
      if (!q.joins[0]?.condition.includes('AND')) throw new Error('compound ON expected');
    },
  },

  // --- dirty ---
  {
    name: '汚いSQL: 過剰空白・改行・タブ混在',
    category: 'dirty',
    sql: `
      SELECT    u.id   ,   u.name


      FROM     users    u


      INNER   JOIN   orders   o   ON   o.user_id   =   u.id


      WHERE    u.status   =   'active'     AND    o.total   >   100
    `,
    expectSuccess: true,
    assert: (q) => {
      if (q.tables.length !== 2) throw new Error('tables');
      if (q.where?.type !== 'and') throw new Error('and root');
    },
  },
  {
    name: '汚いSQL: キーワード大小混在',
    category: 'dirty',
    sql: "SeLeCt u.Id FrOm UsErS u LeFt JoIn OrDeRs o On o.user_id = u.id WhErE u.NaMe LiKe '%test%'",
    expectSuccess: true,
    assert: (q) => {
      if (joinTypes(q)[0] !== 'LEFT JOIN') throw new Error('LEFT JOIN');
      if (collectConditionTypes(q.where).includes('like')) {
        /* ok */
      } else {
        throw new Error('like');
      }
    },
  },
  {
    name: '汚いSQL: セミコロンなし・末尾ゴミ空白',
    category: 'dirty',
    sql: '  SELECT 1 FROM dual WHERE 1=1   ',
    expectSuccess: true,
    assert: (q) => {
      if (q.limit !== undefined) throw new Error('no limit');
    },
  },
  {
    name: '汚いSQL: カンマ区切りFROM（旧式）',
    category: 'dirty',
    sql: "SELECT a.id, b.name FROM table_a a, table_b b WHERE a.id = b.a_id AND b.status = 'x'",
    expectSuccess: true,
    assert: (q) => {
      if (q.tables.length !== 2) throw new Error('2 tables from comma join');
    },
  },
  {
    name: '汚いSQL: 括弧だらけのWHERE',
    category: 'dirty',
    sql: 'SELECT id FROM t WHERE (((((status = 1))))) AND ((((type = 2))))',
    expectSuccess: true,
    assert: (q) => {
      if (q.where?.type !== 'and') throw new Error('and');
    },
  },
  {
    name: '汚いSQL: 文字列中にクォートエスケープ',
    category: 'dirty',
    sql: "SELECT id FROM users WHERE name = 'O''Brien' AND note LIKE '%it''s%'",
    expectSuccess: true,
    assert: (q) => {
      if (!q.where) throw new Error('where');
    },
  },
  {
    name: '汚いSQL: 1行に詰め込み',
    category: 'dirty',
    sql: "SELECT u.id,o.total FROM users u INNER JOIN orders o ON o.uid=u.id WHERE u.s=1 AND o.t>0 GROUP BY u.id ORDER BY o.total FETCH FIRST 10 ROWS ONLY",
    expectSuccess: true,
    assert: (q) => {
      if (q.limit !== '10') throw new Error('limit');
      if (q.groupBy.length !== 1) throw new Error('groupBy');
    },
  },
  {
    name: '汚いSQL: JOINキーワード省略（JOINのみ）',
    category: 'dirty',
    sql: 'SELECT * FROM a JOIN b ON a.id = b.a_id',
    expectSuccess: true,
    assert: (q) => {
      const t = joinTypes(q)[0];
      if (t !== 'JOIN' && t !== 'INNER JOIN') throw new Error(`JOIN type: ${t}`);
    },
  },
  {
    name: '汚いSQL: SQLコメント混在',
    category: 'dirty',
    sql: `-- header comment
SELECT id, name /* inline */ FROM users
-- trailing table comment
WHERE status = 1`,
    expectSuccess: true,
    assert: (q) => {
      if (tableNames(q)[0] !== 'users') throw new Error('users');
      if (q.columns.length !== 2) throw new Error('2 columns');
    },
  },
  {
    name: '汚いSQL: 3テーブルカンマJOIN',
    category: 'dirty',
    sql: "SELECT a.x FROM t_a a, t_b b, t_c c WHERE a.id=b.aid AND b.id=c.bid AND c.flag='y'",
    expectSuccess: true,
    assert: (q) => {
      if (q.tables.length !== 3) throw new Error('3 tables');
    },
  },
  {
    name: '汚いSQL: 比較演算子だらけ',
    category: 'dirty',
    sql: 'SELECT id FROM t WHERE a <> 0 AND b != 1 AND c >= 2 AND d <= 3 AND e > 4 AND f < 5',
    expectSuccess: true,
    assert: (q) => {
      const types = collectConditionTypes(q.where);
      if (types.filter((t) => t === 'comparison').length < 6) {
        throw new Error('comparisons');
      }
    },
  },

  // --- edge (continued) ---
  {
    name: 'WHEREなし・JOINなし',
    category: 'edge',
    sql: 'SELECT id, name FROM items',
    expectSuccess: true,
    assert: (q) => {
      if (q.where !== undefined) throw new Error('no where');
      if (q.joins.length !== 0) throw new Error('no joins');
    },
  },
  {
    name: 'FETCH FIRST 0 ROWS ONLY',
    category: 'edge',
    sql: 'SELECT id FROM t FETCH FIRST 0 ROWS ONLY',
    expectSuccess: true,
    assert: (q) => {
      if (q.limit !== '0') throw new Error(`limit ${q.limit}`);
    },
  },
  {
    name: 'ORDER BY 複数列・ASC/DESC混在',
    category: 'edge',
    sql: 'SELECT a, b, c FROM t ORDER BY a ASC, b DESC, c',
    expectSuccess: true,
    assert: (q) => {
      if (q.orderBy.length !== 3) throw new Error('orderBy');
      if (!q.orderBy[1]?.text.includes('DESC')) throw new Error('DESC');
    },
  },
  {
    name: 'サブクエリを含むWHERE（EXISTS）',
    category: 'edge',
    sql: 'SELECT id FROM users u WHERE EXISTS (SELECT 1 FROM orders o WHERE o.user_id = u.id)',
    expectSuccess: true,
    assert: (q) => {
      const types = collectConditionTypes(q.where);
      if (!types.includes('exists')) throw new Error('exists');
    },
  },
  {
    name: '末尾セミコロン付きの単文',
    category: 'edge',
    sql: 'SELECT id FROM users WHERE status = 1;',
    expectSuccess: true,
    assert: (q) => {
      if (tableNames(q)[0] !== 'users') throw new Error('users expected');
    },
  },
  {
    name: '複文は 2 文目以降を捨てずにエラーにする',
    category: 'error',
    sql: 'SELECT id FROM users WHERE status = 1; SELECT id FROM orders',
    expectSuccess: false,
    errorContains: '複数の文',
  },
  {
    name: '先頭セミコロン付きの単文（astify の空要素を文数に数えない）',
    category: 'edge',
    sql: ';SELECT id FROM users WHERE status = 1',
    expectSuccess: true,
    assert: (q) => {
      if (tableNames(q)[0] !== 'users') throw new Error('users expected');
    },
  },
  {
    name: 'ORのみのWHEREルート',
    category: 'edge',
    sql: 'SELECT id FROM t WHERE a = 1 OR b = 2 OR c = 3',
    expectSuccess: true,
    assert: (q) => {
      if (!hasOrNode(q.where)) throw new Error('or expected');
    },
  },
  {
    name: '数値・NULLリテラル混在',
    category: 'edge',
    sql: 'SELECT id FROM t WHERE score IS NULL OR score IS NOT NULL OR cnt = 0',
    expectSuccess: true,
    assert: (q) => {
      const types = collectConditionTypes(q.where);
      if (!types.includes('is_null')) throw new Error('is_null');
      if (!types.includes('or')) throw new Error('or');
    },
  },
  {
    name: '列エイリアス付きSELECT',
    category: 'edge',
    sql: 'SELECT id AS user_id, CONCAT(last_name, first_name) AS full_name FROM users',
    expectSuccess: true,
    assert: (q) => {
      if (!q.columns.some((c) => c.alias === 'user_id')) throw new Error('user_id alias');
      if (!q.columns.some((c) => c.alias === 'full_name')) throw new Error('full_name alias');
    },
  },

  // --- update ---
  {
    name: 'UPDATE: 単一テーブル',
    category: 'update',
    sql: "UPDATE users SET status = 'INACTIVE', updated_at = SYSDATE WHERE id = 1",
    expectSuccess: true,
    assert: (q) => {
      if (q.statementType !== 'UPDATE') throw new Error('UPDATE');
      if (q.setClauses?.length !== 2) throw new Error('2 set clauses');
      if (q.joins.length !== 0) throw new Error('no joins');
    },
  },
  {
    name: 'UPDATE: 相関サブクエリ + EXISTS（Oracle の JOIN 相当）',
    category: 'update',
    sql: `UPDATE users u
SET u.status = 'INACTIVE',
    u.last_order_no = (SELECT MAX(o.order_no) FROM orders o WHERE o.user_id = u.id)
WHERE u.last_login_at < TO_DATE('2023-01-01', 'YYYY-MM-DD')
  AND u.status IN ('PENDING', 'HOLD')
  AND EXISTS (SELECT 1 FROM orders o WHERE o.user_id = u.id AND o.total > 0)`,
    expectSuccess: true,
    assert: (q) => {
      if (q.statementType !== 'UPDATE') throw new Error('UPDATE');
      if (q.tables.length !== 1) throw new Error('1 table');
      if (q.setClauses?.length !== 2) throw new Error('2 set clauses');
      const types = collectConditionTypes(q.where);
      if (!types.includes('in')) throw new Error('in');
      if (!types.includes('exists')) throw new Error('exists');
    },
  },
  {
    name: 'UPDATE: インラインビュー（副問合せを更新対象にする）',
    category: 'update',
    sql: `UPDATE (
  SELECT u.status AS status, o.total AS total
  FROM users u INNER JOIN orders o ON o.user_id = u.id
  WHERE o.total > 0
) SET status = 'ACTIVE'`,
    expectSuccess: true,
    assert: (q) => {
      if (q.statementType !== 'UPDATE') throw new Error('UPDATE');
      if (q.setClauses?.length !== 1) throw new Error('1 set clause');
    },
  },
  {
    name: 'UPDATE: スキーマ付きテーブル',
    category: 'update',
    sql: "UPDATE mydb.users SET name = 'x' WHERE status = 1",
    expectSuccess: true,
    assert: (q) => {
      if (q.tables[0]?.schema !== 'mydb') throw new Error('schema');
    },
  },

  // --- delete ---
  {
    name: 'DELETE: 単一テーブル',
    category: 'delete',
    sql: 'DELETE FROM users WHERE id = 1',
    expectSuccess: true,
    assert: (q) => {
      if (q.statementType !== 'DELETE') throw new Error('DELETE');
      if (q.joins.length !== 0) throw new Error('no joins');
      if (q.deleteTargets?.length !== 1) throw new Error('1 target');
    },
  },
  {
    name: 'DELETE: エイリアス + EXISTS（Oracle の JOIN 相当）',
    category: 'delete',
    sql: `DELETE FROM users u
WHERE u.status = 'DELETED'
  AND EXISTS (SELECT 1 FROM orders o WHERE o.user_id = u.id AND o.total = 0)`,
    expectSuccess: true,
    assert: (q) => {
      if (q.tables.length !== 1) throw new Error('1 table');
      if (q.deleteTargets?.[0]?.name !== 'users') throw new Error('target users');
      if (!collectConditionTypes(q.where).includes('exists')) throw new Error('exists');
    },
  },
  {
    name: 'DELETE: FROM 省略形（Oracle 固有）',
    category: 'delete',
    sql: "DELETE users WHERE status = 'DELETED'",
    expectSuccess: true,
    assert: (q) => {
      if (q.statementType !== 'DELETE') throw new Error('DELETE');
      if (tableNames(q)[0] !== 'users') throw new Error('users');
    },
  },
  {
    name: 'DELETE: ROWNUM で件数制限 + IN',
    category: 'delete',
    sql: 'DELETE FROM mydb.users WHERE status IN (1, 2) AND ROWNUM <= 10',
    expectSuccess: true,
    assert: (q) => {
      if (q.tables[0]?.schema !== 'mydb') throw new Error('schema');
      if (!collectConditionTypes(q.where).includes('in')) throw new Error('in');
      const rownum = findCondition(q.where, (n) => Boolean(n.isRownum));
      if (!rownum) throw new Error('ROWNUM condition');
    },
  },

  // --- union ---
  {
    name: 'UNION ALL: 2ブランチ',
    category: 'union',
    sql: `SELECT id FROM users WHERE status = 'active'
UNION ALL
SELECT id FROM archived_users WHERE archived_at IS NOT NULL`,
    expectSuccess: true,
    assert: (q) => {
      if (!q.unionBranches || q.unionBranches.length !== 2) {
        throw new Error(`expected 2 union branches, got ${q.unionBranches?.length}`);
      }
      if (q.unionBranches[1]?.operator !== 'UNION ALL') throw new Error('UNION ALL operator');
      if (tableNames(q.unionBranches[0]?.query ?? q).join() !== 'users') throw new Error('branch0 table');
      if (q.unionBranches[1]?.query.tables[0]?.table !== 'archived_users') throw new Error('branch1 table');
    },
  },
  {
    name: 'UNION: 重複排除',
    category: 'union',
    sql: `SELECT email FROM users
UNION
SELECT email FROM guest_users`,
    expectSuccess: true,
    assert: (q) => {
      if (q.unionBranches?.length !== 2) throw new Error('2 branches');
      if (q.unionBranches[1]?.operator !== 'UNION') throw new Error('UNION operator');
    },
  },
  {
    name: 'UNION: 3ブランチ（ALL + UNION 混在）',
    category: 'union',
    sql: `SELECT id FROM a WHERE x = 1
UNION ALL
SELECT id FROM b WHERE y = 2
UNION
SELECT id FROM c WHERE z = 3`,
    expectSuccess: true,
    assert: (q) => {
      if (q.unionBranches?.length !== 3) throw new Error('3 branches');
      if (q.unionBranches[1]?.operator !== 'UNION ALL') throw new Error('branch1 UNION ALL');
      if (q.unionBranches[2]?.operator !== 'UNION') throw new Error('branch2 UNION');
      const tables = q.unionBranches.map((b) => b.query.tables[0]?.table);
      if (tables.join(',') !== 'a,b,c') throw new Error(`tables ${tables.join(',')}`);
    },
  },
  {
    name: 'UNION: 片方にJOINあり',
    category: 'union',
    sql: `SELECT u.id FROM users u
UNION ALL
SELECT o.id FROM orders o INNER JOIN users u2 ON u2.id = o.user_id`,
    expectSuccess: true,
    assert: (q) => {
      if (q.unionBranches?.length !== 2) throw new Error('2 branches');
      if (q.unionBranches[1]?.query.joins.length !== 1) throw new Error('branch1 join');
      if (q.unionBranches[1]?.query.tables.length !== 2) throw new Error('branch1 2 tables');
    },
  },
  {
    name: 'UNION: 各ブランチに異なるWHERE',
    category: 'union',
    sql: `SELECT id FROM t WHERE a = 1 AND b = 2
UNION ALL
SELECT id FROM t WHERE c = 3 OR d = 4`,
    expectSuccess: true,
    assert: (q) => {
      const w0 = q.unionBranches?.[0]?.query.where;
      const w1 = q.unionBranches?.[1]?.query.where;
      if (w0?.type !== 'and') throw new Error('branch0 and');
      if (!hasOrNode(w1)) throw new Error('branch1 or');
    },
  },

  // --- subquery ---
  {
    name: 'サブクエリ: IN (SELECT ...)',
    category: 'subquery',
    sql: 'SELECT id FROM users u WHERE u.id IN (SELECT user_id FROM orders WHERE total > 100)',
    expectSuccess: true,
    assert: (q) => {
      const inNode = findCondition(q.where, (n) => n.type === 'in' && Boolean(n.nestedQuery));
      if (!inNode?.nestedQuery) throw new Error('IN nestedQuery');
      if (inNode.nestedQuery.tables[0]?.table !== 'orders') throw new Error('orders in sub');
      if (inNode.left !== 'u.id') throw new Error(`left ${inNode.left}`);
    },
  },
  {
    name: 'サブクエリ: NOT IN (SELECT ...)',
    category: 'subquery',
    sql: 'SELECT id FROM users WHERE id NOT IN (SELECT user_id FROM banned_users)',
    expectSuccess: true,
    assert: (q) => {
      const inNode = findCondition(q.where, (n) => n.type === 'in' && n.operator === 'NOT IN');
      if (!inNode?.nestedQuery) throw new Error('NOT IN nestedQuery');
      if (inNode.nestedQuery.tables[0]?.table !== 'banned_users') throw new Error('banned_users');
    },
  },
  {
    name: 'サブクエリ: EXISTS',
    category: 'subquery',
    sql: 'SELECT id FROM users u WHERE EXISTS (SELECT 1 FROM orders o WHERE o.user_id = u.id)',
    expectSuccess: true,
    assert: (q) => {
      const ex = findCondition(q.where, (n) => n.type === 'exists');
      if (!ex?.nestedQuery) throw new Error('EXISTS nestedQuery');
      if (ex.label.includes('NOT')) throw new Error('should not be NOT EXISTS');
      if (ex.nestedQuery.tables[0]?.table !== 'orders') throw new Error('orders');
    },
  },
  {
    name: 'サブクエリ: NOT EXISTS',
    category: 'subquery',
    sql: 'SELECT id FROM users u WHERE NOT EXISTS (SELECT 1 FROM orders o WHERE o.user_id = u.id)',
    expectSuccess: true,
    assert: (q) => {
      const ex = findCondition(q.where, (n) => n.type === 'exists' && exLabelIncludesNot(n));
      if (!ex?.nestedQuery) throw new Error('NOT EXISTS nestedQuery');
      if (ex.nestedQuery.tables[0]?.table !== 'orders') throw new Error('orders');
    },
  },
  {
    name: 'サブクエリ: スカラー比較 = (SELECT ...)',
    category: 'subquery',
    sql: 'SELECT id FROM users WHERE score = (SELECT MAX(score) FROM users)',
    expectSuccess: true,
    assert: (q) => {
      const sq = findCondition(q.where, (n) => n.type === 'subquery');
      if (!sq?.nestedQuery) throw new Error('scalar subquery');
      if (sq.operator !== '=') throw new Error('operator =');
      if (sq.left !== 'score') throw new Error(`left ${sq.left}`);
    },
  },
  {
    name: 'サブクエリ: 派生テーブル (SELECT ...) AS t',
    category: 'subquery',
    sql: 'SELECT t.id FROM (SELECT id, name FROM users WHERE status = 1) t',
    expectSuccess: true,
    assert: (q) => {
      const derived = q.tables.find((t) => t.isDerived);
      if (!derived) throw new Error('derived table');
      if (derived.alias !== 't') throw new Error(`alias ${derived.alias}`);
      if (!derived.derivedQuery) throw new Error('derivedQuery');
      if (derived.derivedQuery.tables[0]?.table !== 'users') throw new Error('inner users');
      if (derived.derivedQuery.where?.type === undefined) throw new Error('inner where');
    },
  },
  {
    name: 'サブクエリ: 派生テーブル + JOIN',
    category: 'subquery',
    sql: 'SELECT o.id FROM (SELECT id, uid FROM users) t JOIN orders o ON o.user_id = t.uid',
    expectSuccess: true,
    assert: (q) => {
      const derived = q.tables.find((t) => t.isDerived);
      if (!derived?.derivedQuery) throw new Error('derived');
      if (q.joins.length !== 1) throw new Error('1 join');
      if (q.tables.length !== 2) throw new Error('2 tables');
    },
  },
  {
    name: 'サブクエリ: WHERE内に複数（IN + EXISTS）',
    category: 'subquery',
    sql: `SELECT id FROM users u
WHERE u.id IN (SELECT user_id FROM orders)
  AND EXISTS (SELECT 1 FROM profiles p WHERE p.user_id = u.id)`,
    expectSuccess: true,
    assert: (q) => {
      const inNode = findCondition(q.where, (n) => n.type === 'in' && Boolean(n.nestedQuery));
      const exNode = findCondition(q.where, (n) => n.type === 'exists');
      if (!inNode?.nestedQuery || !exNode?.nestedQuery) throw new Error('both nested');
    },
  },
  {
    name: 'サブクエリ: HAVING 内',
    category: 'subquery',
    sql: 'SELECT dept, COUNT(*) AS cnt FROM employees GROUP BY dept HAVING cnt > (SELECT AVG(cnt) FROM (SELECT COUNT(*) AS cnt FROM employees GROUP BY dept) x)',
    expectSuccess: true,
    assert: (q) => {
      if (!q.having) throw new Error('having');
      const sq = findCondition(q.having, (n) => Boolean(n.nestedQuery));
      if (!sq?.nestedQuery) throw new Error('having subquery');
    },
  },
  {
    name: 'サブクエリ: UPDATE WHERE に IN',
    category: 'subquery',
    sql: "UPDATE users SET status = 'x' WHERE id IN (SELECT user_id FROM orders WHERE total > 0)",
    expectSuccess: true,
    assert: (q) => {
      if (q.statementType !== 'UPDATE') throw new Error('UPDATE');
      const inNode = findCondition(q.where, (n) => n.type === 'in' && Boolean(n.nestedQuery));
      if (!inNode?.nestedQuery) throw new Error('IN subquery in UPDATE');
    },
  },
  {
    name: 'サブクエリ: DELETE WHERE に EXISTS',
    category: 'subquery',
    sql: 'DELETE FROM users WHERE EXISTS (SELECT 1 FROM orders o WHERE o.user_id = users.id AND o.total = 0)',
    expectSuccess: true,
    assert: (q) => {
      if (q.statementType !== 'DELETE') throw new Error('DELETE');
      const ex = findCondition(q.where, (n) => n.type === 'exists');
      if (!ex?.nestedQuery) throw new Error('EXISTS in DELETE');
    },
  },
  {
    name: 'サブクエリ: 派生テーブル内に WHERE + JOIN',
    category: 'subquery',
    sql: `SELECT x.id FROM (
  SELECT u.id FROM users u INNER JOIN orders o ON o.user_id = u.id WHERE o.total > 100
) x`,
    expectSuccess: true,
    assert: (q) => {
      const inner = q.tables.find((t) => t.isDerived)?.derivedQuery;
      if (!inner) throw new Error('inner query');
      if (inner.joins.length !== 1) throw new Error('inner join');
      if (inner.tables.length !== 2) throw new Error('inner 2 tables');
      if (!inner.where) throw new Error('inner where');
    },
  },

  // --- regression（既知バグの再発防止） ---
  {
    name: '回帰: HAVING SUM(単一引数) — map エラー防止',
    category: 'regression',
    sql: 'SELECT dept FROM sales GROUP BY dept HAVING SUM(amount) > 1000',
    expectSuccess: true,
    assert: (q) => {
      if (!q.having?.label.includes('SUM(amount)')) throw new Error(`having label: ${q.having?.label}`);
    },
  },
  {
    name: '回帰: SELECT COUNT(*), AVG(price)',
    category: 'regression',
    sql: 'SELECT COUNT(*), AVG(price) FROM products GROUP BY category_id',
    expectSuccess: true,
    assert: (q) => {
      if (!q.columns.some((c) => c.expression.includes('COUNT'))) throw new Error('COUNT');
      if (!q.columns.some((c) => c.expression.includes('AVG'))) throw new Error('AVG');
    },
  },
  {
    name: '回帰: NOT ( ... ) 関数形式',
    category: 'regression',
    sql: 'SELECT id FROM t WHERE NOT (status = 0 OR type = 9)',
    expectSuccess: true,
    assert: (q) => {
      const notNode = findCondition(q.where, (n) => n.type === 'not');
      if (!notNode) throw new Error('not node');
      if (!notNode.children?.some((c) => c.type === 'or')) throw new Error('NOT wraps OR');
    },
  },
  {
    name: '回帰: NOT EXISTS（unary_expr 形式）',
    category: 'regression',
    sql: 'SELECT id FROM guest_users g WHERE NOT EXISTS (SELECT 1 FROM orders o WHERE o.user_id = g.id)',
    expectSuccess: true,
    assert: (q) => {
      const ex = findCondition(q.where, (n) => n.type === 'exists' && exLabelIncludesNot(n));
      if (!ex?.nestedQuery) throw new Error('NOT EXISTS');
    },
  },
  {
    name: '回帰: HAVING COUNT(*) >= N',
    category: 'regression',
    sql: 'SELECT dept FROM emp GROUP BY dept HAVING COUNT(*) >= 10',
    expectSuccess: true,
    assert: (q) => {
      if (!q.having?.label.includes('COUNT(*)')) throw new Error('COUNT in having');
    },
  },
  {
    name: '回帰: 複合 WHERE + SUM HAVING（サンプル相当）',
    category: 'regression',
    sql: `SELECT u.id FROM users u
LEFT JOIN order_items oi ON oi.user_id = u.id
WHERE u.status = 'active'
GROUP BY u.id
HAVING SUM(oi.qty) > 5`,
    expectSuccess: true,
    assert: (q) => {
      if (q.joins.length !== 1) throw new Error('1 join');
      if (!q.having?.label.includes('SUM')) throw new Error('SUM having');
    },
  },
  {
    name: '回帰: 式の括弧を落とさない（表示の意味が変わる）',
    category: 'regression',
    sql: 'SELECT (a + b) * 2 AS c FROM t WHERE (x = 1 OR y = 2) AND z = 3',
    expectSuccess: true,
    assert: (q) => {
      const expr = q.columns[0]?.expression ?? '';
      if (expr !== '(a + b) * 2') throw new Error(`parentheses lost: ${expr}`);
    },
  },
  {
    name: '回帰: CAST の変換先データ型を落とさない',
    category: 'regression',
    sql: 'SELECT CAST(a AS NUMBER(10,2)) AS c FROM t',
    expectSuccess: true,
    assert: (q) => {
      const expr = q.columns[0]?.expression ?? '';
      if (!/CAST\(a AS \w+\(10,2\)\)/.test(expr)) throw new Error(`cast target lost: ${expr}`);
    },
  },
  {
    name: '回帰: INTERVAL を AST ダンプで表示しない',
    category: 'regression',
    sql: "SELECT SYSDATE - INTERVAL '1' DAY AS d FROM dual",
    expectSuccess: true,
    assert: (q) => {
      const expr = q.columns[0]?.expression ?? '';
      if (expr.includes('"type"')) throw new Error(`AST dump leaked: ${expr.slice(0, 60)}`);
      if (!expr.includes("INTERVAL '1' DAY")) throw new Error(`interval lost: ${expr}`);
    },
  },
  {
    name: '回帰: 分析関数の OVER 句を落とさない',
    category: 'regression',
    sql: 'SELECT ROW_NUMBER() OVER (PARTITION BY a ORDER BY b DESC) AS rn FROM t',
    expectSuccess: true,
    assert: (q) => {
      const expr = q.columns[0]?.expression ?? '';
      if (expr !== 'ROW_NUMBER() OVER (PARTITION BY a ORDER BY b DESC)') {
        throw new Error(`over clause lost: ${expr}`);
      }
    },
  },
  {
    name: '回帰: LIKE の ESCAPE 句を落とさない',
    category: 'regression',
    sql: "SELECT id FROM t WHERE a LIKE 'x%' ESCAPE '!'",
    expectSuccess: true,
    assert: (q) => {
      const label = q.where?.label ?? '';
      if (!label.includes("ESCAPE '!'")) throw new Error(`escape lost: ${label}`);
    },
  },
  {
    name: '回帰: CASE の条件・ELSE を落とさずに表示する',
    category: 'regression',
    sql: "SELECT CASE WHEN a > 1 THEN 'x' WHEN a = 0 THEN 'y' ELSE 'z' END AS f FROM t",
    expectSuccess: true,
    assert: (q) => {
      const expr = q.columns[0]?.expression ?? '';
      const expected = "CASE WHEN a > 1 THEN 'x' WHEN a = 0 THEN 'y' ELSE 'z' END";
      if (expr !== expected) throw new Error(`CASE expression: ${expr}`);
    },
  },
  {
    name: '回帰: 単純 CASE（CASE 式 WHEN 値）の対象式を落とさない',
    category: 'regression',
    sql: "SELECT CASE a WHEN 1 THEN 'x' ELSE 'y' END AS f FROM t",
    expectSuccess: true,
    assert: (q) => {
      const expr = q.columns[0]?.expression ?? '';
      if (expr !== "CASE a WHEN 1 THEN 'x' ELSE 'y' END") {
        throw new Error(`simple CASE expression: ${expr}`);
      }
    },
  },
  {
    name: '回帰: NOT IN リテラル（サブクエリではない）',
    category: 'regression',
    sql: 'SELECT id FROM t WHERE status NOT IN (1, 2, 3)',
    expectSuccess: true,
    assert: (q) => {
      const inNode = q.where?.type === 'in' ? q.where : findCondition(q.where, (n) => n.type === 'in');
      if (!inNode) throw new Error('in');
      if (inNode.nestedQuery) throw new Error('should not be subquery');
      if (inNode.operator !== 'NOT IN') throw new Error('NOT IN');
    },
  },
  {
    name: '回帰: IS NOT NULL',
    category: 'regression',
    sql: 'SELECT id FROM t WHERE email IS NOT NULL',
    expectSuccess: true,
    assert: (q) => {
      const notNullNode = findCondition(q.where, (n) =>
        n.label.toUpperCase().includes('NOT NULL'),
      );
      if (!notNullNode) throw new Error('NOT NULL condition');
      if (notNullNode.left !== 'email' && !notNullNode.label.includes('email')) {
        throw new Error(`email column expected in ${notNullNode.label}`);
      }
    },
  },

  // --- error ---
  {
    name: '空文字',
    category: 'error',
    sql: '',
    expectSuccess: false,
    errorContains: 'SQLを入力してください',
  },
  {
    name: '空白のみ',
    category: 'error',
    sql: '   \n\t  ',
    expectSuccess: false,
    errorContains: 'SQLを入力してください',
  },
  {
    name: 'INSERT文',
    category: 'error',
    sql: "INSERT INTO users (name) VALUES ('test')",
    expectSuccess: false,
    errorContains: '対応',
  },
  {
    name: '構文エラー: SELECT FROM',
    category: 'error',
    sql: 'SELECT FROM WHERE',
    expectSuccess: false,
  },
  {
    name: '構文エラー: 括弧未閉じ',
    category: 'error',
    sql: 'SELECT id FROM t WHERE (a = 1',
    expectSuccess: false,
  },
  {
    name: 'ゴミ文字列',
    category: 'error',
    sql: 'これはSQLではない',
    expectSuccess: false,
  },
  ...ORACLE_SQL_TEST_CASES,
];
