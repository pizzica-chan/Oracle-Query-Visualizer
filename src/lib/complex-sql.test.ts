import { describe, expect, it } from 'vitest';
import { parseOracleQuery } from './parser';
import { buildQueryEffect } from './query-effect';
import { assertParseInvariants } from './fixtures/parse-invariants';
import { collectAllNestedQueries } from './query-utils';
import { applyAliasResolution } from './alias-resolver';
import { buildJoinFlowLayout } from './join-flow-layout';
import type { ConditionNode, ParsedQuery, SourceSpan } from './types';

interface Case {
  name: string;
  sql: string;
  /** 期待値（分かる範囲で明示し、構造の取りこぼしを検出する） */
  want?: { tables?: number; joins?: number; nested?: number; branches?: number; ctes?: number };
}

const CASES: Case[] = [];
const add = (c: Case) => CASES.push(c);

// ---------------------------------------------------------------------------
// 1. 多段 JOIN + 深いサブクエリ
// ---------------------------------------------------------------------------
add({
  name: '10 テーブル多段 JOIN + 派生テーブル 2 つ',
  want: { tables: 10, joins: 9 },
  sql: `SELECT u.user_id, o.order_no, p.product_name, c.category_name, w.warehouse_name,
       s.qty, pay.paid_at, cp.coupon_cd, hot.order_cnt, rk.rnk
FROM users u
INNER JOIN orders o          ON o.user_id = u.user_id
LEFT  JOIN order_items oi    ON oi.order_id = o.order_id
INNER JOIN products p        ON p.product_id = oi.product_id
LEFT  JOIN categories c      ON c.category_id = p.category_id
LEFT  JOIN stocks s          ON s.product_id = p.product_id AND s.warehouse_id = 1
LEFT  JOIN warehouses w      ON w.warehouse_id = s.warehouse_id
LEFT  JOIN payments pay      ON pay.order_id = o.order_id AND pay.status = 'PAID'
INNER JOIN (SELECT user_id, COUNT(*) order_cnt FROM orders GROUP BY user_id HAVING COUNT(*) >= 3) hot
       ON hot.user_id = u.user_id
LEFT  JOIN (SELECT order_id, RANK() OVER (PARTITION BY user_id ORDER BY total DESC) rnk, coupon_cd
              FROM orders) rk
       ON rk.order_id = o.order_id
WHERE u.status = 'ACTIVE'
  AND o.created_at >= TO_DATE('2024-01-01','YYYY-MM-DD')
ORDER BY o.created_at DESC`,
});

add({
  name: '4 段ネストした相関サブクエリ',
  want: { nested: 4 },
  sql: `SELECT e.emp_no, e.emp_name
FROM employees e
WHERE EXISTS (
  SELECT 1 FROM orders o
  WHERE o.emp_no = e.emp_no
    AND o.total > (
      SELECT AVG(o2.total) FROM orders o2
      WHERE o2.dept_no = e.dept_no
        AND o2.product_id IN (
          SELECT p.product_id FROM products p
          WHERE p.category_id IN (
            SELECT c.category_id FROM categories c WHERE c.active_flg = 1
          )
        )
    )
)`,
});

add({
  name: 'FROM 句に 3 段ネストしたインラインビュー',
  sql: `SELECT lvl1.* FROM (
  SELECT lvl2.dept_no, SUM(lvl2.sal) total FROM (
    SELECT lvl3.dept_no, lvl3.sal FROM (
      SELECT dept_no, sal FROM employees WHERE retired_flg = 0
    ) lvl3 WHERE lvl3.sal > 1000
  ) lvl2 GROUP BY lvl2.dept_no
) lvl1 WHERE lvl1.total > 10000`,
});

