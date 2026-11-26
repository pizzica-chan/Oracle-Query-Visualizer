import { describe, expect, it } from 'vitest';
import { lineColumnAt, parseOracleQuery } from './parser';

function errorOf(sql: string) {
  const result = parseOracleQuery(sql);
  if (result.success) throw new Error(`解析に成功してしまった: ${sql}`);
  return result.error;
}

describe('構文エラーの位置', () => {
  it('エラーの範囲を入力 SQL 上のオフセットで返し、メッセージに行と列を入れる', () => {
    const sql = 'SELECT a,\n FROM t';
    const error = errorOf(sql);
    expect(error.span).toBeDefined();
    // 「a,」の後ろに列が無く、FROM の位置で解釈できなくなる
    expect(sql.slice(error.span!.start, error.span!.end).trim().length).toBeGreaterThan(0);
    const { line, column } = lineColumnAt(sql, error.span!.start);
    expect(error.message).toContain(`${line} 行 ${column} 列`);
    expect(error.position).toBe(error.span!.start);
  });

  it('先頭に空行や字下げがあっても、位置が手前にずれない', () => {
    const body = 'SELECT a FROM t WHERE x = = 1';
    const plain = errorOf(body);
    const indented = errorOf(`\n\n    ${body}`);
    expect(indented.span!.start - plain.span!.start).toBe(6);
  });

  it('文の途中で入力が終わったときは、最後の空白でない 1 文字を範囲にする', () => {
    // WHERE で終わる形は、条件の書き忘れとして別の文を返すので、比較演算子で終わる形で確かめる
    const sql = 'SELECT a FROM t WHERE a =   \n';
    const error = errorOf(sql);
    const contentEnd = sql.trimEnd().length;
    expect(error.span).toEqual({ start: contentEnd - 1, end: contentEnd });
  });

  it('前処理で取り除く構文（(+)・ヒント・FETCH FIRST）の後ろのエラーも、元の SQL の位置に戻す', () => {
    const sql = "SELECT /*+ INDEX(t) */ a FROM t, u WHERE t.id = u.id(+) AND q'[x]' = ) FETCH FIRST 1 ROWS ONLY";
    const error = errorOf(sql);
    expect(sql.slice(error.span!.start, error.span!.end)).toBe(')');
  });

  it('文種の誤りなど、位置を持たないエラーは範囲を返さない', () => {
    const error = errorOf('INSERT INTO t VALUES (1)');
    expect(error.span).toBeUndefined();
  });
});

