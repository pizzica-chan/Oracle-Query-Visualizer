import { describe, expect, it } from 'vitest';
import { highlightSqlToHtml, tokenizeSql } from './sql-highlight';

function kinds(sql: string) {
  return tokenizeSql(sql).filter((t) => t.kind !== 'plain');
}

describe('sql-highlight', () => {
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