// ---------------------------------------------------------------------------
// 2. WITH 句（複数 CTE・CTE 同士の参照）
// ---------------------------------------------------------------------------
add({
  name: '3 つの CTE が連鎖参照する',
  want: { ctes: 3 },
  sql: `WITH base AS (
  SELECT o.order_id, o.user_id, o.total, o.created_at
  FROM orders o WHERE o.status = 'COMPLETED'
), per_user AS (
  SELECT b.user_id, COUNT(*) cnt, SUM(b.total) amt FROM base b GROUP BY b.user_id
), ranked AS (
  SELECT p.user_id, p.cnt, p.amt, RANK() OVER (ORDER BY p.amt DESC) rnk FROM per_user p
)
SELECT u.user_name, r.cnt, r.amt, r.rnk
FROM ranked r
INNER JOIN users u ON u.user_id = r.user_id
WHERE r.rnk <= 100
ORDER BY r.rnk`,
});

add({
  name: 'CTE + UNION ALL + 各ブランチに JOIN',
  want: { branches: 3 },
  sql: `WITH target_users AS (SELECT user_id FROM users WHERE status = 'ACTIVE')
SELECT 'ORDER' AS kind, o.order_id AS id, u.user_name
  FROM orders o INNER JOIN users u ON u.user_id = o.user_id
 WHERE o.user_id IN (SELECT user_id FROM target_users)
UNION ALL
SELECT 'RETURN', r.return_id, u.user_name
  FROM returns r INNER JOIN users u ON u.user_id = r.user_id
 WHERE EXISTS (SELECT 1 FROM target_users t WHERE t.user_id = r.user_id)
UNION ALL
SELECT 'INQUIRY', q.inquiry_id, u.user_name
  FROM inquiries q LEFT JOIN users u ON u.user_id = q.user_id
 WHERE q.created_at >= SYSDATE - 30
ORDER BY 1, 2`,
});

// ---------------------------------------------------------------------------
// 3. 旧式結合と ANSI 結合の混在・複雑な (+)
// ---------------------------------------------------------------------------
add({
  name: '5 テーブルの旧式結合（(+) 混在）',
  want: { tables: 5, joins: 4 },
  sql: `SELECT e.emp_no, d.dept_name, m.emp_name manager, b.bonus, g.grade_name
FROM employees e, departments d, employees m, bonuses b, grades g
WHERE e.dept_no = d.dept_no
  AND e.manager_no = m.emp_no(+)
  AND e.emp_no = b.emp_no(+)
  AND e.grade_cd = g.grade_cd
  AND b.fiscal_year(+) = 2024
  AND d.location IN ('TOKYO','OSAKA')
  AND (e.sal > 3000 OR e.job = 'MANAGER')
ORDER BY d.dept_name, e.emp_no`,
});

add({
  name: '旧式結合 + インラインビュー + 階層問い合わせ',
  sql: `SELECT e.emp_no, e.emp_name, LEVEL lv, s.total_sal
FROM employees e, (SELECT dept_no, SUM(sal) total_sal FROM employees GROUP BY dept_no) s
WHERE e.dept_no = s.dept_no(+)
  AND e.retired_flg = 0
START WITH e.manager_no IS NULL
CONNECT BY NOCYCLE PRIOR e.emp_no = e.manager_no
ORDER SIBLINGS BY e.emp_name`,
});

// ---------------------------------------------------------------------------
// 4. 巨大・深い WHERE 条件
// ---------------------------------------------------------------------------
add({
  name: '7 段ネストした AND/OR/NOT',
  sql: `SELECT id FROM t
WHERE (
  a = 1
  AND (
    b = 2
    OR (
      c = 3
      AND NOT (
        d = 4
        OR (
          e = 5
          AND (f BETWEEN 1 AND 10 OR g IN (1,2,3))
        )
      )
    )
  )
)
AND NOT (h IS NULL OR i NOT IN (SELECT j FROM u WHERE u.k = t.k))
AND (l LIKE 'x%' ESCAPE '!' OR m NOT LIKE '%y')`,
});

