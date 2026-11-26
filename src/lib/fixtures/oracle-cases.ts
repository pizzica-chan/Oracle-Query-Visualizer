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
    name: 'FROM がサブクエリのサブクエリを、内部の仮の名前（derived）を出さずに要約する',
    category: 'subquery',
    sql: 'DELETE FROM emp WHERE ROWID IN (SELECT rid FROM (SELECT ROWID rid, ROW_NUMBER() OVER (PARTITION BY code ORDER BY id) rn FROM emp) WHERE rn > 1)',
    expectSuccess: true,
    assert: (q) => {
      if (q.where?.label !== 'ROWID IN (SELECT 1列 FROM 派生テーブル)') throw new Error(q.where?.label);
    },
  },
  {
    name: 'schema を付けた列と、引用符の要る別名でも、カンマ結合の (+) を外部結合として読む',
    category: 'oracle',
    sql: 'SELECT * FROM sch.a, sch.b, emp "E E" WHERE sch.a.id = sch.b.a_id(+) AND "E E".a_id = sch.a.id',
    expectSuccess: true,
    assert: (q) => {
      const joins = q.joins.map((j) => [j.type, j.condition]);
      const expected = [
        ['LEFT JOIN', 'sch.a.id = sch.b.a_id(+)'],
        ['INNER JOIN', '"E E".a_id = sch.a.id'],
      ];
      if (JSON.stringify(joins) !== JSON.stringify(expected)) throw new Error(JSON.stringify(joins));
    },
  },
  {
    name: '括弧が重なるインラインビューも、いちばん外の括弧から別名までを範囲にする',
    category: 'subquery',
    sql: 'SELECT d.x FROM ((SELECT a.x FROM a) UNION ALL (SELECT b.x FROM b)) d, ((SELECT c.y FROM c)) v',
    expectSuccess: true,
    assert: (q) => {
      const sql = 'SELECT d.x FROM ((SELECT a.x FROM a) UNION ALL (SELECT b.x FROM b)) d, ((SELECT c.y FROM c)) v';
      const texts = q.tables.map((t) => (t.sourceSpan ? sql.slice(t.sourceSpan.start, t.sourceSpan.end) : null));
      const expected = ['((SELECT a.x FROM a) UNION ALL (SELECT b.x FROM b)) d', '((SELECT c.y FROM c)) v'];
      if (JSON.stringify(texts) !== JSON.stringify(expected)) throw new Error(JSON.stringify(texts));
    },
  },
  {
    name: '文字列・NULL・CASE 式・CAST を CAST するときも、元の型名で表示する',
    category: 'oracle',
    sql: "SELECT CAST('2024' AS NUMBER) a, CAST(NULL AS VARCHAR2(10)) b, CAST(CASE WHEN t.x = 1 THEN 1 END AS NUMBER(5)) c, CAST(CAST(t.v AS NUMBER) AS VARCHAR2(10)) d FROM t",
    expectSuccess: true,
    assert: (q) => {
      const texts = q.columns.map((c) => c.expression);
      const expected = [
        "CAST('2024' AS NUMBER)",
        'CAST(NULL AS VARCHAR2(10))',
        'CAST(CASE WHEN t.x = 1 THEN 1 END AS NUMBER(5))',
        'CAST(CAST(t.v AS NUMBER) AS VARCHAR2(10))',
      ];
      if (JSON.stringify(texts) !== JSON.stringify(expected)) throw new Error(JSON.stringify(texts));
    },
  },
  {
    name: '英字以外で始まる名前（"_x"）は、引用符で囲んで表示する',
    category: 'oracle',
    sql: 'SELECT t."_x", t."ok_1" FROM t',
    expectSuccess: true,
    assert: (q) => {
      const texts = q.columns.map((c) => c.expression);
      if (JSON.stringify(texts) !== JSON.stringify(['t."_x"', 't.ok_1'])) throw new Error(JSON.stringify(texts));
    },
  },
  {
    name: '別名に cycle と付けたインラインビューを、CYCLE 句と取り違えない',
    category: 'update',
    sql: 'UPDATE (SELECT e.sal FROM emp e) cycle SET cycle.sal = 1',
    expectSuccess: true,
  },
  {
    name: 'ON の無い JOIN は、Oracle では書けないのでエラーにする（直積として説明しない）',
    category: 'error',
    sql: 'SELECT a.x FROM a JOIN b WHERE a.id = b.id',
    expectSuccess: false,
    errorContains: '「b」との JOIN に ON（結合条件）がありません',
  },
  {
    name: 'ON の無い LEFT JOIN は、Oracle では書けないのでエラーにする',
    category: 'error',
    sql: 'SELECT a.x FROM a LEFT JOIN b',
    expectSuccess: false,
    errorContains: '「b」との LEFT JOIN に ON（結合条件）がありません',
  },
  {
    // パーサーは条件の位置を次の語の手前まで延ばす。取り除いた句の後ろに句が続くと、その句まで条件の範囲に入る
    name: '取り除いた句（CONNECT BY）の前の条件の範囲は、その句まで延ばさない',
    category: 'regression',
    sql: `SELECT e.id, (SELECT d.n FROM dept d WHERE d.id = e.d FETCH FIRST 1 ROWS ONLY) dn
FROM emp e
WHERE e.active = 1
START WITH e.mgr IS NULL
CONNECT BY PRIOR e.id = e.mgr
ORDER SIBLINGS BY e.id`,
    expectSuccess: true,
    assert: (q) => {
      const sql = `SELECT e.id, (SELECT d.n FROM dept d WHERE d.id = e.d FETCH FIRST 1 ROWS ONLY) dn
FROM emp e
WHERE e.active = 1
START WITH e.mgr IS NULL
CONNECT BY PRIOR e.id = e.mgr
ORDER SIBLINGS BY e.id`;
      const text = (span?: { start: number; end: number }) => (span ? sql.slice(span.start, span.end) : null);
      if (text(q.where?.sourceSpan) !== 'e.active = 1') throw new Error(JSON.stringify(text(q.where?.sourceSpan)));
      // スカラーサブクエリの中の FETCH FIRST は、列の範囲に含めたまま
      const column = text(q.columns[1]?.sourceSpan);
      if (column !== '(SELECT d.n FROM dept d WHERE d.id = e.d FETCH FIRST 1 ROWS ONLY) dn') throw new Error(JSON.stringify(column));
    },
  },
  {
    name: 'インラインビューの中の FETCH FIRST の前の条件の範囲は、FETCH FIRST まで延ばさない',
    category: 'regression',
    sql: 'SELECT v.id FROM (SELECT e.id FROM emp e WHERE e.k = 2 FETCH FIRST 5 ROWS ONLY) v',
    expectSuccess: true,
    assert: (q) => {
      const sql = 'SELECT v.id FROM (SELECT e.id FROM emp e WHERE e.k = 2 FETCH FIRST 5 ROWS ONLY) v';
      const span = q.tables[0]?.derivedQuery?.where?.sourceSpan;
      const text = span && sql.slice(span.start, span.end);
      if (text !== 'e.k = 2') throw new Error(JSON.stringify(text));
    },
  },
  {
    name: '関数の結果に続けてメソッドを呼ぶ書き方は、未対応と伝える（「.」の構文エラーにしない）',
    category: 'error',
    sql: 'SELECT XMLAGG(XMLELEMENT("e", e.name)).getClobVal() FROM emp e',
    expectSuccess: false,
    errorContains: '関数の結果のメソッドを呼ぶ書き方',
  },
  {
    name: 'DUAL も SQL 上の範囲を持つ（JOIN 図のノードと SQL が連動する）',
    category: 'oracle',
    sql: 'SELECT 1 FROM  DUAL',
    expectSuccess: true,
    assert: (q) => {
      const span = q.tables[0]?.sourceSpan;
      if (!span || 'SELECT 1 FROM  DUAL'.slice(span.start, span.end) !== 'DUAL') throw new Error(JSON.stringify(span));
    },
  },
  {
    name: '括弧の中で集合演算をまとめる書き方は、未対応と伝える',
    category: 'error',
    sql: '(SELECT x FROM t1 MINUS SELECT x FROM t2) INTERSECT SELECT x FROM t3',
    expectSuccess: false,
    errorContains: '括弧の中で集合演算をまとめる書き方',
  },
  {
    name: '列を書き忘れた SELECT は、原因が分かるエラーにする',
    category: 'error',
    sql: 'SELECT FROM employees',
    expectSuccess: false,
    errorContains: 'SELECT の後ろに、表示する列がありません',
  },
  {
    name: '最後の列の後ろに残った「,」は、原因が分かるエラーにする',
    category: 'error',
    sql: 'SELECT e.emp_no,\n  FROM employees e',
    expectSuccess: false,
    errorContains: '「,」の後ろに列がありません',
  },
  {
    name: '引用符なしで書けない名前は、引用符で囲んで表示する（AS User Name を別名 User に見せない）',
    category: 'oracle',
    sql: 'SELECT u.name AS "User Name", u."x y", "T"."Id", 売上.金額 AS 合計 FROM users u, 売上, "T" ORDER BY "User Name"',
    expectSuccess: true,
    assert: (q) => {
      const texts = q.columns.map((c) => [c.expression, c.alias ?? null]);
      const expected = [
        ['u.name', 'User Name'],
        ['u."x y"', null],
        ['T.Id', null],
        ['売上.金額', '合計'],
      ];
      if (JSON.stringify(texts) !== JSON.stringify(expected)) throw new Error(JSON.stringify(texts));
      if (q.orderBy[0]?.text !== '"User Name"') throw new Error(q.orderBy[0]?.text);
    },
  },
  {
    name: 'FROM 句の TABLE(…) は未対応と伝える（「(」の構文エラーにしない）',
    category: 'error',
    sql: 'SELECT e.id FROM emp e WHERE e.id IN (SELECT column_value FROM TABLE(sys.odcinumberlist(1, 2)))',
    expectSuccess: false,
    errorContains: 'TABLE(…)',
  },
  {
    name: '再帰的な WITH の CYCLE 句は未対応と伝える',
    category: 'error',
    sql: `WITH r (id, p) AS (SELECT id, p FROM t WHERE p IS NULL UNION ALL SELECT t.id, t.p FROM t JOIN r ON t.p = r.id)
CYCLE id SET is_cycle TO 'Y' DEFAULT 'N'
SELECT * FROM r`,
    expectSuccess: false,
    errorContains: 'CYCLE 句',
  },
  {
    name: 'ウィンドウ枠の境界の INTERVAL は未対応と伝える',
    category: 'error',
    sql: "SELECT SUM(e.sal) OVER (ORDER BY e.d RANGE BETWEEN INTERVAL '7' DAY PRECEDING AND CURRENT ROW) s FROM emp e",
    expectSuccess: false,
    errorContains: 'INTERVAL',
  },
  {
    name: 'RETURNING … INTO は未対応と伝える',
    category: 'error',
    sql: 'DELETE FROM emp e WHERE e.id = 1 RETURNING e.name INTO :n',
    expectSuccess: false,
    errorContains: 'RETURNING … INTO 句',
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
      if (texts.join('|') !== 't.a   DESC|t.b\n  ASC NULLS LAST') throw new Error(JSON.stringify(texts));
    },
  },
  {
    name: 'ORDER BY の項目の範囲は NULLS FIRST / LAST まで含む',
    category: 'regression',
    sql: 'SELECT e.id FROM emp e ORDER BY e.sal DESC NULLS LAST, e.id NULLS FIRST',
    expectSuccess: true,
    assert: (q) => {
      const sql = 'SELECT e.id FROM emp e ORDER BY e.sal DESC NULLS LAST, e.id NULLS FIRST';
      const texts = q.orderBy.map((o) => sql.slice(o.sourceSpan!.start, o.sourceSpan!.end));
      if (texts.join('|') !== 'e.sal DESC NULLS LAST|e.id NULLS FIRST') throw new Error(JSON.stringify(texts));
    },
  },
  {
    name: 'LISTAGG の WITHIN GROUP と、集約の KEEP を表示に残す',
    category: 'oracle',
    sql: `SELECT d.dept_no,
       LISTAGG(e.name, ',')  WITHIN  GROUP (ORDER BY e.name DESC NULLS LAST) names,
       MAX(e.sal) KEEP (DENSE_RANK LAST ORDER BY e.hire_date) last_sal,
       NVL(MIN(e.sal) KEEP (DENSE_RANK FIRST ORDER BY e.hire_date), 0) first_sal
FROM dept d JOIN emp e ON e.dept_no = d.dept_no
GROUP BY d.dept_no`,
    expectSuccess: true,
    assert: (q) => {
      const texts = q.columns.map((c) => c.expression);
      const expected = [
        'd.dept_no',
        "LISTAGG(e.name, ',') WITHIN GROUP (ORDER BY e.name DESC NULLS LAST)",
        'MAX(e.sal) KEEP (DENSE_RANK LAST ORDER BY e.hire_date)',
        'NVL(MIN(e.sal) KEEP (DENSE_RANK FIRST ORDER BY e.hire_date), 0)',
      ];
      if (JSON.stringify(texts) !== JSON.stringify(expected)) throw new Error(JSON.stringify(texts));
    },
  },
  {
    name: 'ウィンドウ枠の RANGE を読み、表示でも RANGE のまま出す（ROWS と取り違えない）',
    category: 'oracle',
    sql: `SELECT SUM(e.sal) OVER (ORDER BY e.d RANGE BETWEEN 30 PRECEDING AND CURRENT ROW) a,
       SUM(e.sal) OVER (ORDER BY e.d NULLS FIRST ROWS 3 PRECEDING) b,
       COUNT(*) OVER (ORDER BY e.d RANGE UNBOUNDED PRECEDING) c
FROM emp e
WHERE e.range BETWEEN 1 AND 2`,
    expectSuccess: true,
    assert: (q) => {
      const texts = q.columns.map((c) => c.expression);
      const expected = [
        'SUM(e.sal) OVER (ORDER BY e.d RANGE BETWEEN 30 PRECEDING AND CURRENT ROW)',
        'SUM(e.sal) OVER (ORDER BY e.d NULLS FIRST ROWS 3 PRECEDING)',
        'COUNT(*) OVER (ORDER BY e.d RANGE UNBOUNDED PRECEDING)',
      ];
      if (JSON.stringify(texts) !== JSON.stringify(expected)) throw new Error(JSON.stringify(texts));
      if (q.where?.label !== 'e.range BETWEEN 1 AND 2') throw new Error(q.where?.label);
    },
  },
  {
    name: 'CASE 式・文字列・数値・NULL の列も、SQL 上の範囲を持つ（クリックとカーソルで SQL と連動する）',
    category: 'regression',
    sql: `WITH c AS (SELECT 1 x, 'a' y FROM dual)
SELECT /*+ FULL(c) */ DISTINCT CASE WHEN c.x > 1 THEN 'a' END k, 'lit' AS l, -- comment, with comma
       NULL, q'[a,b]' z, c.x
FROM c`,
    expectSuccess: true,
    assert: (q) => {
      const sql = `WITH c AS (SELECT 1 x, 'a' y FROM dual)
SELECT /*+ FULL(c) */ DISTINCT CASE WHEN c.x > 1 THEN 'a' END k, 'lit' AS l, -- comment, with comma
       NULL, q'[a,b]' z, c.x
FROM c`;
      const texts = (cols: typeof q.columns) => cols.map((c) => (c.sourceSpan ? sql.slice(c.sourceSpan.start, c.sourceSpan.end) : null));
      const main = texts(q.columns);
      const expected = ["CASE WHEN c.x > 1 THEN 'a' END k", "'lit' AS l", 'NULL', "q'[a,b]' z", 'c.x'];
      if (JSON.stringify(main) !== JSON.stringify(expected)) throw new Error(JSON.stringify(main));
      const cte = texts(q.ctes![0]!.query.columns);
      if (JSON.stringify(cte) !== JSON.stringify(['1 x', "'a' y"])) throw new Error(JSON.stringify(cte));
    },
  },
  {
    name: 'インラインビューも SQL 上の範囲（括弧から別名まで）を持つ（JOIN 図のノードと SQL が連動する）',
    category: 'subquery',
    sql: 'SELECT "V".id, w.id FROM a, (SELECT 1 id FROM dual) /* c */ "V", (SELECT 2 id FROM dual) w WHERE w.id = "V".id AND a.id = w.id',
    expectSuccess: true,
    assert: (q) => {
      const sql =
        'SELECT "V".id, w.id FROM a, (SELECT 1 id FROM dual) /* c */ "V", (SELECT 2 id FROM dual) w WHERE w.id = "V".id AND a.id = w.id';
      const texts = q.tables.map((t) => (t.sourceSpan ? sql.slice(t.sourceSpan.start, t.sourceSpan.end) : null));
      const expected = ['a', '(SELECT 1 id FROM dual) /* c */ "V"', '(SELECT 2 id FROM dual) w'];
      if (JSON.stringify(texts) !== JSON.stringify(expected)) throw new Error(JSON.stringify(texts));
    },
  },
  {
    name: 'インラインビューの名前の括弧は全角で、作用の説明と同じ書き方にする',
    category: 'subquery',
    sql: 'SELECT v.sal FROM (SELECT e.sal FROM emp e) v',
    expectSuccess: true,
    assert: (q) => {
      if (q.tables[0]?.displayName !== 'v（派生テーブル）') throw new Error(q.tables[0]?.displayName);
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
    name: '複数列の同時更新は、各列にサブクエリの何列目を代入するかを書く',
    category: 'update',
    sql: 'UPDATE emp e SET (e.sal, e.comm) = (SELECT 1, 2 FROM dual), e.x = 3, (a, b, c) = (SELECT p, q, r FROM t)',
    expectSuccess: true,
    assert: (q) => {
      const labels = q.setClauses?.map((s) => s.label).join(' | ');
      const expected = [
        'e.sal = (SELECT 2列 FROM DUAL) の 1 列目',
        'e.comm = (SELECT 2列 FROM DUAL) の 2 列目',
        'e.x = 3',
        'a = (SELECT 3列 FROM t) の 1 列目',
        'b = (SELECT 3列 FROM t) の 2 列目',
        'c = (SELECT 3列 FROM t) の 3 列目',
      ].join(' | ');
      if (labels !== expected) throw new Error(labels);
    },
  },
  {
    // 構文図 update_set_clause: `( column [, column ]... ) = ( subquery )`。列が 1 つでも括弧で囲める
    name: '1 列だけを括弧で囲んだ SET (a) = (SELECT …) も読む',
    category: 'update',
    sql: 'UPDATE emp e SET (sal) = (\n  -- c\n  SELECT 1 FROM dual), x = 1',
    expectSuccess: true,
    assert: (q) => {
      const labels = q.setClauses?.map((s) => s.label).join(' | ');
      if (labels !== 'sal = (SELECT 1列 FROM DUAL) | x = 1') throw new Error(labels);
    },
  },
  {
    name: 'SET の値の中の (x, y) = (SELECT …) は比較なので、複数列の同時更新として展開しない',
    category: 'update',
    sql: 'UPDATE emp e SET a = CASE WHEN (x, y) = (SELECT p, q FROM s) THEN 1 ELSE 0 END',
    expectSuccess: true,
    assert: (q) => {
      const labels = q.setClauses?.map((s) => s.label).join(' | ');
      if (labels !== 'a = CASE WHEN (x, y) = (SELECT 2列 FROM s) THEN 1 ELSE 0 END') throw new Error(labels);
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
    name: 'Oracle: 階層問い合わせの単項演算子 CONNECT_BY_ROOT と、SELECT 列の PRIOR',
    category: 'oracle',
    sql: `SELECT LEVEL lv, CONNECT_BY_ROOT e.emp_name root, PRIOR e.emp_name boss, CONNECT_BY_ROOT "E"."Name" r2
FROM employees e START WITH e.manager_no IS NULL CONNECT BY PRIOR e.emp_no = e.manager_no`,
    expectSuccess: true,
    assert: (q) => {
      const cols = q.columns.map((c) => c.expression).join(' | ');
      if (cols !== 'LEVEL | CONNECT_BY_ROOT e.emp_name | PRIOR e.emp_name | CONNECT_BY_ROOT E.Name') throw new Error(cols);
      if (!q.hierarchical?.connectBy) throw new Error('hierarchical');
    },
  },
  {
    name: 'Oracle: (+) を含む条件を OR でつなぐと、外部結合の制限としてエラーにする',
    category: 'error',
    sql: 'SELECT a.id FROM tab_a a, tab_b b WHERE a.id = b.a_id(+) AND a.x = 1 OR a.y = 2',
    expectSuccess: false,
    errorContains: 'OR でつなげません',
  },
  {
    name: 'Oracle: (+) を付けた列を IN で比べると、外部結合の制限としてエラーにする',
    category: 'error',
    sql: "SELECT a.id FROM tab_a a, tab_b b WHERE a.id = b.a_id(+) AND b.kind(+) IN ('A', 'B')",
    expectSuccess: false,
    errorContains: 'IN で比べられません',
  },
  {
    // SQL Language Reference「Joins」: (+) は FROM 句に JOIN の構文がある問い合わせのブロックでは使えない（ORA-25156）
    name: 'Oracle: JOIN … ON の中の (+) は、JOIN の構文と混ぜた書き方としてエラーにする',
    category: 'error',
    sql: 'SELECT e.id FROM emp e INNER JOIN dept d ON e.dept_id = d.id(+)',
    expectSuccess: false,
    errorContains: 'JOIN を書いた SELECT では使えません',
  },
  {
    name: 'Oracle: JOIN … ON とカンマ結合を混ぜた SELECT の WHERE の (+) もエラーにする',
    category: 'error',
    sql: 'SELECT e.id FROM emp e JOIN dept d ON d.id = e.dept_id, loc l WHERE l.id(+) = d.loc_id',
    expectSuccess: false,
    errorContains: 'JOIN を書いた SELECT では使えません',
  },
  {
    name: 'Oracle: JOIN を使う SELECT の中でも、サブクエリの (+) は別の問い合わせとして読む',
    category: 'oracle',
    sql: 'SELECT e.id FROM emp e JOIN dept d ON d.id = e.dept_id WHERE EXISTS (SELECT 1 FROM loc l, area a WHERE l.area_id = a.id(+) AND l.id = d.loc_id)',
    expectSuccess: true,
  },
  {
    // ORA-01468: a predicate may reference only one outer-joined table
    name: 'Oracle: 1 つの条件の両側に (+) を付けると、エラーにする',
    category: 'error',
    sql: 'SELECT e.id FROM emp e, dept d WHERE e.dept_id(+) = d.id(+)',
    expectSuccess: false,
    errorContains: '2 つの表（e、d）に付けています',
  },
  {
    name: 'Oracle: SQL の最後の (+) も、結合条件の範囲に入れる',
    category: 'oracle',
    sql: 'SELECT * FROM emp e, dept d, loc l WHERE e.dept_id = d.id(+) AND d.loc_id = l.id (+)',
    expectSuccess: true,
    assert: (q) => {
      const sql = 'SELECT * FROM emp e, dept d, loc l WHERE e.dept_id = d.id(+) AND d.loc_id = l.id (+)';
      const texts = q.joins.map((j) => (j.sourceSpan ? sql.slice(j.sourceSpan.start, j.sourceSpan.end) : ''));
      if (texts.join(' | ') !== 'e.dept_id = d.id(+) | d.loc_id = l.id (+)') throw new Error(texts.join(' | '));
    },
  },
  {
    name: 'Oracle: (+) の結合とは別に、OR の条件を括弧で囲んだ WHERE は読む',
    category: 'oracle',
    sql: "SELECT a.id FROM tab_a a, tab_b b WHERE a.id = b.a_id(+) AND (b.kind = 'X' OR b.kind IS NULL)",
    expectSuccess: true,
    assert: (q) => {
      if (q.joins[0]?.type !== 'LEFT JOIN') throw new Error(q.joins[0]?.type);
    },
  },
  {
    name: 'Oracle: CAST の型名は元の SQL の書き方で表示する',
    category: 'oracle',
    sql: 'SELECT CAST(t.v AS NUMBER(10, 2)) a, CAST(t.w AS VARCHAR2(20)) b, CAST(t.x AS DATE) c FROM t',
    expectSuccess: true,
    assert: (q) => {
      const cols = q.columns.map((c) => c.expression).join(' | ');
      if (cols !== 'CAST(t.v AS NUMBER(10, 2)) | CAST(t.w AS VARCHAR2(20)) | CAST(t.x AS DATE)') throw new Error(cols);
    },
  },
  {
    name: 'Oracle: フラッシュバックの時刻を式で書いた AS OF TIMESTAMP',
    category: 'oracle',
    sql: "SELECT t.id FROM emp AS OF TIMESTAMP SYSTIMESTAMP - INTERVAL '1' HOUR t, dept AS OF SCN 12345 d WHERE t.d = d.id",
    expectSuccess: true,
    assert: (q) => {
      if (q.tables.map((t) => t.alias).join(',') !== 't,d') throw new Error(q.tables.map((t) => t.alias).join(','));
    },
  },
  {
    name: 'Oracle: 集約関数の UNIQUE（DISTINCT と同じ意味）',
    category: 'oracle',
    sql: 'SELECT t.a, COUNT(UNIQUE t.b), SUM(UNIQUE t.c) FROM t GROUP BY t.a',
    expectSuccess: true,
    assert: (q) => {
      const cols = q.columns.map((c) => c.expression).join(' | ');
      if (cols !== 't.a | COUNT(DISTINCT t.b) | SUM(DISTINCT t.c)') throw new Error(cols);
    },
  },
  {
    name: '最初のブランチだけに掛かる行制限句を、集合演算の全体のものにしない',
    category: 'union',
    sql: '(SELECT x FROM t1 ORDER BY x FETCH FIRST 1 ROWS ONLY) UNION ALL (SELECT x FROM t2) ORDER BY 1',
    expectSuccess: true,
    assert: (q) => {
      if (q.limit !== undefined) throw new Error(`limit: ${q.limit}`);
      if (q.orderBy.map((o) => o.text).join() !== '1') throw new Error(q.orderBy.map((o) => o.text).join());
      if (q.unionBranches?.[0]?.query.limit !== '1') throw new Error('branch limit');
    },
  },
  {
    name: 'Oracle: 別名の無いインラインビューから DELETE する',
    category: 'delete',
    sql: 'DELETE FROM (SELECT * FROM employees WHERE dept_no = 10) WHERE sal < 1000',
    expectSuccess: true,
    assert: (q) => {
      if (q.tables[0]?.table !== '派生テーブル1') throw new Error(q.tables[0]?.table);
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
