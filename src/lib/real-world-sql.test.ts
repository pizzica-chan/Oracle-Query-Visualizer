import { describe, expect, it } from 'vitest';
import { parseOracleQuery } from './parser';
import { buildQueryEffect } from './query-effect';
import type { ParsedQuery } from './types';

/**
 * 実運用で書かれる Oracle SQL を通しで解析できるかの試験。
 * 解析が通るだけでなく、表示テキストへ AST がそのまま漏れていないかまで見る
 * （「エラーは出ないが中身が壊れている」が一番危ないため）
 */

function parseOk(sql: string): ParsedQuery {
  const result = parseOracleQuery(sql);
  expect(result.success, result.success ? '' : `${result.error.message} :: ${sql}`).toBe(true);
  if (!result.success) throw new Error('unreachable');
  return result.query;
}

/** 解析結果から画面に出る文字列をすべて集める */
function displayTexts(query: ParsedQuery): string[] {
  const texts: string[] = [
    ...query.columns.map((c) => c.expression),
    ...query.groupBy.map((g) => g.text),
    ...query.orderBy.map((o) => o.text),
    ...query.joins.map((j) => j.condition),
    ...(query.setClauses ?? []).map((s) => s.label),
    query.where?.label ?? '',
    query.having?.label ?? '',
  ];
  const effect = buildQueryEffect(query, 'japanese');
  for (const section of effect.sections) texts.push(...(section.lines ?? []).map((l) => l.text));
  texts.push(effect.summary);
  return texts;
}

function expectNoInternalLeak(sql: string): ParsedQuery {
  const query = parseOk(sql);
  const joined = displayTexts(query).join(' | ');
  expect(joined, `AST が表示へ漏れた: ${sql}`).not.toMatch(/"type"|tableList|columnList|\[object Object\]/);
  expect(joined, `CASE の条件が空になった: ${sql}`).not.toMatch(/WHEN\s+THEN/);
  return query;
}