add({
  name: '大量の IN リスト（200 要素）',
  sql: `SELECT id FROM t WHERE cd IN (${Array.from({ length: 200 }, (_, i) => i + 1).join(', ')})`,
});

add({
  name: '30 個の AND 条件',
  sql: `SELECT id FROM t WHERE ${Array.from({ length: 30 }, (_, i) => `c${i} = ${i}`).join(' AND ')}`,
});

// ---------------------------------------------------------------------------
// 5. 分析関数・集約の入れ子
// ---------------------------------------------------------------------------
add({
  name: 'CASE を含む集約 + 分析関数 + 副問合せ',
  sql: `SELECT d.dept_no,
       SUM(CASE WHEN e.job = 'CLERK' THEN e.sal ELSE 0 END) clerk_sal,
       ROUND(AVG(CASE WHEN e.hired_at > SYSDATE - 365 THEN e.sal END), 2) new_avg,
       RANK() OVER (ORDER BY SUM(e.sal) DESC) dept_rank,
       (SELECT COUNT(*) FROM employees x WHERE x.dept_no = d.dept_no) emp_cnt
FROM departments d
INNER JOIN employees e ON e.dept_no = d.dept_no
WHERE d.active_flg = 1
GROUP BY d.dept_no
HAVING SUM(e.sal) > (SELECT AVG(sal) * 10 FROM employees)
ORDER BY dept_rank`,
});

add({
  name: '分析関数の入れ子（インラインビュー 2 段 + 行制限）',
  sql: `SELECT * FROM (
  SELECT inner1.*, ROW_NUMBER() OVER (PARTITION BY inner1.dept_no ORDER BY inner1.total DESC) rn
  FROM (
    SELECT e.dept_no, e.emp_no, SUM(o.total) OVER (PARTITION BY e.emp_no) total
    FROM employees e LEFT JOIN orders o ON o.emp_no = e.emp_no
  ) inner1
) WHERE rn <= 3
ORDER BY dept_no, rn
FETCH FIRST 50 ROWS ONLY`,
});

// ---------------------------------------------------------------------------
// 6. UPDATE / DELETE の複雑形
// ---------------------------------------------------------------------------
add({
  name: 'UPDATE: 複数列を副問合せで更新 + EXISTS',
  sql: `UPDATE employees e
SET (e.dept_no, e.grade_cd) = (
      SELECT d.dept_no, d.default_grade FROM departments d WHERE d.dept_code = e.dept_code
    ),
    e.updated_at = SYSDATE
WHERE EXISTS (SELECT 1 FROM departments d WHERE d.dept_code = e.dept_code)
  AND e.retired_flg = 0`,
});

add({
  name: 'UPDATE: インラインビュー更新',
  sql: `UPDATE (
  SELECT e.sal sal, d.budget budget
  FROM employees e INNER JOIN departments d ON d.dept_no = e.dept_no
  WHERE d.active_flg = 1
) SET sal = sal * 1.1`,
});

add({
  name: 'DELETE: 相関 EXISTS + NOT IN + ROWNUM',
  sql: `DELETE FROM order_items oi
WHERE EXISTS (
  SELECT 1 FROM orders o
  WHERE o.order_id = oi.order_id
    AND o.status = 'CANCELLED'
    AND o.created_at < ADD_MONTHS(SYSDATE, -12)
)
AND oi.order_id NOT IN (SELECT s.order_id FROM shipments s WHERE s.shipped_at IS NOT NULL)
AND ROWNUM <= 1000`,
});

// ---------------------------------------------------------------------------
// 7. 集合演算の複合
// ---------------------------------------------------------------------------
add({
  name: 'UNION ALL / MINUS / INTERSECT の混在 4 ブランチ',
  want: { branches: 4 },
  sql: `SELECT emp_no FROM employees WHERE dept_no = 10
UNION ALL
SELECT emp_no FROM employees WHERE dept_no = 20
MINUS
SELECT emp_no FROM retired_employees
INTERSECT
SELECT emp_no FROM project_members WHERE active_flg = 1`,
});

