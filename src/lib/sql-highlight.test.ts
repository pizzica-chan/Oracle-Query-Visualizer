import { describe, expect, it } from 'vitest';
import { highlightSqlToHtml, highlightSqlToLineHtml, tokenizeSql } from './sql-highlight';

function kinds(sql: string) {
  return tokenizeSql(sql).filter((t) => t.kind !== 'plain');
}

describe('sql-highlight', () => {
  it('別名や列名の中の数字は数値の色にしない（u1、order2、t.1st）', () => {
    const tokens = kinds('SELECT u1.id, t.1st, order2 FROM users u1, t WHERE u1.total > 10 AND x = .5 AND y = 1.5e3');
    expect(tokens.filter((t) => t.kind === 'number').map((t) => t.text)).toEqual(['10', '.5', '1.5e3']);
  });

  it('日本語の識別子と、# や $ を含む識別子の数字は数値の色にしない', () => {
    const tokens = kinds('SELECT テーブル1.列2, emp#1, x$2 FROM テーブル1 WHERE 列2 > 3');
    expect(tokens.filter((t) => t.kind === 'number').map((t) => t.text)).toEqual(['3']);
  });

  it("N'…' は接頭辞も含めて 1 つの文字列として色分けする", () => {
    const tokens = kinds("SELECT N'abc', nq'[x]', 'y' FROM dual");
    expect(tokens.filter((t) => t.kind === 'string').map((t) => t.text)).toEqual(["N'abc'", "nq'[x]'", "'y'"]);
  });

  it('日本語の文字が続く語や、語の途中のキーワードはキーワードにしない（SELECT日付、selection、u_on）', () => {
    const tokens = kinds('SELECT SELECT日付, selection, u_on FROM t');
    expect(tokens.filter((t) => t.kind === 'keyword').map((t) => t.text)).toEqual(['SELECT', 'FROM']);
  });

  it('長い SQL でも短い時間で色分けする（文字ごとに正規表現を作り直さない）', () => {
    const sql = Array.from(
      { length: 1500 },
      (_, i) => `SELECT u${i}.id, u${i}.name FROM users u${i} JOIN orders o${i} ON o${i}.user_id = u${i}.id WHERE o${i}.total > ${i}`,
    ).join('\nUNION ALL\n');
    const started = performance.now();
    const restored = tokenizeSql(sql).map((t) => t.text).join('');
    const elapsed = performance.now() - started;
    expect(restored).toBe(sql);
    // 直す前は 1 秒を超えていた。遅い CI でも通るよう、余裕を持たせる
    expect(elapsed).toBeLessThan(400);
  });

  it('行ごとの HTML は行数と一致し、行をまたぐコメントは行の境目で span を閉じて開き直す', () => {
    const sql = 'SELECT a /* 1\n2 */\nFROM t';
    const lines = highlightSqlToLineHtml(sql);
    expect(lines).toHaveLength(3);
    expect(lines[0]).toContain('<span class="sql-hl--comment">/* 1</span>');
    expect(lines[1]).toBe('<span class="sql-hl--comment">2 */</span>');
  });

  it('構文エラーの範囲に印を付ける', () => {
    const html = highlightSqlToHtml('SELECT a,, b', undefined, { start: 9, end: 10 });
    expect(html).toContain('<span class="sql-hl--error">,</span>');
  });

  it('SELECT / JOIN キーワードをハイライトする', () => {
    const tokens = kinds('SELECT u.id FROM users u INNER JOIN orders o ON o.user_id = u.id');
    expect(tokens.some((t) => t.kind === 'keyword' && t.text.toUpperCase() === 'SELECT')).toBe(true);
    expect(tokens.some((t) => t.kind === 'keyword' && t.text.toUpperCase() === 'INNER JOIN')).toBe(true);
    expect(tokens.some((t) => t.kind === 'keyword' && t.text.toUpperCase() === 'FROM')).toBe(true);
  });

  it('旧式外部結合演算子 (+) を演算子としてハイライトする', () => {
    const tokens = kinds('SELECT * FROM a, b WHERE a.id = b.id(+)');
    expect(tokens.some((t) => t.kind === 'operator' && t.text === '(+)')).toBe(true);
  });

  it('Oracle の階層問い合わせキーワードをハイライトする', () => {
    const tokens = kinds('SELECT id FROM t START WITH p IS NULL CONNECT BY PRIOR id = p');
    for (const keyword of ['START WITH', 'CONNECT BY', 'PRIOR']) {
      expect(
        tokens.some((t) => t.kind === 'keyword' && t.text.toUpperCase() === keyword),
        keyword,
      ).toBe(true);
    }
  });

  it('Oracle の行制限句・集合演算子をキーワードとしてハイライトする', () => {
    const tokens = kinds(
      'SELECT id FROM t MINUS SELECT id FROM u ORDER BY id NULLS LAST OFFSET 5 ROWS FETCH NEXT 10 ROWS ONLY',
    );
    for (const keyword of ['MINUS', 'NULLS LAST', 'OFFSET', 'FETCH NEXT', 'ROWS ONLY']) {
      expect(
        tokens.some((t) => t.kind === 'keyword' && t.text.toUpperCase() === keyword),
        keyword,
      ).toBe(true);
    }
  });

  it('ROWNUM / LEVEL / SYSDATE / DUAL をキーワードとしてハイライトする', () => {
    const tokens = kinds('SELECT LEVEL, SYSDATE FROM dual WHERE ROWNUM <= 1');
    for (const keyword of ['LEVEL', 'SYSDATE', 'DUAL', 'ROWNUM']) {
      expect(
        tokens.some((t) => t.kind === 'keyword' && t.text.toUpperCase() === keyword),
        keyword,
      ).toBe(true);
    }
  });

  it('ヒントコメント /*+ … */ をコメントとしてハイライトする', () => {
    const tokens = kinds('SELECT /*+ FULL(t) */ id FROM t JOIN u ON u.id = t.id');
    expect(tokens.some((t) => t.kind === 'comment' && t.text.includes('/*+ FULL(t) */'))).toBe(true);
    expect(tokens.some((t) => t.kind === 'keyword' && t.text.toUpperCase() === 'JOIN')).toBe(true);
  });

  it('文字列リテラルとコメントをハイライトする', () => {
    const tokens = kinds("WHERE name = 'O''Reilly' -- comment\n/* block */");
    expect(tokens.some((t) => t.kind === 'string' && t.text === "'O''Reilly'")).toBe(true);
    expect(tokens.some((t) => t.kind === 'comment' && t.text === '-- comment')).toBe(true);
    expect(tokens.some((t) => t.kind === 'comment' && t.text === '/* block */')).toBe(true);
  });

  it('空白なしの -- も Oracle ではコメント', () => {
    const tokens = tokenizeSql('SELECT a--b FROM t');
    expect(tokens.some((t) => t.kind === 'comment' && t.text === '--b FROM t')).toBe(true);
    expect(tokens.map((t) => t.text).join('')).toBe('SELECT a--b FROM t');
  });

  it('引用識別子 "..." は識別子として色分けする', () => {
    const tokens = tokenizeSql('SELECT "Col" FROM "Tab"');
    expect(tokens.filter((t) => t.kind === 'identifier').map((t) => t.text)).toEqual([
      '"Col"',
      '"Tab"',
    ]);
  });

  it("代替引用符は文字列として色分けする", () => {
    const tokens = tokenizeSql("SELECT id FROM t WHERE a = q'[it's]'");
    expect(tokens.some((t) => t.kind === 'string' && t.text === "q'[it's]'")).toBe(true);
  });

  it('>= などの演算子をリテラル表示する', () => {
    const tokens = kinds('WHERE amount >= 100 AND qty <= 5');
    expect(tokens.some((t) => t.kind === 'operator' && t.text === '>=')).toBe(true);
    expect(tokens.some((t) => t.kind === 'operator' && t.text === '<=')).toBe(true);
    expect(highlightSqlToHtml('>=')).toContain('&gt;=');
    expect(highlightSqlToHtml('>=')).not.toContain('≧');
  });

  it('HTML 特殊文字をエスケープする', () => {
    const html = highlightSqlToHtml("WHERE tag = '<script>'");
    expect(html).toContain('&lt;script&gt;');
    expect(html).not.toContain('<script>');
  });

  it('focusSpan で該当範囲に focus クラスを付ける', () => {
    const sql = 'SELECT id FROM users';
    const html = highlightSqlToHtml(sql, { start: 7, end: 9 });
    expect(html).toContain('sql-hl--focus">id</span>');
    expect(html).not.toContain('sql-hl--focus">SELECT');
  });

  it('focusSpan は plain トークン結合時も列単位で部分ハイライトする', () => {
    const sql = 'SELECT\n  u.id,\n  u.name,\n  u.email\nFROM users u';
    const nameStart = sql.indexOf('u.name');
    const nameEnd = nameStart + 'u.name'.length;
    const idHtml = highlightSqlToHtml(sql, { start: sql.indexOf('u.id'), end: sql.indexOf('u.id') + 'u.id'.length });
    const nameHtml = highlightSqlToHtml(sql, { start: nameStart, end: nameEnd });

    expect(idHtml.match(/sql-hl--focus/g)).toHaveLength(1);
    expect(idHtml).toContain('sql-hl--focus">u.id</span>');
    expect(idHtml).not.toMatch(/sql-hl--focus">[^<]*u\.name/);
    expect(nameHtml).toMatch(/sql-hl--focus">u\.name</);
    expect(nameHtml).not.toMatch(/sql-hl--focus">[^<]*u\.email/);
  });

  it('原文を欠落なく復元できる', () => {
    const sql = "SELECT * FROM t WHERE x >= 1 AND name = 'a''b' -- end";
    const restored = tokenizeSql(sql).map((t) => t.text).join('');
    expect(restored).toBe(sql);
  });
});