describe('構文エラーの文', () => {
  it('期待していた字句の一覧は文に入れず、詳細に分ける', () => {
    const error = errorOf('SELECT a,, b FROM t');
    expect(error.message).toBe('1 行 10 列の「,」で構文を解釈できません');
    expect(error.detail).toMatch(/^Expected .* but "," found\.$/s);
  });

  it('入力の途中で終わったときは、そのことを書く', () => {
    const error = errorOf('SELECT * FROM t WHERE a =');
    expect(error.message).toBe('1 行 25 列で構文を解釈できません（SQL が途中で終わっています）');
    expect(error.detail).toContain('end of input');
  });

  it('語の先頭で解釈できなくなったときは、1 文字ではなく語全体を示す', () => {
    // 前処理で引用した日本語の識別子でも、元の SQL の語を示す
    const japanese = 'SELECT a FROM t WHERE x = 1 テスト列 = 2';
    const japaneseError = errorOf(japanese);
    expect(japaneseError.message).toBe('1 行 29 列の「テスト列」で構文を解釈できません');
    expect(japanese.slice(japaneseError.span!.start, japaneseError.span!.end)).toBe('テスト列');
  });

  it('語でない文字（記号）は 1 文字のまま示す', () => {
    expect(errorOf('SELECT a,, b FROM t').span).toEqual({ start: 9, end: 10 });
  });

  it('予約語を別名の位置に書いたときの英語の文を、日本語にする', () => {
    const error = errorOf('SELECT t.a AS select FROM t');
    expect(error.message).toBe(
      '「select」はこの解析では予約語として扱うので、そのままでは別名に使えません。別名にするなら二重引用符（"）で囲んでください',
    );
    // パーサーのエラーは位置を持たないので、`AS 予約語` を探してエディタで示す
    const sql = "SELECT a FROM t WHERE s = 'x AS order' AND b IN (SELECT c FROM u AS order)";
    const located = errorOf(sql);
    const start = sql.lastIndexOf('order');
    expect(located.span).toEqual({ start, end: start + 5 });
  });

  // パーサーは SQL の末尾や、原因より後ろの語を指す。原因の位置を示さないと、どこを直せばよいか分からない
  it.each([
    ["SELECT a FROM t WHERE s = 'abc", "1 行 27 列の「'」で始まる文字列が閉じていません", "'"],
    ["SELECT a FROM t WHERE s = q'[abc", "1 行 27 列の「q'[」で始まる文字列（代替引用符）が閉じていません", "q'["],
    ['SELECT t."A FROM t', '1 行 10 列の「"」で始まる引用識別子が閉じていません', '"'],
    ['SELECT a FROM t\nWHERE a = 1 /* 未完', '2 行 13 列の「/*」で始まるコメントが閉じていません', '/*'],
    [
      'SELECT a FROM t　WHERE a = 1',
      '1 行 16 列に全角の空白があります。この解析では全角の空白を語の区切りとして読めず、前後の語とつながった名前として扱います。半角の空白にしてください',
      '　',
    ],
    ['SELECT a，b FROM t', '1 行 9 列の「，」は全角の文字です。SQL の記号は半角（「,」）で書いてください', '，'],
  ])('原因を示す: %s', (sql, message, marked) => {
    const error = errorOf(sql);
    expect(error.message).toBe(message);
    expect(sql.slice(error.span!.start, error.span!.end)).toBe(marked);
  });

  it('文字列の中の全角の空白と、閉じた文字列・代替引用符の中の引用符は原因にしない', () => {
    const sql = "SELECT a FROM t WHERE s = 'あ　い' AND t = 'it''s' AND u = q'[it's]' AND v =";
    expect(errorOf(sql).message).toContain('SQL が途中で終わっています');
  });

  it('SQL ケース集の構文エラーは、どれも短い文になる', async () => {
    const { SQL_TEST_CASES } = await import('./fixtures/sql-cases');
    let checked = 0;
    for (const { sql } of SQL_TEST_CASES) {
      const result = parseOracleQuery(sql);
      if (result.success || !result.error.span) continue;
      checked += 1;
      expect(result.error.message, sql).not.toContain('Expected');
      expect(result.error.message.length, sql).toBeLessThan(80);
    }
    expect(checked).toBeGreaterThan(0);
  });
});

describe('lineColumnAt', () => {
  it('1 始まりの行と列を返す', () => {
    expect(lineColumnAt('abc\ndef', 0)).toEqual({ line: 1, column: 1 });
    expect(lineColumnAt('abc\ndef', 5)).toEqual({ line: 2, column: 2 });
  });
});

describe('書き忘れの原因が分かるエラー', () => {
  it.each([
    ['SELECT a.x FROM a WHERE (a.x = 1', '1 行 25 列の「(」が閉じていません', '('],
    ['SELECT a.x FROM a WHERE a.x = 1)', '1 行 32 列の「)」に対応する「(」がありません', ')'],
    ['SELECT a.x FROM a WHERE AND a.y = 1', '1 行 19 列の「WHERE」の後ろに条件がありません', 'WHERE'],
    ['SELECT a.x FROM a WHERE a.x = 1 AND', '1 行 33 列の「AND」の後ろに条件がありません', 'AND'],
    ['SELECT a.x FROM a JOIN b ON WHERE a.id = 1', '1 行 26 列の「ON」の後ろに条件がありません', 'ON'],
    ['SELECT a.x, COUNT(*) FROM a GROUP BY a.x,', '1 行 41 列の「,」の後ろに項目がありません。余分な「,」を消してください', ','],
    ['SELECT a.x FROM WHERE a.x = 1', '1 行 12 列の「FROM」の後ろにテーブルがありません', 'FROM'],
    ['SELECT a.x FROM a WHERE a.x IN ()', '1 行 29 列の「IN ( )」の括弧の中に値がありません', 'IN ()'],
    ['UPDATE a SET WHERE a.x = 1', '1 行 10 列の「SET」の後ろに、更新する列と値がありません', 'SET'],
    ['SELECT a.x FROM a WHERE a.x = 1 GROUP a.x', '1 行 33 列の「GROUP」の後ろに BY がありません', 'GROUP'],
  ])('%s', (sql, message, spanText) => {
    const error = errorOf(sql);
    expect(error.message).toBe(message);
    expect(sql.slice(error.span!.start, error.span!.end)).toBe(spanText);
  });

  it('エラーの位置から離れた書き方は、原因にしない', () => {
    // GROUP BY の「,」はエラーの位置（末尾の =）から離れているので、原因にしない
    expect(errorOf('SELECT a.x FROM a GROUP BY a.x, a.y HAVING a.x =').message).toContain('SQL が途中で終わっています');
  });
});