add({
  name: '集合演算の各ブランチに JOIN と副問合せ',
  want: { branches: 2 },
  sql: `SELECT u.user_id, o.order_no FROM users u
  INNER JOIN orders o ON o.user_id = u.user_id
  WHERE o.total > (SELECT AVG(total) FROM orders)
MINUS
SELECT u.user_id, o.order_no FROM users u
  INNER JOIN orders o ON o.user_id = u.user_id
  WHERE EXISTS (SELECT 1 FROM refunds r WHERE r.order_id = o.order_id)
ORDER BY 1`,
});

// ---------------------------------------------------------------------------
// 8. 極端に長い / 特殊な形
// ---------------------------------------------------------------------------
add({
  name: '20 テーブル連鎖 JOIN',
  want: { tables: 20, joins: 19 },
  sql: `SELECT t0.id FROM t0 ${Array.from(
    { length: 19 },
    (_, i) => `INNER JOIN t${i + 1} ON t${i + 1}.id = t${i}.id`,
  ).join(' ')} WHERE t0.flg = 1`,
});

add({
  name: '選択列 100 個',
  sql: `SELECT ${Array.from({ length: 100 }, (_, i) => `c${i}`).join(', ')} FROM t`,
});

add({
  name: 'スカラー副問合せを 5 個並べた SELECT リスト',
  sql: `SELECT d.dept_no,
  (SELECT COUNT(*) FROM employees e WHERE e.dept_no = d.dept_no) c1,
  (SELECT MAX(sal) FROM employees e WHERE e.dept_no = d.dept_no) c2,
  (SELECT MIN(sal) FROM employees e WHERE e.dept_no = d.dept_no) c3,
  (SELECT AVG(sal) FROM employees e WHERE e.dept_no = d.dept_no) c4,
  (SELECT SUM(sal) FROM employees e WHERE e.dept_no = d.dept_no) c5
FROM departments d`,
});

add({
  name: 'ヒント + 引用識別子 + 代替引用符 + DB リンク + (+) の全部入り',
  sql: `SELECT /*+ LEADING(e d) USE_NL(d) INDEX(e emp_idx) */
       e."Emp No", d."Dept Name", NVL(b.bonus, 0) bonus
FROM "Employee Master"@prod_link e, departments d, bonuses b
WHERE e.dept_no = d.dept_no
  AND e."Emp No" = b.emp_no(+)
  AND e.note != q'[it's fine]'
  AND e.serial# > 0
ORDER BY d."Dept Name" NULLS LAST
FETCH FIRST 10 PERCENT ROWS WITH TIES`,
});

// ---------------------------------------------------------------------------
// 9. 作りは悪いが Oracle では動く SQL
// ---------------------------------------------------------------------------
add({
  name: '悪い: 整形なし・1 行詰め込み・大文字小文字バラバラ',
  sql: `select E.EMP_NO,e.emp_name,D.dept_name,nvl(B.BONUS,0) from EMPLOYEES E,departments d,BONUSES b where E.DEPT_NO=d.DEPT_NO and e.EMP_NO=B.emp_no(+) and E.SAL>1000 and D.ACTIVE_FLG=1 order by 1,2`,
});

add({
  name: '悪い: WHERE 1=1 とぶら下げ AND',
  sql: `SELECT *
  FROM employees e
 WHERE 1 = 1
   AND 1 = 1
   AND e.dept_no = 10
   AND ('X' = 'X')
   AND e.sal > 0`,
});

add({
  name: '悪い: 無意味な括弧の多重ネスト',
  sql: `SELECT ((((a)))) AS a, (((b + c))) AS bc
  FROM t
 WHERE ((((((status = 1)))))) AND (((type = 2) AND ((flg = 3))))`,
});

