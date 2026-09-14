import { describe, expect, it } from 'vitest';
import { findCodeRegions, preprocessSqlForParser, remapSourceSpan } from './sql-preprocess';

describe('sql-preprocess', () => {
  describe('code 領域の判定', () => {
    it('文字列リテラル内は code 領域に含めない', () => {
      const sql = "SELECT 'NOT A -- COMMENT' AS x, id FROM t";
      const regions = findCodeRegions(sql);
      expect(regions.some((r) => sql.slice(r.start, r.end).includes("'NOT A"))).toBe(false);
      expect(regions.some((r) => sql.slice(r.start, r.end).includes('FROM t'))).toBe(true);
    });

    it('引用識別子 "..." は code 領域に含めない', () => {
      const sql = 'SELECT "CONNECT BY" FROM t';
      const regions = findCodeRegions(sql);
      expect(regions.some((r) => sql.slice(r.start, r.end).includes('CONNECT BY'))).toBe(false);
    });

    it('Oracle の `--` は直後に空白が無くてもコメント', () => {
      const sql = 'SELECT a--comment\nFROM t';
      const regions = findCodeRegions(sql);
      expect(regions.some((r) => sql.slice(r.start, r.end).includes('comment'))).toBe(false);
    });
  });

  describe('位置対応表', () => {
    it('階層句を取り除いても processedToOriginal で元位置に戻せる', () => {
      const sql = 'SELECT id FROM t START WITH p IS NULL CONNECT BY PRIOR id = p';
      const { sql: processed, processedToOriginal } = preprocessSqlForParser(sql);
      const idPos = processed.indexOf('id');
      const span = remapSourceSpan(processedToOriginal, { start: idPos, end: idPos + 2 });
      expect(sql.slice(span!.start, span!.end)).toBe('id');
    });

    it('長さを変えない書き換えでは位置がずれない', () => {
      const sql = 'SELECT "Col" FROM "Tab" WHERE a = b(+)';
      const { sql: processed } = preprocessSqlForParser(sql);
      expect(processed).toHaveLength(sql.length);
    });
  });

  describe('NATURAL JOIN', () => {
    it('連続 NATURAL JOIN の開始位置を最終 SQL で補正する', () => {
      const sql = 'SELECT * FROM a_table NATURAL JOIN b_table NATURAL LEFT JOIN c_table';
      const pre = preprocessSqlForParser(sql);
      expect(pre.naturalJoinStarts).toContain(pre.sql.indexOf('INNER JOIN'));
      expect(pre.naturalJoinStarts).toContain(pre.sql.indexOf('LEFT JOIN'));
    });

    it('NATURAL JOIN 置換区間の span は元の NATURAL JOIN 全体に戻る', () => {
      const sql = 'SELECT * FROM a_table NATURAL JOIN b_table';
      const { sql: processed, processedToOriginal } = preprocessSqlForParser(sql);
      const innerJoinAt = processed.indexOf('INNER JOIN');
      expect(innerJoinAt).toBeGreaterThanOrEqual(0);
      const span = remapSourceSpan(processedToOriginal, {
        start: innerJoinAt,
        end: innerJoinAt + 'INNER JOIN'.length,
      });
      expect(sql.slice(span!.start, span!.end)).toBe('NATURAL JOIN');
    });

    it('行コメント内の NATURAL JOIN は置換しない', () => {
      const sql = 'SELECT * FROM a -- NATURAL JOIN b\nJOIN c ON c.id = a.id';
      const pre = preprocessSqlForParser(sql);
      expect(pre.sql).toContain('-- NATURAL JOIN b');
      expect(pre.naturalJoinStarts).toHaveLength(0);
    });
  });

  describe('旧式外部結合演算子 (+)', () => {
    it('(+) を取り除いて位置を記録する', () => {
      const sql = 'SELECT * FROM a, b WHERE a.id = b.id(+)';
      const pre = preprocessSqlForParser(sql);
      expect(pre.sql).not.toContain('(+)');
      expect(pre.outerJoinMarkers).toHaveLength(1);
      const span = pre.outerJoinMarkers[0]!.sourceSpan;
      expect(sql.slice(span.start, span.end)).toBe('(+)');
    });

    it('空白入りの ( + ) も演算子として拾う', () => {
      const pre = preprocessSqlForParser('SELECT * FROM a, b WHERE a.id = b.id ( + )');
      expect(pre.outerJoinMarkers).toHaveLength(1);
    });

    it('文字列リテラル内の (+) は拾わない', () => {
      const pre = preprocessSqlForParser("SELECT * FROM t WHERE note = '(+)'");
      expect(pre.outerJoinMarkers).toHaveLength(0);
    });
  });

  describe('階層問い合わせ句', () => {
    it('START WITH / CONNECT BY を取り除いて本文を記録する', () => {
      const sql = 'SELECT id FROM t START WITH p IS NULL CONNECT BY PRIOR id = p ORDER BY id';
      const pre = preprocessSqlForParser(sql);
      expect(pre.sql).not.toMatch(/CONNECT\s+BY/i);
      expect(pre.sql).toContain('ORDER BY id');
      expect(pre.hierarchicalClauses).toHaveLength(1);
      expect(pre.hierarchicalClauses[0]?.startWith).toBe('p IS NULL');
      expect(pre.hierarchicalClauses[0]?.connectBy).toBe('PRIOR id = p');
    });

    it('後続の句（WHERE より後ろの GROUP BY など）は残す', () => {
      const sql =
        'SELECT dept, COUNT(*) FROM t CONNECT BY PRIOR id = p GROUP BY dept HAVING COUNT(*) > 1';
      const pre = preprocessSqlForParser(sql);
      expect(pre.sql).toContain('GROUP BY dept');
      expect(pre.sql).toContain('HAVING COUNT(*) > 1');
    });

    it('サブクエリごとに別々の階層句として記録する', () => {
      const sql =
        'SELECT * FROM (SELECT id FROM a CONNECT BY PRIOR id = p) x, (SELECT id FROM b CONNECT BY PRIOR id = q) y';
      const pre = preprocessSqlForParser(sql);
      expect(pre.hierarchicalClauses).toHaveLength(2);
    });
  });

  describe('行制限句', () => {
    it('FETCH FIRST を取り除いて件数を記録する', () => {
      const sql = 'SELECT id FROM t ORDER BY id FETCH FIRST 10 ROWS ONLY';
      const pre = preprocessSqlForParser(sql);
      expect(pre.sql).not.toMatch(/FETCH/i);
      expect(pre.rowLimits).toHaveLength(1);
      expect(pre.rowLimits[0]?.count).toBe('10');
      expect(pre.rowLimits[0]?.offset).toBeUndefined();
    });

    it('OFFSET … ROWS FETCH NEXT … ROWS ONLY を 1 つの行制限句として記録する', () => {
      const pre = preprocessSqlForParser('SELECT id FROM t OFFSET 5 ROWS FETCH NEXT 10 ROWS ONLY');
      expect(pre.rowLimits).toHaveLength(1);
      expect(pre.rowLimits[0]?.offset).toBe('5');
      expect(pre.rowLimits[0]?.count).toBe('10');
    });

    it('PERCENT / WITH TIES を記録する', () => {
      const pre = preprocessSqlForParser('SELECT id FROM t FETCH FIRST 5 PERCENT ROWS WITH TIES');
      expect(pre.rowLimits[0]?.percent).toBe(true);
      expect(pre.rowLimits[0]?.withTies).toBe(true);
    });
  });

  describe('オプティマイザヒント', () => {
    it('ヒント本文を記録し、パーサには通常コメントとして渡す', () => {
      const sql = 'SELECT /*+ FULL(t) */ id FROM t';
      const pre = preprocessSqlForParser(sql);
      expect(pre.hints).toHaveLength(1);
      expect(pre.hints[0]?.text).toBe('FULL(t)');
      expect(pre.sql).not.toContain('/*+');
      expect(pre.sql).toContain('FULL(t)');
      expect(pre.sql).toHaveLength(sql.length);
    });

    it('ヒントでないブロックコメントは記録しない', () => {
      const pre = preprocessSqlForParser('SELECT /* memo */ id FROM t');
      expect(pre.hints).toHaveLength(0);
    });
  });

  describe('SELECT 修飾子とデータ型', () => {
    it('SELECT UNIQUE を DISTINCT にする', () => {
      expect(preprocessSqlForParser('SELECT UNIQUE id FROM t').sql).toBe(
        'SELECT DISTINCT id FROM t',
      );
    });

    it('列名の unique は書き換えない', () => {
      const sql = 'SELECT t.unique_flg FROM t WHERE t.unique_flg = 1';
      expect(preprocessSqlForParser(sql).sql).toBe(sql);
    });

    it('CAST の Oracle 型をパーサが解する型名にする', () => {
      const pre = preprocessSqlForParser('SELECT CAST(a AS NUMBER(10,2)) FROM t');
      expect(pre.sql).toContain('DECIMAL(10,2)');
    });

    it('列名の number は書き換えない', () => {
      const sql = 'SELECT number FROM t WHERE number > 1';
      expect(preprocessSqlForParser(sql).sql).toBe(sql);
    });

    it('WITHIN GROUP (…) を取り除く', () => {
      const pre = preprocessSqlForParser(
        "SELECT LISTAGG(a, ',') WITHIN GROUP (ORDER BY a) FROM t",
      );
      expect(pre.sql).not.toMatch(/WITHIN\s+GROUP/i);
      expect(pre.sql).toContain('LISTAGG');
    });

    it('DELETE の FROM 省略形に FROM を補う', () => {
      const pre = preprocessSqlForParser("DELETE users WHERE status = 'X'");
      expect(pre.sql).toMatch(/^DELETE\s+FROM\s+users\b/);
    });

    it('DELETE FROM はそのまま', () => {
      const sql = "DELETE FROM users WHERE status = 'X'";
      expect(preprocessSqlForParser(sql).sql).toBe(sql);
    });
  });

  describe('長さが変わる書き換えとの併用', () => {
    // 代替引用符の書き換えは長さが変わる。後続の句の除去範囲がずれないことを確かめる
    it('q-quote の後ろの (+) を正しく取り除く', () => {
      const pre = preprocessSqlForParser("SELECT * FROM a, b WHERE a.n = q'[xyz]' AND a.id = b.id(+)");
      expect(pre.sql).not.toContain('(+)');
      expect(pre.sql).toContain("'xyz'");
      expect(pre.outerJoinMarkers).toHaveLength(1);
    });

    it('q-quote の後ろの行制限句を正しく取り除く', () => {
      const pre = preprocessSqlForParser(
        "SELECT a FROM t WHERE n = q'[xyz]' ORDER BY a FETCH FIRST 5 ROWS ONLY",
      );
      expect(pre.sql).not.toMatch(/FETCH|ROWS|ONLY/i);
      expect(pre.rowLimits[0]?.count).toBe('5');
    });

    it('q-quote の後ろの NULLS LAST を正しく取り除く', () => {
      const pre = preprocessSqlForParser(
        "SELECT a FROM t WHERE n = q'[xyz]' ORDER BY a DESC NULLS LAST",
      );
      expect(pre.sql).not.toMatch(/NULLS/i);
      expect(pre.nullsOrders[0]?.position).toBe('LAST');
    });
  });

  describe('#・$ を含む識別子', () => {
    it('パーサが行コメントと誤読しないよう引用して渡す', () => {
      const pre = preprocessSqlForParser('SELECT emp# FROM t');
      expect(pre.sql).not.toMatch(/\semp# /);
      expect(pre.sql).toContain('emp#');
    });

    it('文字列リテラル内の # は書き換えない', () => {
      const sql = "SELECT a FROM t WHERE note = 'a#b'";
      expect(preprocessSqlForParser(sql).sql).toBe(sql);
    });

    it('特殊文字を含まない識別子は書き換えない', () => {
      const sql = 'SELECT a, b FROM t WHERE c = 1';
      expect(preprocessSqlForParser(sql).sql).toBe(sql);
    });
  });

  describe('引用識別子・代替引用符', () => {
    it('"Name" を同じ長さの識別子表記に置き換える', () => {
      const sql = 'SELECT "Col" FROM "Tab"';
      const pre = preprocessSqlForParser(sql);
      expect(pre.sql).toHaveLength(sql.length);
      expect(pre.sql).not.toContain('"');
    });

    it("q'[…]' を通常の文字列リテラルへ書き換える", () => {
      const pre = preprocessSqlForParser("SELECT id FROM t WHERE a = q'[it's]'");
      expect(pre.sql).toContain("'it''s'");
      expect(pre.sql).not.toContain("q'[");
    });

    it('文字列リテラル内のバックスラッシュを二重化する', () => {
      const pre = preprocessSqlForParser("SELECT id FROM t WHERE p = 'C:\\dir\\'");
      expect(pre.sql).toContain("'C:\\\\dir\\\\'");
    });
  });

  describe('ORDER BY の NULLS FIRST / LAST', () => {
    it('取り除いて位置と向きを記録する', () => {
      const sql = 'SELECT id FROM t ORDER BY a DESC NULLS LAST';
      const pre = preprocessSqlForParser(sql);
      expect(pre.sql).not.toMatch(/NULLS/i);
      expect(pre.nullsOrders).toHaveLength(1);
      expect(pre.nullsOrders[0]?.position).toBe('LAST');
      expect(sql.slice(pre.nullsOrders[0]!.sourceSpan.start, pre.nullsOrders[0]!.sourceSpan.end)).toBe(
        'NULLS LAST',
      );
    });
  });
});