describe('実運用 SQL の解析', () => {
  describe('分析関数', () => {
    it.each([
      'SELECT empno, COUNT(*) OVER (PARTITION BY deptno) c FROM emp',
      'SELECT empno, COUNT(*) OVER () c FROM emp',
      'SELECT RANK() OVER (PARTITION BY deptno ORDER BY sal DESC NULLS LAST) r FROM emp',
      'SELECT LEAD(sal, 1, 0) OVER (PARTITION BY deptno ORDER BY sal DESC) nx FROM emp',
      'SELECT SUM(sal) OVER (ORDER BY hiredate ROWS UNBOUNDED PRECEDING) rt FROM emp',
      "SELECT COUNT(*) OVER (PARTITION BY TO_CHAR(hiredate,'YYYY') ORDER BY hiredate ROWS BETWEEN 3 PRECEDING AND 1 FOLLOWING) c FROM emp",
      'SELECT NTILE(4) OVER (ORDER BY sal) q FROM emp',
      'SELECT RATIO_TO_REPORT(sal) OVER (PARTITION BY deptno) r FROM emp',
      "SELECT TRUNC(AVG(sal) KEEP (DENSE_RANK FIRST ORDER BY hiredate) OVER (PARTITION BY deptno)) a FROM emp",
    ])('%s', (sql) => {
      expectNoInternalLeak(sql);
    });

    it('OVER 句の内容を表示テキストに残す', () => {
      const query = parseOk('SELECT ROW_NUMBER() OVER (PARTITION BY a ORDER BY b DESC) rn FROM t');
      expect(query.columns[0]?.expression).toBe('ROW_NUMBER() OVER (PARTITION BY a ORDER BY b DESC)');
    });
  });

  describe('集約・グループ化', () => {
    it.each([
      'SELECT job_id, SUM(salary) FROM employees GROUP BY ROLLUP(job_id)',
      'SELECT department_id, job_id, SUM(salary) FROM employees GROUP BY CUBE(department_id, job_id)',
      'SELECT dept_no, COUNT(DISTINCT job) c FROM emp GROUP BY dept_no HAVING COUNT(*) > 5',
      "SELECT SUM(CASE WHEN status = 'A' THEN 1 ELSE 0 END) a, COUNT(*) c FROM t",
      "SELECT LISTAGG(emp_name, ', ') WITHIN GROUP (ORDER BY emp_name) nm FROM emp GROUP BY dept_no",
    ])('%s', (sql) => {
      expectNoInternalLeak(sql);
    });
  });

  describe('Oracle 関数', () => {
    it.each([
      "SELECT NVL2(comm, 'Y', 'N') a, COALESCE(a, b, c) b, NULLIF(x, y) c FROM t",
      "SELECT DECODE(status, 'A', '有効', 'I', '無効', '不明') s FROM t",
      'SELECT GREATEST(a, b, c) g, LEAST(a, b, c) l FROM t',
      "SELECT ADD_MONTHS(SYSDATE, -1) m, MONTHS_BETWEEN(d1, d2) mb, LAST_DAY(SYSDATE) ld FROM dual",
      "SELECT TRUNC(SYSDATE, 'MM') m, EXTRACT(YEAR FROM SYSDATE) y FROM dual",
      "SELECT REGEXP_SUBSTR(a, '[^,]+', 1, 2) p, REGEXP_REPLACE(a, 'x+', ' ') n FROM t",
      "SELECT REGEXP_LIKE(a, '^[0-9]+$') FROM t WHERE REGEXP_LIKE(b, 'x.*y')",
      "SELECT TO_CHAR(1234.5, '9,999.99') c, TO_NUMBER('1234') n FROM dual",
      'SELECT SYSTIMESTAMP, CURRENT_DATE, USER, UID FROM dual',
      'SELECT emp_seq.NEXTVAL FROM dual',
      'SELECT ROWID, ROWNUM, emp_no FROM employees WHERE ROWNUM <= 5',
    ])('%s', (sql) => {
      expectNoInternalLeak(sql);
    });

    it('EXTRACT の対象フィールドを表示テキストに残す', () => {
      const query = parseOk('SELECT EXTRACT(YEAR FROM hiredate) y FROM emp');
      expect(query.columns[0]?.expression).toBe('EXTRACT(YEAR FROM hiredate)');
    });

    it("TRIM(BOTH … FROM …) をカンマ区切りにしない", () => {
      const query = parseOk("SELECT TRIM(BOTH ' ' FROM name) t FROM t");
      expect(query.columns[0]?.expression).not.toContain("' ',");
    });
  });

  describe('データディクショナリ問い合わせ', () => {
    it.each([
      'SELECT sid, serial#, username, status FROM v$session WHERE username IS NOT NULL',
      "SELECT owner, table_name, num_rows FROM all_tables WHERE owner = 'HR' ORDER BY num_rows DESC",
      "SELECT c.constraint_name, cc.column_name FROM user_constraints c JOIN user_cons_columns cc ON cc.constraint_name = c.constraint_name WHERE c.table_name = 'EMPLOYEES'",
      'SELECT tablespace_name, ROUND(SUM(bytes)/1024/1024) mb FROM dba_data_files GROUP BY tablespace_name',
    ])('%s', (sql) => {
      expectNoInternalLeak(sql);
    });

    it("v$session と v$sql の (+) 結合を外部結合として読む", () => {
      const query = parseOk(
        "SELECT s.sid, q.sql_text FROM v$session s, v$sql q WHERE s.sql_id = q.sql_id(+) AND s.status = 'ACTIVE'",
      );
      expect(query.tables.map((t) => t.table)).toEqual(['v$session', 'v$sql']);
      expect(query.joins).toHaveLength(1);
      expect(query.joins[0]?.type).toBe('LEFT JOIN');
    });
  });

  describe('業務システムの定番パターン', () => {
    it('ROWNUM による二重入れ子のページング', () => {
      const query = parseOk(`SELECT * FROM (
  SELECT a.*, ROWNUM rnum FROM (
    SELECT emp_no, emp_name FROM employees ORDER BY emp_no
  ) a WHERE ROWNUM <= 20
) WHERE rnum > 10`);
      expect(query.tables[0]?.isDerived).toBe(true);
    });

    it('部門ごとの最大値を取る自己結合', () => {
      const query = parseOk(
        'SELECT e.* FROM employees e WHERE e.sal = (SELECT MAX(sal) FROM employees WHERE dept_no = e.dept_no)',
      );
      expect(query.where?.nestedQuery).toBeDefined();
    });

    it('複数列 IN による最大値抽出', () => {
      expectNoInternalLeak(
        'SELECT emp_no FROM employees WHERE (dept_no, sal) IN (SELECT dept_no, MAX(sal) FROM employees GROUP BY dept_no)',
      );
    });

    it('階層問い合わせ + ORDER SIBLINGS BY', () => {
      const query = parseOk(`SELECT emp_no, LEVEL, LPAD(' ', LEVEL*2) || emp_name AS tree
FROM employees START WITH manager_no IS NULL CONNECT BY PRIOR emp_no = manager_no
ORDER SIBLINGS BY emp_name`);
      expect(query.hierarchical?.connectBy).toBe('PRIOR emp_no = manager_no');
      expect(query.orderBy.map((o) => o.text)).toEqual(['emp_name']);
    });

    it('SYS_CONNECT_BY_PATH / CONNECT_BY_ISLEAF', () => {
      expectNoInternalLeak(
        "SELECT SYS_CONNECT_BY_PATH(emp_name, '/') p, CONNECT_BY_ISLEAF l FROM employees START WITH manager_no IS NULL CONNECT BY PRIOR emp_no = manager_no",
      );
    });

    it.each([
      'SELECT DISTINCT e.dept_no FROM employees e WHERE e.sal > ALL (SELECT sal FROM employees WHERE dept_no = 10)',
      'SELECT e.emp_no FROM employees e WHERE e.sal > ANY (SELECT sal FROM employees WHERE dept_no = 20)',
      "SELECT * FROM emp WHERE deptno = :dept_no AND sal > :min_sal",
      "SELECT * FROM emp e WHERE (e.sal, e.job) IN ((1000, 'CLERK'), (2000, 'MANAGER'))",
    ])('%s', (sql) => {
      expectNoInternalLeak(sql);
    });
  });

  describe('結果集合の形を変えない Oracle 固有の修飾', () => {
    it('パーティション指定 PARTITION (p)', () => {
      const query = parseOk('SELECT * FROM employees PARTITION (p2024) WHERE sal > 1');
      expect(query.tables[0]?.table).toBe('employees');
      expect(query.where).toBeDefined();
    });

    it('データベースリンク table@dblink', () => {
      const query = parseOk('SELECT * FROM scott.emp@dblink WHERE deptno = 10');
      expect(query.tables[0]?.schema).toBe('scott');
      expect(query.tables[0]?.table).toBe('emp');
    });

    it('行ロック FOR UPDATE / FOR UPDATE OF … NOWAIT', () => {
      expect(parseOk('SELECT * FROM employees FOR UPDATE').tables).toHaveLength(1);
      const query = parseOk('SELECT * FROM employees WHERE sal > 1 FOR UPDATE OF sal NOWAIT');
      expect(query.where?.label).toBe('sal > 1');
    });

    it('フラッシュバック AS OF TIMESTAMP', () => {
      const query = parseOk(
        "SELECT * FROM employees AS OF TIMESTAMP (SYSTIMESTAMP - INTERVAL '1' HOUR) WHERE sal > 1",
      );
      expect(query.tables[0]?.table).toBe('employees');
    });

    it('サンプリング SAMPLE (n)', () => {
      expect(parseOk('SELECT * FROM employees SAMPLE (10) WHERE sal > 1').tables).toHaveLength(1);
    });
  });

  describe('実務で見かける書き方', () => {
    it.each([
      'select e.EMP_NO , e.emp_name,d.DEPT_NAME\n  from EMPLOYEES e , DEPARTMENTS d\n where e.dept_no=d.dept_no\n   and e.sal >1000\n order by 1',
      'SELECT /*+ INDEX(e emp_idx) FULL(d) */ e.emp_no FROM employees e, departments d WHERE e.dept_no = d.dept_no',
      "SELECT * FROM employees WHERE emp_name = 'O''Brien' AND note = q'[it's a test]'",
      'SELECT "Emp No", "Dept Name" FROM "Employee Master" WHERE "Emp No" > 0',
      'SELECT emp_no FROM employees WHERE UPPER(emp_name) LIKE UPPER(\'%smith%\')',
      'SELECT e.emp_no -- 社員番号\n     , e.emp_name /* 氏名 */\n  FROM employees e\n WHERE e.retired_flg = 0 -- 退職者は除く',
    ])('%s', (sql) => {
      expectNoInternalLeak(sql);
    });

    it('引用識別子に含まれる空白を名前として保つ', () => {
      const query = parseOk('SELECT "Emp No" FROM "Employee Master"');
      expect(query.tables[0]?.table).toBe('Employee Master');
      expect(query.columns[0]?.expression).toBe('Emp No');
    });
  });

  describe('未対応構文は理由が分かるエラーにする', () => {
    it.each([
      ["SELECT * FROM sales PIVOT (SUM(amount) FOR quarter IN ('Q1' AS q1))", 'PIVOT'],
      ['SELECT * FROM sales UNPIVOT (amount FOR quarter IN (q1, q2))', 'UNPIVOT'],
      [
        'SELECT department_id, SUM(salary) FROM employees GROUP BY GROUPING SETS ((department_id), ())',
        'GROUPING SETS',
      ],
      ['SELECT * FROM orders o CROSS APPLY (SELECT * FROM details d) x', 'APPLY'],
      ['MERGE INTO t1 USING t2 ON (t1.id = t2.id) WHEN MATCHED THEN UPDATE SET t1.v = t2.v', 'MERGE'],
      ['INSERT INTO t (a) VALUES (1)', 'INSERT'],
      ['BEGIN NULL; END;', 'PL/SQL'],
      ['CREATE TABLE t (a NUMBER)', 'CREATE'],
    ])('%s → %s を含むエラー', (sql, keyword) => {
      const result = parseOracleQuery(sql);
      expect(result.success).toBe(false);
      if (result.success) return;
      expect(result.error.message).toContain(keyword);
      // 生のパーサエラー（英語の Expected … but … found）をそのまま見せない
      expect(result.error.message).not.toContain('Expected');
    });
  });
});