add({
  name: '悪い: エイリアスを付けず全部テーブル名で修飾',
  sql: `SELECT employees.emp_no, employees.emp_name, departments.dept_name
  FROM employees, departments
 WHERE employees.dept_no = departments.dept_no
   AND employees.sal > (SELECT AVG(employees.sal) FROM employees)`,
});

add({
  name: '悪い: IN の代わりに OR を 12 個並べる',
  sql: `SELECT id FROM t
 WHERE cd = '01' OR cd = '02' OR cd = '03' OR cd = '04' OR cd = '05' OR cd = '06'
    OR cd = '07' OR cd = '08' OR cd = '09' OR cd = '10' OR cd = '11' OR cd = '12'`,
});

add({
  name: '悪い: 同じスカラー副問合せを 4 回書く',
  sql: `SELECT d.dept_no,
       (SELECT COUNT(*) FROM employees e WHERE e.dept_no = d.dept_no) cnt,
       (SELECT COUNT(*) FROM employees e WHERE e.dept_no = d.dept_no) / 2 half,
       CASE WHEN (SELECT COUNT(*) FROM employees e WHERE e.dept_no = d.dept_no) > 10 THEN 'BIG' ELSE 'SMALL' END sz
  FROM departments d
 WHERE (SELECT COUNT(*) FROM employees e WHERE e.dept_no = d.dept_no) > 0`,
});

add({
  name: '悪い: 結合条件の欠落で直積になる',
  want: { tables: 3, joins: 2 },
  sql: `SELECT e.emp_no, d.dept_name, g.grade_name
  FROM employees e, departments d, grades g
 WHERE e.dept_no = d.dept_no
   AND e.sal > 1000`,
});

add({
  name: '悪い: 索引が効かない NVL / 関数付き結合条件',
  sql: `SELECT a.id
  FROM t_a a, t_b b
 WHERE NVL(a.key_cd, '0') = NVL(b.key_cd, '0')
   AND TO_CHAR(a.created_at, 'YYYYMMDD') = TO_CHAR(b.created_at, 'YYYYMMDD')
   AND UPPER(TRIM(a.name)) = UPPER(TRIM(b.name))`,
});

add({
  name: '悪い: 暗黙の型変換（数値列に文字列リテラル）',
  sql: `SELECT * FROM employees WHERE emp_no = '1001' AND dept_no = '10' AND hired_at > '2020-01-01'`,
});

add({
  name: '悪い: 意味のない DISTINCT と GROUP BY の併用',
  sql: `SELECT DISTINCT e.dept_no, COUNT(*) cnt
  FROM employees e
 GROUP BY e.dept_no
 ORDER BY 2 DESC, 1 ASC`,
});

add({
  name: '悪い: 副問合せで済むものを 3 重ネストのインラインビューで書く',
  sql: `SELECT x.emp_no FROM (
  SELECT y.emp_no FROM (
    SELECT z.emp_no FROM (
      SELECT emp_no FROM employees
    ) z
  ) y
) x
WHERE x.emp_no IN (SELECT emp_no FROM (SELECT emp_no FROM employees WHERE sal > 1000))`,
});

add({
  name: '悪い: UNION（重複排除が不要な場面）を 5 ブランチ',
  want: { branches: 5 },
  sql: `SELECT emp_no, '1' kind FROM t1
UNION
SELECT emp_no, '2' FROM t2
UNION
SELECT emp_no, '3' FROM t3
UNION
SELECT emp_no, '4' FROM t4
UNION
SELECT emp_no, '5' FROM t5`,
});

add({
  name: '悪い: コメントと空行だらけ・末尾セミコロン',
  sql: `-- 社員一覧
-- 作成: 2010/04/01
-- 修正: 2015/07/20  ★ 条件追加

SELECT   /* 社員番号 */ e.emp_no

       , e.emp_name   -- 氏名

  FROM   employees  e   -- 社員マスタ

 WHERE   e.retired_flg = 0   -- 0:在職 1:退職

   AND   e.dept_no    = 10   -- 営業部

 ORDER BY e.emp_no;`,
});

