/** SQL 字句走査の共通ユーティリティ（ハイライト・前処理で共有） */

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

/** 文字列リテラル・コメント・引用識別子以外の領域 */
export function findCodeRegions(sql: string): CodeRegion[] {
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
  const regions = findCodeRegions(sql);
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
