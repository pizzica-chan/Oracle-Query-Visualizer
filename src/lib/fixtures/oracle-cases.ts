import { findCondition, tableNames, type SqlTestCase } from './sql-cases';

/**
 * Oracle 固有構文のテストケース。
 * 解析の不変条件・オフライン監査など複数のテストがこの一覧を横断して回すので、
 * 新しい Oracle 構文へ対応したらここにケースを足す
 */
export const ORACLE_SQL_TEST_CASES: SqlTestCase[] = [
  {
    name: 'Oracle: 旧式外部結合演算子 (+) — 右側に付くと LEFT JOIN',
    category: 'oracle',
    sql: 'SELECT e.emp_no, d.dept_name FROM employees e, departments d WHERE e.dept_no = d.dept_no(+)',
    expectSuccess: true,
    assert: (q) => {
      if (q.tables.length !== 2) throw new Error('2 tables');
      if (q.joins.length !== 1) throw new Error(`1 join, got ${q.joins.length}`);
      const join = q.joins[0]!;
      if (join.type !== 'LEFT JOIN') throw new Error(`expected LEFT JOIN, got ${join.type}`);
      if (!join.fromWhereClause) throw new Error('fromWhereClause');
      if (!join.isOuterJoinOperator) throw new Error('isOuterJoinOperator');
    },
  },
  {
    name: 'Oracle: 旧式外部結合演算子 (+) — 左側に付くと RIGHT JOIN',
    category: 'oracle',
    sql: 'SELECT e.emp_no, d.dept_name FROM employees e, departments d WHERE e.dept_no(+) = d.dept_no',
    expectSuccess: true,
    assert: (q) => {
      if (q.joins[0]?.type !== 'RIGHT JOIN') throw new Error(`got ${q.joins[0]?.type}`);
    },
  },
  {
    name: 'Oracle: (+) の外部結合と内部結合の混在',
    category: 'oracle',
    sql: `SELECT e.emp_no, d.dept_name, b.bonus
FROM employees e, departments d, bonuses b
WHERE e.dept_no = d.dept_no
  AND e.emp_no = b.emp_no(+)
  AND d.location = 'TOKYO'`,
    expectSuccess: true,
    assert: (q) => {
      if (q.joins.length !== 2) throw new Error(`2 joins, got ${q.joins.length}`);
      const types = q.joins.map((j) => j.type).sort();
      if (types.join(',') !== 'INNER JOIN,LEFT JOIN') throw new Error(`types ${types.join(',')}`);
    },
  },
  {
    name: 'Oracle: カンマ結合の結合条件を JOIN として読む',
    category: 'oracle',
    sql: "SELECT a.id FROM t_a a, t_b b, t_c c WHERE a.id = b.a_id AND b.id = c.b_id AND c.flag = 'Y'",
    expectSuccess: true,
    assert: (q) => {
      if (q.tables.length !== 3) throw new Error('3 tables');
      if (q.joins.length !== 2) throw new Error(`2 joins, got ${q.joins.length}`);
      if (!q.joins.every((j) => j.type === 'INNER JOIN' && j.fromWhereClause)) {
        throw new Error('inner joins from where');
      }
    },
  },
  {
    name: 'Oracle: 結合条件のないカンマ結合は直積（CROSS JOIN）',
    category: 'oracle',
    sql: 'SELECT a.id, b.id FROM t_a a, t_b b WHERE a.flag = 1',
    expectSuccess: true,
    assert: (q) => {
      if (q.joins.length !== 1) throw new Error('1 join');
      if (q.joins[0]?.type !== 'CROSS JOIN') throw new Error(`got ${q.joins[0]?.type}`);
    },
  },
  {
    name: 'Oracle: 階層問い合わせ CONNECT BY / START WITH',
    category: 'oracle',
    sql: `SELECT LEVEL, e.emp_no, e.emp_name
FROM employees e
WHERE e.retired_flg = 0
START WITH e.manager_no IS NULL
CONNECT BY PRIOR e.emp_no = e.manager_no`,
    expectSuccess: true,
    assert: (q) => {
      if (!q.hierarchical) throw new Error('hierarchical');
      if (q.hierarchical.startWith !== 'e.manager_no IS NULL') {
        throw new Error(`startWith: ${q.hierarchical.startWith}`);
      }
      if (q.hierarchical.connectBy !== 'PRIOR e.emp_no = e.manager_no') {
        throw new Error(`connectBy: ${q.hierarchical.connectBy}`);
      }
      if (!q.where) throw new Error('WHERE は階層句と別に残る');
    },
  },
  {
    name: 'Oracle: CONNECT BY が先・START WITH が後',
    category: 'oracle',
    sql: 'SELECT emp_no FROM employees CONNECT BY PRIOR emp_no = manager_no START WITH manager_no IS NULL',
    expectSuccess: true,
    assert: (q) => {
      if (q.hierarchical?.connectBy !== 'PRIOR emp_no = manager_no') {
        throw new Error(`connectBy: ${q.hierarchical?.connectBy}`);
      }
      if (q.hierarchical?.startWith !== 'manager_no IS NULL') {
        throw new Error(`startWith: ${q.hierarchical?.startWith}`);
      }
    },
  },
  {
    name: 'Oracle: CONNECT BY NOCYCLE',
    category: 'oracle',
    sql: 'SELECT emp_no FROM employees CONNECT BY NOCYCLE PRIOR emp_no = manager_no',
    expectSuccess: true,
    assert: (q) => {
      if (!q.hierarchical?.noCycle) throw new Error('noCycle');
    },
  },
  {
    name: 'Oracle: オプティマイザヒント',
    category: 'oracle',
    sql: 'SELECT /*+ ORDERED USE_NL(o) */ u.id FROM users u INNER JOIN orders o ON o.user_id = u.id',
    expectSuccess: true,
    assert: (q) => {
      if (q.hints?.length !== 1) throw new Error(`hints ${q.hints?.length}`);
      if (q.hints[0]?.text !== 'ORDERED USE_NL(o)') throw new Error(`hint text ${q.hints[0]?.text}`);
      if (q.joins.length !== 1) throw new Error('1 join');
    },
  },
  {
    name: 'Oracle: MINUS',
    category: 'oracle',
    sql: `SELECT id FROM a
MINUS
SELECT id FROM b`,
    expectSuccess: true,
    assert: (q) => {
      if (q.unionBranches?.length !== 2) throw new Error('2 branches');
      if (q.unionBranches[1]?.operator !== 'MINUS') {
        throw new Error(`op ${q.unionBranches[1]?.operator}`);
      }
    },
  },
  {
    name: 'Oracle: INTERSECT',
    category: 'oracle',
    sql: 'SELECT id FROM a INTERSECT SELECT id FROM b',
    expectSuccess: true,
    assert: (q) => {
      if (q.unionBranches?.[1]?.operator !== 'INTERSECT') {
        throw new Error(`op ${q.unionBranches?.[1]?.operator}`);
      }
    },
  },
  {
    name: 'Oracle: DUAL と SYSDATE',
    category: 'oracle',
    sql: 'SELECT SYSDATE, USER FROM dual',
    expectSuccess: true,
    assert: (q) => {
      if (tableNames(q)[0] !== 'dual') throw new Error('dual');
    },
  },
  {
    name: 'Oracle: ROWNUM による件数制限',
    category: 'oracle',
    sql: 'SELECT * FROM (SELECT id FROM t ORDER BY id) WHERE ROWNUM <= 10',
    expectSuccess: true,
    assert: (q) => {
      const rownum = findCondition(q.where, (n) => Boolean(n.isRownum));
      if (!rownum) throw new Error('ROWNUM condition');
    },
  },
  {
    name: 'Oracle: 行制限句 OFFSET … ROWS FETCH NEXT … ROWS ONLY',
    category: 'oracle',
    sql: 'SELECT id FROM t ORDER BY id OFFSET 20 ROWS FETCH NEXT 10 ROWS ONLY',
    expectSuccess: true,
    assert: (q) => {
      if (q.offset !== '20') throw new Error(`offset ${q.offset}`);
      if (q.limit !== '10') throw new Error(`limit ${q.limit}`);
      if (q.rowLimitWithTies) throw new Error('not with ties');
    },
  },
  {
    name: 'Oracle: FETCH FIRST … PERCENT ROWS WITH TIES',
    category: 'oracle',
    sql: 'SELECT id FROM t ORDER BY score DESC FETCH FIRST 5 PERCENT ROWS WITH TIES',
    expectSuccess: true,
    assert: (q) => {
      if (q.limit !== '5') throw new Error(`limit ${q.limit}`);
      if (!q.rowLimitPercent) throw new Error('percent');
      if (!q.rowLimitWithTies) throw new Error('with ties');
    },
  },
  {
    name: 'Oracle: ORDER BY … NULLS LAST',
    category: 'oracle',
    sql: 'SELECT id FROM t ORDER BY comm DESC NULLS LAST, id ASC',
    expectSuccess: true,
    assert: (q) => {
      if (q.orderBy.length !== 2) throw new Error('2 order by');
      if (!q.orderBy[0]?.text.includes('NULLS LAST')) throw new Error(`text ${q.orderBy[0]?.text}`);
    },
  },
  {
    name: 'Oracle: NVL / DECODE / TO_DATE',
    category: 'oracle',
    sql:
      "SELECT NVL(comm, 0) AS comm, DECODE(job, 'CLERK', 1, 0) AS is_clerk " +
      "FROM emp WHERE hired_at > TO_DATE('2020-01-01', 'YYYY-MM-DD')",
    expectSuccess: true,
    assert: (q) => {
      if (!q.columns.some((c) => c.expression.includes('NVL'))) throw new Error('NVL');
      if (!q.columns.some((c) => c.expression.includes('DECODE'))) throw new Error('DECODE');
    },
  },
  {
    name: 'Oracle: 文字列連結 ||',
    category: 'oracle',
    sql: "SELECT last_name || ' ' || first_name AS full_name FROM emp",
    expectSuccess: true,
    assert: (q) => {
      if (q.columns[0]?.alias !== 'full_name') throw new Error('alias');
    },
  },
  {
    name: 'Oracle: 代替引用符 q\'[...]\'',
    category: 'oracle',
    sql: "SELECT id FROM t WHERE note = q'[it's here]'",
    expectSuccess: true,
    assert: (q) => {
      if (!q.where) throw new Error('where');
    },
  },
  {
    name: 'Oracle: WITH 句（副問合せファクタリング）',
    category: 'oracle',
    sql: `WITH dept_total AS (
  SELECT dept_no, SUM(sal) AS total FROM emp GROUP BY dept_no
)
SELECT d.dept_name, t.total
FROM dept_total t
INNER JOIN departments d ON d.dept_no = t.dept_no
WHERE t.total > 1000`,
    expectSuccess: true,
    assert: (q) => {
      if (q.ctes?.length !== 1) throw new Error('1 cte');
      if (q.ctes[0]?.name !== 'dept_total') throw new Error('cte name');
    },
  },
  {
    name: 'Oracle: CAST に Oracle 型（NUMBER / VARCHAR2）',
    category: 'oracle',
    sql: 'SELECT CAST(sal AS NUMBER(10,2)) AS sal2, CAST(name AS VARCHAR2(20)) AS name2 FROM emp',
    expectSuccess: true,
    assert: (q) => {
      if (q.columns.length !== 2) throw new Error('2 columns');
    },
  },
  {
    name: 'Oracle: LISTAGG … WITHIN GROUP',
    category: 'oracle',
    sql:
      "SELECT dept_no, LISTAGG(emp_name, ',') WITHIN GROUP (ORDER BY emp_name) AS names " +
      'FROM emp GROUP BY dept_no',
    expectSuccess: true,
    assert: (q) => {
      if (!q.columns.some((c) => c.expression.includes('LISTAGG'))) throw new Error('LISTAGG');
      if (q.groupBy.length !== 1) throw new Error('group by');
    },
  },
  {
    name: 'Oracle: 分析関数 OVER (PARTITION BY …)',
    category: 'oracle',
    sql: 'SELECT emp_no, ROW_NUMBER() OVER (PARTITION BY dept_no ORDER BY sal DESC) AS rn FROM emp',
    expectSuccess: true,
    assert: (q) => {
      if (q.columns.length !== 2) throw new Error('2 columns');
    },
  },
  {
    name: 'Oracle: SELECT UNIQUE（DISTINCT の別名）',
    category: 'oracle',
    sql: 'SELECT UNIQUE dept_no FROM emp',
    expectSuccess: true,
    assert: (q) => {
      if (!q.distinct) throw new Error('distinct');
    },
  },
  {
    name: 'Oracle: DELETE の FROM 省略形',
    category: 'oracle',
    sql: "DELETE users WHERE status = 'DELETED'",
    expectSuccess: true,
    assert: (q) => {
      if (q.statementType !== 'DELETE') throw new Error('DELETE');
      if (tableNames(q)[0] !== 'users') throw new Error('users');
    },
  },
  {
    name: 'Oracle: MERGE 文は未対応',
    category: 'error',
    sql: 'MERGE INTO t1 USING t2 ON (t1.id = t2.id) WHEN MATCHED THEN UPDATE SET t1.v = t2.v',
    expectSuccess: false,
  },
  {
    name: 'Oracle: AND は OR より先に結び付く',
    category: 'regression',
    sql: 'SELECT t.a FROM t WHERE t.a = 1 OR t.b = 2 AND t.c = 3',
    expectSuccess: true,
    assert: (q) => {
      if (q.where?.type !== 'or') throw new Error(`root should be OR, got ${q.where?.type}`);
      if (q.where.children?.[1]?.type !== 'and') throw new Error('right side should be AND');
    },
  },
  {
    name: 'Oracle: 日本語の引用符なしのテーブル名・列名',
    category: 'oracle',
    sql: 'SELECT u.名前, o.金額 FROM ユーザー u LEFT JOIN 受注2 o ON o.ユーザーID = u.ID',
    expectSuccess: true,
    assert: (q) => {
      if (tableNames(q).join(',') !== 'ユーザー,受注2') throw new Error(tableNames(q).join(','));
    },
  },
  {
    name: 'Oracle: 集約関数の DISTINCT と VARIANCE',
    category: 'oracle',
    sql: 'SELECT d.id, SUM(DISTINCT e.sal) AS s, VARIANCE(e.sal) AS v, AVG(DISTINCT e.bonus) AS b FROM dept d JOIN emp e ON e.dept_id = d.id GROUP BY d.id',
    expectSuccess: true,
    assert: (q) => {
      const exprs = q.columns.map((c) => c.expression).join(' | ');
      if (exprs !== 'd.id | SUM(DISTINCT e.sal) | VARIANCE(e.sal) | AVG(DISTINCT e.bonus)') throw new Error(exprs);
    },
  },
  {
    name: 'Oracle: UPDATE の SET 列 = DEFAULT',
    category: 'update',
    sql: 'UPDATE emp e SET e.bonus = DEFAULT, e.updated_at = SYSDATE WHERE e.id = :id',
    expectSuccess: true,
    assert: (q) => {
      const labels = q.setClauses?.map((s) => s.label).join(' | ');
      if (labels !== 'e.bonus = DEFAULT | e.updated_at = SYSDATE') throw new Error(labels);
    },
  },
  {
    name: 'Oracle: 日付・各国語のリテラルとバインド変数',
    category: 'oracle',
    sql: "SELECT e.id FROM emp e WHERE e.hired >= DATE '2024-04-01' AND e.kana = N'ア' AND e.dept_id = :dept",
    expectSuccess: true,
    assert: (q) => {
      const labels = q.where?.children?.map((c) => c.label).join(' | ');
      if (labels !== "e.hired >= DATE '2024-04-01' | e.kana = N'ア' | e.dept_id = :dept") throw new Error(labels);
    },
  },
  {
    name: '括弧でまとめた JOIN は未対応と伝える（table_1 という架空のテーブルにしない）',
    category: 'error',
    sql: 'SELECT a.x FROM a LEFT JOIN (b JOIN c ON c.id = b.cid) ON b.aid = a.id',
    expectSuccess: false,
    errorContains: '括弧でまとめた JOIN',
  },
  {
    name: '集合演算の右側だけを括弧で囲むとブランチが消えるので、未対応と伝える',
    category: 'error',
    sql: 'SELECT a.x FROM a MINUS (SELECT b.x FROM b)',
    expectSuccess: false,
    errorContains: '右側だけを括弧で囲む',
  },
  {
    name: '派生テーブル・IN サブクエリ・WITH の中の集合演算も、全ブランチを持つ',
    category: 'union',
    sql: `WITH c AS (SELECT a.x FROM a UNION ALL SELECT b.x FROM b)
SELECT d.x FROM (SELECT p.x FROM p MINUS SELECT q.x FROM q) d
WHERE d.x IN (SELECT c.x FROM c INTERSECT SELECT r.x FROM r)`,
    expectSuccess: true,
    assert: (q) => {
      if (q.ctes?.[0]?.query.unionBranches?.length !== 2) throw new Error('CTE branches');
      if (q.tables.find((t) => t.isDerived && t.alias === 'd')?.derivedQuery?.unionBranches?.length !== 2) {
        throw new Error('derived branches');
      }
      if (q.where?.nestedQuery?.unionBranches?.length !== 2) throw new Error('IN subquery branches');
    },
  },
  {
    name: '括弧の無い最後のブランチの後ろの ORDER BY / 行制限句は、集合演算の全体に掛かる',
    category: 'union',
    sql: 'SELECT a.x FROM a UNION ALL SELECT b.x FROM b ORDER BY 1 FETCH FIRST 3 ROWS ONLY',
    expectSuccess: true,
    assert: (q) => {
      if (q.limit !== '3' || q.orderBy.map((o) => o.text).join() !== '1') throw new Error(`tail: ${q.limit}`);
      const last = q.unionBranches?.[1]?.query;
      if (!last || last.limit !== undefined || last.orderBy.length > 0) throw new Error('last branch keeps tail');
    },
  },
  {
    name: '括弧で囲んだブランチの後ろの ORDER BY / 行制限句も全体に掛かり、派生テーブルの外へは出ない',
    category: 'union',
    sql: `SELECT d.x FROM ((SELECT a.x FROM a) UNION ALL (SELECT b.x FROM b) ORDER BY 1 FETCH FIRST 5 ROWS ONLY) d
FETCH FIRST 2 ROWS ONLY`,
    expectSuccess: true,
    assert: (q) => {
      if (q.limit !== '2') throw new Error(`outer limit: ${q.limit}`);
      const inner = q.tables[0]?.derivedQuery;
      if (inner?.limit !== '5' || inner.orderBy.map((o) => o.text).join() !== '1') {
        throw new Error(`inner tail: ${inner?.limit}`);
      }
    },
  },
  {
    name: 'COLLATE・ウィンドウ枠・式の中の BETWEEN を表示に残す',
    category: 'regression',
    sql: `SELECT SUM(t.a) OVER (PARTITION BY t.k ORDER BY t.d ROWS BETWEEN 1 PRECEDING AND CURRENT ROW) AS s,
  CASE WHEN t.b BETWEEN 1 AND 5 THEN 1 END AS c
FROM t WHERE t.name COLLATE BINARY_CI = 'abc'`,
    expectSuccess: true,
    assert: (q) => {
      const cols = q.columns.map((c) => c.expression).join(' | ');
      if (cols !== 'SUM(t.a) OVER (PARTITION BY t.k ORDER BY t.d ROWS BETWEEN 1 PRECEDING AND CURRENT ROW) | CASE WHEN t.b BETWEEN 1 AND 5 THEN 1 END') {
        throw new Error(cols);
      }
      if (q.where?.label !== "t.name COLLATE BINARY_CI = 'abc'") throw new Error(q.where?.label);
    },
  },
  {
    name: '式の中のサブクエリを embeddedSubqueries に持つ（表示は要約のまま）',
    category: 'subquery',
    sql: 'SELECT u.id, (SELECT MAX(o.amt) FROM orders o WHERE o.uid = u.id) AS m FROM users u',
    expectSuccess: true,
    assert: (q) => {
      if (q.columns[1]?.expression !== '(SELECT 1列 FROM orders)') throw new Error(q.columns[1]?.expression);
      if (q.embeddedSubqueries?.[0]?.tables[0]?.table !== 'orders') throw new Error('embedded');
    },
  },
  {
    name: 'ORDER BY の範囲は式と DESC の間の空白の数によらない',
    category: 'regression',
    sql: 'SELECT t.a FROM t ORDER BY t.a   DESC, t.b\n  ASC NULLS LAST',
    expectSuccess: true,
    assert: (q) => {
      const sql = 'SELECT t.a FROM t ORDER BY t.a   DESC, t.b\n  ASC NULLS LAST';
      const texts = q.orderBy.map((o) => sql.slice(o.sourceSpan!.start, o.sourceSpan!.end));
      if (texts.join('|') !== 't.a   DESC|t.b\n  ASC') throw new Error(JSON.stringify(texts));
    },
  },
  {
    name: '複数列の同時更新で複製した副問合せの範囲も、元の副問合せを指す',
    category: 'update',
    sql: `UPDATE employees e
SET (e.dept_no, e.grade_cd) = (
      SELECT d.dept_no, d.default_grade FROM departments d WHERE d.code = e.dept_code
    )
WHERE e.active = 1`,
    expectSuccess: true,
    assert: (q) => {
      const sql = `UPDATE employees e
SET (e.dept_no, e.grade_cd) = (
      SELECT d.dept_no, d.default_grade FROM departments d WHERE d.code = e.dept_code
    )
WHERE e.active = 1`;
      if (q.setClauses?.length !== 2) throw new Error(`set: ${q.setClauses?.length}`);
      for (const sub of q.embeddedSubqueries ?? []) {
        const span = sub.columns[0]?.sourceSpan;
        if (span && sql.slice(span.start, span.end) !== 'd.dept_no') throw new Error(sql.slice(span.start, span.end));
      }
    },
  },
  {
    name: 'Oracle: 別名の無いインラインビューに、内部の仮の名前や SQL に無い別名を出さない',
    category: 'oracle',
    sql: 'SELECT * FROM (SELECT a.*, ROWNUM rnum FROM (SELECT emp_no FROM employees ORDER BY emp_no) a WHERE ROWNUM <= 20) WHERE rnum > 10',
    expectSuccess: true,
    assert: (q) => {
      const outer = q.tables[0];
      if (outer?.table !== '派生テーブル1' || outer.alias !== undefined) throw new Error(JSON.stringify(outer?.table));
      if (outer.displayName !== '派生テーブル1（別名なし）') throw new Error(outer.displayName);
      if (outer.derivedQuery?.tables[0]?.alias !== 'a') throw new Error('inner alias');
    },
  },
  {
    name: 'Oracle: 閉じていない代替引用符はエラーにする',
    category: 'error',
    sql: "SELECT e.id FROM emp e WHERE e.note = q'[abc",
    expectSuccess: false,
    errorContains: '閉じていません',
  },
  {
    name: 'Oracle: 閉じていない引用識別子はエラーにする',
    category: 'error',
    sql: 'SELECT e."Name FROM emp e',
    expectSuccess: false,
    errorContains: '閉じていません',
  },
];