add({
  name: '悪い: 予約語っぽい別名・重複する列別名',
  sql: `SELECT e.emp_no AS "NO", e.emp_name AS name, d.dept_name AS name2, e.sal AS "VALUE"
  FROM employees e JOIN departments d ON d.dept_no = e.dept_no`,
});

add({
  name: '悪い: HAVING だけで GROUP BY なし',
  sql: `SELECT COUNT(*) FROM employees HAVING COUNT(*) > 0`,
});

add({
  name: '悪い: ORDER BY に列番号と式を混在',
  sql: `SELECT dept_no, SUM(sal) s, COUNT(*) c FROM employees GROUP BY dept_no ORDER BY 2 DESC, COUNT(*) ASC, 1`,
});

add({
  name: '悪い: 自己結合 3 回（別名 e1/e2/e3）',
  want: { tables: 3, joins: 2 },
  sql: `SELECT e1.emp_name, e2.emp_name mgr, e3.emp_name mgr2
  FROM employees e1, employees e2, employees e3
 WHERE e1.manager_no = e2.emp_no(+)
   AND e2.manager_no = e3.emp_no(+)`,
});

add({
  name: '悪い: NOT IN にサブクエリ（NULL で結果が消える定番の罠）',
  sql: `SELECT e.emp_no FROM employees e
 WHERE e.dept_no NOT IN (SELECT d.dept_no FROM departments d WHERE d.closed_flg = 1)
   AND e.manager_no NOT IN (SELECT m.emp_no FROM managers m)`,
});

add({
  name: '悪い: 文字列連結で条件を組む',
  sql: `SELECT * FROM t WHERE a || '-' || b = 'x-y' AND SUBSTR(cd, 1, 2) || SUBSTR(cd, 5, 2) = '0101'`,
});

add({
  name: '悪い: 極端に長い 1 行（改行なし）',
  sql: `SELECT a.c1,a.c2,a.c3,b.c1,b.c2,c.c1,c.c2,d.c1 FROM t_a a INNER JOIN t_b b ON b.id=a.id AND b.sub_id=a.sub_id AND b.flg=1 INNER JOIN t_c c ON c.id=b.id AND c.kbn='01' LEFT JOIN t_d d ON d.id=c.id WHERE a.del_flg=0 AND a.created_at>=TO_DATE('20240101','YYYYMMDD') AND (b.status='A' OR b.status='B' OR b.status='C') AND NVL(c.amount,0)>0 ORDER BY a.c1,a.c2,b.c1`,
});

add({
  name: '悪い: タブとスペースが混在した不揃いインデント',
  sql: "SELECT\te.emp_no,\n  \te.emp_name,\n\t  d.dept_name\nFROM\temployees e\n\tINNER JOIN departments d\n\t\tON\td.dept_no\t=\te.dept_no\nWHERE\te.sal\t>\t1000",
});

// ---------------------------------------------------------------------------
// 検証
// ---------------------------------------------------------------------------

function allQueries(query: ParsedQuery): ParsedQuery[] {
  const out: ParsedQuery[] = [query];
  for (const t of query.tables) if (t.derivedQuery) out.push(...allQueries(t.derivedQuery));
  for (const c of query.ctes ?? []) out.push(...allQueries(c.query));
  for (const b of query.unionBranches ?? []) out.push(...allQueries(b.query));
  const walk = (n: ConditionNode | undefined): void => {
    if (!n) return;
    if (n.nestedQuery) out.push(...allQueries(n.nestedQuery));
    for (const c of n.children ?? []) walk(c);
  };
  walk(query.where);
  walk(query.having);
  return out;
}

