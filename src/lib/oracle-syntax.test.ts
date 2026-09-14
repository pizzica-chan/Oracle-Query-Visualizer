import { describe, expect, it } from 'vitest';
import { parseOracleQuery, HIERARCHICAL_SAMPLE_SQL } from './parser';
import { buildQueryEffect } from './query-effect';
import { tableNames } from './fixtures/sql-cases';

function expectParseOk(sql: string) {
  const result = parseOracleQuery(sql);
  expect(result.success, result.success ? '' : result.error.message).toBe(true);
  return result;
}

function effectText(sql: string): string {
  const result = expectParseOk(sql);
  if (!result.success) return '';
  return buildQueryEffect(result.query, 'japanese')
    .sections.flatMap((section) => section.lines ?? [])
    .map((line) => line.text)
    .join('\n');
}

describe('Oracle 固有構文の前処理', () => {
  describe('オプティマイザヒント', () => {
    it('SELECT 直後のヒントを取り出す', () => {
      const result = expectParseOk('SELECT /*+ FULL(e) */ e.id FROM emp e');
      if (!result.success) return;
      expect(result.query.hints).toHaveLength(1);
      expect(result.query.hints?.[0]?.text).toBe('FULL(e)');
    });

    it('ヒントの span が元 SQL のヒントコメント全体を指す', () => {
      const sql = 'SELECT /*+ FULL(e) */ e.id FROM emp e';
      const result = expectParseOk(sql);
      if (!result.success) return;
      const span = result.query.hints?.[0]?.sourceSpan;
      expect(span).toBeDefined();
      expect(sql.slice(span!.start, span!.end)).toBe('/*+ FULL(e) */');
    });

    it('複数のヒントをすべて拾う', () => {
      const result = expectParseOk(
        'SELECT /*+ ORDERED */ /*+ USE_NL(o) */ u.id FROM users u JOIN orders o ON o.uid = u.id',
      );
      if (!result.success) return;
      expect(result.query.hints).toHaveLength(2);
    });

    it('サブクエリのヒントは内側のクエリに割り当てる', () => {
      const result = expectParseOk(
        'SELECT x.id FROM (SELECT /*+ FULL(t) */ id FROM t) x',
      );
      if (!result.success) return;
      expect(result.query.hints).toBeUndefined();
      const inner = result.query.tables[0]?.derivedQuery;
      expect(inner?.hints?.[0]?.text).toBe('FULL(t)');
    });

    it('ヒントではない通常のブロックコメントは拾わない', () => {
      const result = expectParseOk('SELECT /* not a hint */ id FROM t');
      if (!result.success) return;
      expect(result.query.hints).toBeUndefined();
    });

    it('作用説明でヒントは結果集合を変えないと明示する', () => {
      const text = effectText('SELECT /*+ ORDERED */ u.id FROM users u JOIN orders o ON o.uid = u.id');
      expect(text).toContain('ヒント');
      expect(text).toContain('結果集合は変わらない');
    });

    it('文字列リテラル内の /*+ はヒントとして扱わない', () => {
      const result = expectParseOk("SELECT id FROM t WHERE note = '/*+ FULL(t) */'");
      if (!result.success) return;
      expect(result.query.hints).toBeUndefined();
    });
  });

  describe('階層問い合わせ', () => {
    it('START WITH と CONNECT BY を取り出す', () => {
      const result = expectParseOk(
        'SELECT emp_no FROM emp START WITH mgr_no IS NULL CONNECT BY PRIOR emp_no = mgr_no',
      );
      if (!result.success) return;
      expect(result.query.hierarchical?.startWith).toBe('mgr_no IS NULL');
      expect(result.query.hierarchical?.connectBy).toBe('PRIOR emp_no = mgr_no');
    });

    it('階層句を取り除いても WHERE / ORDER BY は残る', () => {
      const result = expectParseOk(`SELECT emp_no
FROM emp
WHERE retired_flg = 0
START WITH mgr_no IS NULL
CONNECT BY PRIOR emp_no = mgr_no
ORDER BY emp_no`);
      if (!result.success) return;
      expect(result.query.where).toBeDefined();
      expect(result.query.orderBy).toHaveLength(1);
    });

    it('NOCYCLE を記録する', () => {
      const result = expectParseOk('SELECT emp_no FROM emp CONNECT BY NOCYCLE PRIOR emp_no = mgr_no');
      if (!result.success) return;
      expect(result.query.hierarchical?.noCycle).toBe(true);
    });

    it('階層句の span が元 SQL の該当範囲を指す', () => {
      const sql = 'SELECT emp_no FROM emp START WITH mgr_no IS NULL CONNECT BY PRIOR emp_no = mgr_no';
      const result = expectParseOk(sql);
      if (!result.success) return;
      const span = result.query.hierarchical?.sourceSpan;
      expect(span).toBeDefined();
      expect(sql.slice(span!.start, span!.end)).toBe(
        'START WITH mgr_no IS NULL CONNECT BY PRIOR emp_no = mgr_no',
      );
    });

    it('作用説明に階層問い合わせの節を出す', () => {
      const text = effectText(HIERARCHICAL_SAMPLE_SQL);
      expect(text).toContain('階層の起点');
      expect(text).toContain('階層の親子関係');
      expect(text).toContain('NOCYCLE');
    });

    it('SYS_CONNECT_BY_PATH は関数として扱い階層句と誤認しない', () => {
      const result = expectParseOk(
        "SELECT SYS_CONNECT_BY_PATH(emp_name, '/') AS path FROM emp CONNECT BY PRIOR emp_no = mgr_no",
      );
      if (!result.success) return;
      expect(result.query.columns[0]?.alias).toBe('path');
      expect(result.query.hierarchical?.connectBy).toBe('PRIOR emp_no = mgr_no');
    });
  });

  describe('引用識別子と文字列リテラル', () => {
    it('"..." は識別子として扱う（文字列ではない）', () => {
      const result = expectParseOk('SELECT "Col" FROM "Tab" t WHERE t."Col" = 1');
      if (!result.success) return;
      expect(tableNames(result.query)[0]).toBe('Tab');
      expect(result.query.columns[0]?.expression).toBe('Col');
    });

    it('引用識別子の大文字小文字を保持する', () => {
      const result = expectParseOk('SELECT * FROM "MixedCase"');
      if (!result.success) return;
      expect(tableNames(result.query)[0]).toBe('MixedCase');
    });

    it("''  で埋め込んだ単一引用符を文字列の一部として扱う", () => {
      const result = expectParseOk("SELECT id FROM t WHERE name = 'O''Brien'");
      if (!result.success) return;
      expect(result.query.where?.right).toContain("O''Brien");
    });

    it('バックスラッシュはエスケープではない（Oracle の文字列規則）', () => {
      const result = expectParseOk("SELECT id FROM t WHERE path = 'C:\\temp\\' AND flag = 1");
      if (!result.success) return;
      expect(result.query.where?.type).toBe('and');
    });

    it('代替引用符 q\'[...]\' を文字列として読む', () => {
      const result = expectParseOk("SELECT id FROM t WHERE note = q'[it's here]'");
      if (!result.success) return;
      expect(result.query.where?.right).toContain("it''s here");
    });

    it('代替引用符の中の予約語は構文として解釈しない', () => {
      const result = expectParseOk("SELECT id FROM t WHERE note = q'{CONNECT BY x = y}'");
      if (!result.success) return;
      expect(result.query.hierarchical).toBeUndefined();
    });
  });

  describe('行制限句', () => {
    it('FETCH FIRST n ROWS ONLY', () => {
      const result = expectParseOk('SELECT id FROM t FETCH FIRST 10 ROWS ONLY');
      if (!result.success) return;
      expect(result.query.limit).toBe('10');
    });

    it('FETCH FIRST ROW ONLY（件数省略は 1 行）', () => {
      const result = expectParseOk('SELECT id FROM t FETCH FIRST ROW ONLY');
      if (!result.success) return;
      expect(result.query.rowLimitSpan).toBeDefined();
    });

    it('サブクエリの行制限句は内側のクエリに割り当てる', () => {
      const result = expectParseOk(
        'SELECT x.id FROM (SELECT id FROM t ORDER BY id FETCH FIRST 5 ROWS ONLY) x',
      );
      if (!result.success) return;
      expect(result.query.limit).toBeUndefined();
      expect(result.query.tables[0]?.derivedQuery?.limit).toBe('5');
    });

    it('集合演算の後ろの行制限句は文全体に効く', () => {
      const result = expectParseOk(
        'SELECT id FROM a UNION ALL SELECT id FROM b ORDER BY id FETCH FIRST 3 ROWS ONLY',
      );
      if (!result.success) return;
      expect(result.query.limit).toBe('3');
      expect(result.query.orderBy).toHaveLength(1);
    });

    it('作用説明に Oracle の行制限句として出す', () => {
      const text = effectText('SELECT id FROM t ORDER BY id OFFSET 5 ROWS FETCH NEXT 10 ROWS ONLY');
      expect(text).toContain('5 行');
      expect(text).toContain('10 行');
    });
  });

  describe('その他の Oracle 構文', () => {
    it('MINUS / INTERSECT を集合演算子として読む', () => {
      const result = expectParseOk('SELECT id FROM a MINUS SELECT id FROM b');
      if (!result.success) return;
      expect(result.query.unionBranches?.[1]?.operator).toBe('MINUS');
    });

    it('SELECT UNIQUE を DISTINCT として読む', () => {
      const result = expectParseOk('SELECT UNIQUE dept_no FROM emp');
      if (!result.success) return;
      expect(result.query.distinct).toBe(true);
    });

    it('DUAL を 1 行のダミー表として扱う', () => {
      const result = expectParseOk('SELECT SYSDATE FROM dual');
      if (!result.success) return;
      expect(tableNames(result.query)[0]).toBe('dual');
      expect(result.query.tables[0]?.displayName).toContain('dual');
    });

    it('DELETE の FROM 省略形を解析する', () => {
      const result = expectParseOk("DELETE emp WHERE status = 'X'");
      if (!result.success) return;
      expect(result.query.statementType).toBe('DELETE');
      expect(tableNames(result.query)[0]).toBe('emp');
    });

    it('ORDER BY の NULLS FIRST / LAST を表示テキストに残す', () => {
      const result = expectParseOk('SELECT id FROM t ORDER BY comm NULLS FIRST');
      if (!result.success) return;
      expect(result.query.orderBy[0]?.text).toContain('NULLS FIRST');
    });

    it('CAST の Oracle 型を解析できる', () => {
      const result = expectParseOk('SELECT CAST(sal AS NUMBER(10,2)) AS s FROM emp');
      if (!result.success) return;
      expect(result.query.columns[0]?.alias).toBe('s');
    });

    it('`#` を含む識別子を落とさない（パーサの行コメント扱いを防ぐ）', () => {
      const result = expectParseOk('SELECT emp# FROM tab#x WHERE dept# = 1');
      if (!result.success) return;
      expect(result.query.columns[0]?.expression).toBe('emp#');
      expect(tableNames(result.query)[0]).toBe('tab#x');
      expect(result.query.where?.left).toBe('dept#');
    });

    it('`$` を含む識別子（V$ ビューなど）を解析できる', () => {
      const result = expectParseOk('SELECT sid, serial# FROM v$session WHERE user$ = 1');
      if (!result.success) return;
      expect(result.query.columns.map((c) => c.expression)).toEqual(['sid', 'serial#']);
      expect(tableNames(result.query)[0]).toBe('v$session');
      expect(result.query.where?.left).toBe('user$');
    });

    it('文字列やコメントの中の `#` は識別子として扱わない', () => {
      const result = expectParseOk("SELECT a FROM t WHERE note = 'a#b' AND x = 1");
      if (!result.success) return;
      expect(result.query.where?.type).toBe('and');
      expect(tableNames(result.query)[0]).toBe('t');
    });

    it('`--` の直後に空白が無い行コメントもコメントとして扱う', () => {
      const result = expectParseOk('SELECT id FROM t --コメント\nWHERE id = 1');
      if (!result.success) return;
      expect(result.query.where).toBeDefined();
    });
  });
});
