/** SQL 字句走査の共通ユーティリティ（ハイライト・前処理で共有） */

/**
 * 引用符なしの識別子に使える文字。Oracle はデータベースの文字セットの英数字と `_` `$` `#` を認める
 * （Oracle Database 23 SQL Language Reference「Database Object Names and Qualifiers」）。
 * 日本語の文字セットなら、カタカナや漢字も英数字に入る。ASCII だけで判定すると、`テーブル1` の 1 を数値の色にする
 */
const WORD_CHAR = /[\w$#\u0080-￿]/;

/** ch が引用符なしの識別子（またはキーワード）に使える文字か */
export function isWordChar(ch: string | undefined): boolean {
  return ch !== undefined && WORD_CHAR.test(ch);
}

/** 引用符なしで書ける名前（文字で始まり、文字・数字・`_`・`$`・`#` が続く） */
const PLAIN_IDENTIFIER_RE = /^[\p{L}_][\p{L}\p{N}\p{M}_$#]*$/u;

/**
 * 画面に出す名前。引用符なしで書けない名前（空白や記号を含む `"User Name"` など）は、二重引用符で囲む。
 * 引用符を外して出すと、`AS User Name` が別名 User に見えるなど、SQL として読めなくなる
 */
export function displayIdentifier(name: string): string {
  if (name === '*' || name === '' || PLAIN_IDENTIFIER_RE.test(name)) return name;
  return `"${name.replace(/"/g, '""')}"`;
}

export interface CodeRegion {
  start: number;
  end: number;
}

/**
 * Oracle の `--` 行コメントは、MySQL と違い直後の空白を要求しない。
 * `a--b` もコメント開始になる（Oracle では `-` の連続は演算子として解釈されない）。
 */
export function isLineCommentStart(text: string, pos: number): boolean {
  return text[pos] === '-' && text[pos + 1] === '-';
}

export function readLineCommentEnd(text: string, pos: number): number {
  let i = pos + 2;
  while (i < text.length && text[i] !== '\n') i += 1;
  return i;
}

export function readBlockCommentEnd(text: string, pos: number): number {
  let i = pos + 2;
  while (i < text.length - 1) {
    if (text[i] === '*' && text[i + 1] === '/') {
      return i + 2;
    }
    i += 1;
  }
  return text.length;
}

/** Oracle のヒント `/*+ ... *\/`（ブロックコメントのうち `+` で始まるもの） */
export function isHintCommentStart(text: string, pos: number): boolean {
  return text[pos] === '/' && text[pos + 1] === '*' && text[pos + 2] === '+';
}

/**
 * Oracle の文字列リテラルはバックスラッシュをエスケープとして扱わない。
 * 単一引用符の重ね書き `''` だけがエスケープ。
 */
export function readStringLiteralEnd(text: string, pos: number): number {
  let i = pos + 1;
  while (i < text.length) {
    if (text[i] === "'") {
      if (text[i + 1] === "'") {
        i += 2;
        continue;
      }
      return i + 1;
    }
    i += 1;
  }
  return text.length;
}

/** Oracle の引用識別子 `"Name"`。`""` で内部の二重引用符を表す */
export function readQuotedIdentifierEnd(text: string, pos: number): number {
  let i = pos + 1;
  while (i < text.length) {
    if (text[i] === '"') {
      if (text[i + 1] === '"') {
        i += 2;
        continue;
      }
      return i + 1;
    }
    i += 1;
  }
  return text.length;
}

const Q_QUOTE_PAIRS: Record<string, string> = {
  '[': ']',
  '(': ')',
  '{': '}',
  '<': '>',
};

/**
 * 代替引用符 `q'[...]'` の開始位置か判定する。`q` / `Q` に `n` / `N` の接頭辞も許す。
 * 返り値は開始オフセット（`q` の位置）から見た引用符本体の情報。
 */
export function readQQuoteStart(
  text: string,
  pos: number,
): { quoteCharIndex: number; delimiter: string; terminator: string } | null {
  let i = pos;
  const first = text[i];
  if (first === 'n' || first === 'N') i += 1;
  const q = text[i];
  if (q !== 'q' && q !== 'Q') return null;
  if (text[i + 1] !== "'") return null;
  const delimiter = text[i + 2];
  if (delimiter === undefined) return null;
  return {
    quoteCharIndex: i + 1,
    delimiter,
    terminator: Q_QUOTE_PAIRS[delimiter] ?? delimiter,
  };
}

/** `q'[...]'` の終端（閉じ引用符の直後）。pos は `q` / `n` の位置 */
export function readQQuoteEnd(text: string, pos: number): number | null {
  const start = readQQuoteStart(text, pos);
  if (!start) return null;
  const bodyStart = start.quoteCharIndex + 2;
  for (let i = bodyStart; i < text.length - 1; i += 1) {
    if (text[i] === start.terminator && text[i + 1] === "'") return i + 2;
  }
  return text.length;
}

/** openPos は '(' の位置。対応する ')' の直後インデックス。閉じ括弧が無ければ null。文字列・コメント内の括弧は数えない */
export function readBalancedParenEnd(text: string, openPos: number): number | null {
  if (text[openPos] !== '(') return null;
  let depth = 0;
  for (let i = openPos; i < text.length; ) {
    if (isLineCommentStart(text, i)) {
      i = readLineCommentEnd(text, i);
      continue;
    }
    if (text[i] === '/' && text[i + 1] === '*') {
      i = readBlockCommentEnd(text, i);
      continue;
    }
    const qQuoteEnd = readQQuoteEnd(text, i);
    if (qQuoteEnd != null) {
      i = qQuoteEnd;
      continue;
    }
    if (text[i] === "'") {
      i = readStringLiteralEnd(text, i);
      continue;
    }
    if (text[i] === '"') {
      i = readQuotedIdentifierEnd(text, i);
      continue;
    }
    if (text[i] === '(') depth += 1;
    else if (text[i] === ')') {
      depth -= 1;
      if (depth === 0) return i + 1;
    }
    i += 1;
  }
  return null;
}

/**
 * 文字列リテラル・コメント・引用識別子以外の領域。
 * keepQuotedIdentifiers を付けると、引用識別子（`"E E"`）もコードの領域に含める
 */
export function findCodeRegions(sql: string, keepQuotedIdentifiers = false): CodeRegion[] {
  const regions: CodeRegion[] = [];
  let codeStart = 0;
  let i = 0;

  const closeCode = (end: number) => {
    if (end > codeStart) regions.push({ start: codeStart, end });
    codeStart = end;
  };

  while (i < sql.length) {
    const ch = sql[i];
    const next = sql[i + 1];

    if (isLineCommentStart(sql, i)) {
      closeCode(i);
      i = readLineCommentEnd(sql, i);
      codeStart = i;
      continue;
    }

    if (ch === '/' && next === '*') {
      closeCode(i);
      i = readBlockCommentEnd(sql, i);
      codeStart = i;
      continue;
    }

    const qQuoteEnd = readQQuoteEnd(sql, i);
    if (qQuoteEnd != null) {
      closeCode(i);
      i = qQuoteEnd;
      codeStart = i;
      continue;
    }

    if (ch === "'") {
      closeCode(i);
      i = readStringLiteralEnd(sql, i);
      codeStart = i;
      continue;
    }

    if (ch === '"') {
      if (keepQuotedIdentifiers) {
        i = readQuotedIdentifierEnd(sql, i);
        continue;
      }
      closeCode(i);
      i = readQuotedIdentifierEnd(sql, i);
      codeStart = i;
      continue;
    }

    i += 1;
  }

  closeCode(sql.length);
  return regions;
}

/** 文字列・コメント・引用識別子を同じ長さの空白に置き換える。オフセットは元 SQL と一致する */
export function maskNonCode(sql: string): string {
  return maskOutside(sql, findCodeRegions(sql));
}

/**
 * 文字列とコメントだけを同じ長さの空白に置き換え、引用識別子（`"E E"`）は残す。
 * 式の中の表の参照（`"E E".id`）を探すときに使う
 */
export function maskLiteralsAndComments(sql: string): string {
  return maskOutside(sql, findCodeRegions(sql, true));
}

function maskOutside(sql: string, regions: CodeRegion[]): string {
  let masked = '';
  let pos = 0;
  for (const region of regions) {
    masked += ' '.repeat(region.start - pos);
    masked += sql.slice(region.start, region.end);
    pos = region.end;
  }
  masked += ' '.repeat(sql.length - pos);
  return masked;
}

/**
 * 閉じていない文字列（`'`）・代替引用符（`q'[`）・引用識別子（`"`）・ブロックコメント（`/*`）の開始位置。
 * どれも閉じていれば null。読み取りの関数は閉じていないときも末尾の位置を返すので、閉じたかどうかはここで確かめ直す
 */
export function findUnclosedLiteral(sql: string): { start: number; opener: string } | null {
  let i = 0;
  while (i < sql.length) {
    const ch = sql[i];
    if (isLineCommentStart(sql, i)) {
      i = readLineCommentEnd(sql, i);
      continue;
    }
    if (ch === '/' && sql[i + 1] === '*') {
      const end = readBlockCommentEnd(sql, i);
      if (end < i + 4 || sql.slice(end - 2, end) !== '*/') return { start: i, opener: '/*' };
      i = end;
      continue;
    }
    // `q'[…]'` は、直前が語の文字でないときだけ代替引用符になる（`seq'…'` の q は名前の一部）
    const qQuote = isWordChar(sql[i - 1]) ? null : readQQuoteStart(sql, i);
    if (qQuote) {
      const end = readQQuoteEnd(sql, i)!;
      if (end < qQuote.quoteCharIndex + 4 || sql.slice(end - 2, end) !== `${qQuote.terminator}'`) {
        return { start: i, opener: sql.slice(i, qQuote.quoteCharIndex + 2) };
      }
      i = end;
      continue;
    }
    if (ch === "'" || ch === '"') {
      let j = i + 1;
      let closed = false;
      while (j < sql.length) {
        if (sql[j] === ch) {
          if (sql[j + 1] === ch) {
            j += 2;
            continue;
          }
          closed = true;
          j += 1;
          break;
        }
        // Oracle ではバックスラッシュはエスケープではない
        j += 1;
      }
      if (!closed) return { start: i, opener: ch };
      i = j;
      continue;
    }
    i += 1;
  }
  return null;
}

/**
 * 範囲の終端から、後ろに付いた空白とコメントを除いた終端を返す関数を作る。
 * SQL パーサーの位置情報は要素の後ろの空白やコメントまで範囲に含めることがある。
 * そのままだと、要素を選んだときにエディタで後ろのコメントまで強調し、
 * カーソルがコメントや次の語の先頭にあるときも、手前の要素を対応する要素として選んでしまう。
 * 文字列と引用識別子の中の空白は除かない。表は SQL 全体で 1 回だけ作る
 */
export function createTrailingTriviaTrimmer(sql: string): (start: number, end: number) => number {
  // codeEndAt[i]: sql[0..i) のうち、空白とコメント以外の最後の文字の直後の位置
  const codeEndAt = new Int32Array(sql.length + 1);
  let lastCodeEnd = 0;
  let i = 0;
  const markTrivia = (to: number) => {
    for (let k = i + 1; k <= to; k += 1) codeEndAt[k] = lastCodeEnd;
    i = to;
  };
  const markCode = (to: number) => {
    for (let k = i + 1; k <= to; k += 1) codeEndAt[k] = k;
    lastCodeEnd = to;
    i = to;
  };
  while (i < sql.length) {
    const ch = sql[i]!;
    const qQuoteEnd = isWordChar(sql[i - 1]) ? null : readQQuoteEnd(sql, i);
    if (isLineCommentStart(sql, i)) markTrivia(readLineCommentEnd(sql, i));
    else if (ch === '/' && sql[i + 1] === '*') markTrivia(readBlockCommentEnd(sql, i));
    else if (qQuoteEnd != null) markCode(qQuoteEnd);
    else if (ch === "'") markCode(readStringLiteralEnd(sql, i));
    else if (ch === '"') markCode(readQuotedIdentifierEnd(sql, i));
    else if (/\s/.test(ch)) markTrivia(i + 1);
    else markCode(i + 1);
  }
  return (start, end) => {
    if (end <= start || end > sql.length) return end;
    const trimmed = codeEndAt[end]!;
    return trimmed > start ? trimmed : end;
  };
}