function collectSpans(query: ParsedQuery): Array<{ what: string; span: SourceSpan }> {
  const spans: Array<{ what: string; span: SourceSpan }> = [];
  const push = (what: string, span?: SourceSpan) => {
    if (span) spans.push({ what, span });
  };
  for (const q of allQueries(query)) {
    for (const t of q.tables) push(`table:${t.table}`, t.sourceSpan);
    for (const j of q.joins) push(`join:${j.condition.slice(0, 20)}`, j.sourceSpan);
    for (const c of q.columns) push(`col:${c.expression.slice(0, 20)}`, c.sourceSpan);
    for (const g of q.groupBy) push(`group:${g.text.slice(0, 15)}`, g.sourceSpan);
    for (const o of q.orderBy) push(`order:${o.text.slice(0, 15)}`, o.sourceSpan);
    push('rowLimit', q.rowLimitSpan);
    push('hint', q.hintSpan);
    push('hierarchical', q.hierarchical?.sourceSpan);
    const walk = (n: ConditionNode | undefined): void => {
      if (!n) return;
      push(`cond:${n.label.slice(0, 20)}`, n.sourceSpan);
      for (const c of n.children ?? []) walk(c);
    };
    walk(q.where);
    walk(q.having);
  }
  return spans;
}

function displayTexts(query: ParsedQuery): string[] {
  const texts: string[] = [];
  for (const q of allQueries(query)) {
    texts.push(
      ...q.columns.map((c) => c.expression),
      ...q.groupBy.map((g) => g.text),
      ...q.orderBy.map((o) => o.text),
      ...q.joins.map((j) => j.condition),
      ...(q.setClauses ?? []).map((s) => s.label),
      q.where?.label ?? '',
      q.having?.label ?? '',
    );
  }
  const effect = buildQueryEffect(query, 'japanese');
  for (const s of effect.sections) texts.push(...(s.lines ?? []).map((l) => l.text));
  texts.push(effect.summary, buildQueryEffect(query, 'sql').summary);
  return texts;
}

describe('複雑な SQL / 作りの悪い SQL', () => {
  it.each(CASES.map((c) => [c.name, c] as const))('%s', (_name, testCase) => {
    const { sql, want } = testCase;

    const started = Date.now();
    const result = parseOracleQuery(sql);
    const elapsed = Date.now() - started;

    expect(result.success, result.success ? '' : result.error.message).toBe(true);
    if (!result.success) return;
    const query = result.query;

    // 構造的不変条件（表示側が前提にしている形が崩れていないか）
    expect(() => assertParseInvariants(query, testCase.name)).not.toThrow();

    // 取りこぼしの検出
    if (want?.tables != null) expect(query.tables).toHaveLength(want.tables);
    if (want?.joins != null) expect(query.joins).toHaveLength(want.joins);
    if (want?.branches != null) expect(query.unionBranches ?? []).toHaveLength(want.branches);
    if (want?.ctes != null) expect(query.ctes ?? []).toHaveLength(want.ctes);
    if (want?.nested != null) {
      expect(collectAllNestedQueries(query).length).toBeGreaterThanOrEqual(want.nested);
    }

    // 位置情報が元 SQL の範囲に収まり、潰れていないか
    for (const { what, span } of collectSpans(query)) {
      expect(span.start, what).toBeGreaterThanOrEqual(0);
      expect(span.end, what).toBeLessThanOrEqual(sql.length);
      expect(span.end, what).toBeGreaterThan(span.start);
    }

    // 表示テキストへ内部データが漏れていないか
    const texts = displayTexts(query).join(' | ');
    expect(texts).not.toMatch(/"type"|tableList|columnList|\[object Object\]/);
    expect(texts).not.toMatch(/WHEN\s+THEN/);

    // 後続処理（エイリアス解決・JOIN 図レイアウト）が落ちないか
    expect(() => {
      const resolved = applyAliasResolution(query, true, { keepSelfJoinAliases: true });
      buildJoinFlowLayout(resolved.tables, resolved.joins, true, resolved);
    }).not.toThrow();

    // 解析が現実的な時間で終わるか（入力のたびに走るため）
    expect(elapsed).toBeLessThan(500);
  });
});
