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
];
