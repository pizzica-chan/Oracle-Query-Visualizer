import type { SourceSpan } from './types';
import {
  isLineCommentStart,
  isWordChar,
  readBlockCommentEnd,
  readLineCommentEnd,
  readQQuoteEnd,
  readQuotedIdentifierEnd,
  readStringLiteralEnd,
} from './sql-lex';

export type SqlHighlightKind =
  | 'keyword'
  | 'string'
  | 'comment'
  | 'number'
  | 'identifier'
  | 'operator'
  | 'plain';

export interface SqlHighlightToken {
  kind: SqlHighlightKind;
  text: string;
}

const KEYWORDS = [
  'UNION ALL',
  'GROUP BY',
  'ORDER BY',
  'CONNECT BY NOCYCLE',
  'CONNECT BY',
  'START WITH',
  'PARTITION BY',
  'WITHIN GROUP',
  'INNER JOIN',
  'LEFT JOIN',
  'RIGHT JOIN',
  'FULL JOIN',
  'CROSS JOIN',
  'OUTER APPLY',
  'CROSS APPLY',
  'FETCH FIRST',
  'FETCH NEXT',
  'ROWS ONLY',
  'WITH TIES',
  'NULLS FIRST',
  'NULLS LAST',
  'FOR UPDATE',
  'IS NOT',
  'NOT NULL',
  'NOT IN',
  'SELECT',
  'UPDATE',
  'DELETE',
  'INSERT',
  'MERGE',
  'FROM',
  'WHERE',
  'HAVING',
  'JOIN',
  'INNER',
  'OUTER',
  'LEFT',
  'RIGHT',
  'FULL',
  'CROSS',
  'NATURAL',
  'LATERAL',
  'UNION',
  'MINUS',
  'INTERSECT',
  'DISTINCT',
  'UNIQUE',
  'BETWEEN',
  'EXISTS',
  'ESCAPE',
  'USING',
  'PIVOT',
  'UNPIVOT',
  'OFFSET',
  'FETCH',
  'ROWS',
  'ROW',
  'ONLY',
  'PERCENT',
  'PRIOR',
  'NOCYCLE',
  'LEVEL',
  'ROWNUM',
  'ROWID',
  'SYSDATE',
  'SYSTIMESTAMP',
  'DUAL',
  'ASC',
  'DESC',
  'NULLS',
  'INTO',
  'VALUES',
  'SET',
  'CASE',
  'WHEN',
  'THEN',
  'ELSE',
  'END',
  'WITH',
  'ON',
  'AS',
  'AND',
  'OR',
  'NOT',
  'IN',
  'IS',
  'NULL',
  'LIKE',
  'ALL',
  'ANY',
  'SOME',
  'BY',
].sort((a, b) => b.length - a.length);

/** `(+)` は旧式外部結合演算子。演算子として色分けする */
const OPERATORS = ['(+)', '>=', '<=', '<>', '!=', '^=', '||', ':='].sort(
  (a, b) => b.length - a.length,
);

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * キーワードの正規表現は最初に 1 回だけ作り、sticky（y）で pos の位置から照合する。
 * 文字ごとに作り直したり、残りの文字列を切り出したりすると、大きな SQL で 1 文字の入力に 1 秒以上かかる
 */
const KEYWORD_PATTERNS = KEYWORDS.map(
  (keyword) => new RegExp(`${keyword.replace(/\s+/g, '\\s+')}(?![\\w$#\\u0080-\\uFFFF])`, 'iy'),
);

const NUMBER_PATTERN = /(\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/y;
/** N'abc' の、引用符の直前の接頭辞。接頭辞も文字列の色にする（nq'[…]' は代替引用符として先に読む） */
const STRING_PREFIX_PATTERN = /n(?=')/iy;

function matchKeyword(text: string, pos: number): string | null {
  // 語の途中（直前が英数字）からはキーワードにしない
  if (pos > 0 && isWordChar(text[pos - 1])) return null;
  for (const pattern of KEYWORD_PATTERNS) {
    pattern.lastIndex = pos;
    const match = pattern.exec(text);
    if (match) return match[0];
  }
  return null;
}

function readLineComment(text: string, pos: number): string {
  return text.slice(pos, readLineCommentEnd(text, pos));
}

function readBlockComment(text: string, pos: number): string {
  return text.slice(pos, readBlockCommentEnd(text, pos));
}

function readStringLiteral(text: string, pos: number): string {
  return text.slice(pos, readStringLiteralEnd(text, pos));
}

function readQuotedIdentifier(text: string, pos: number): string {
  return text.slice(pos, readQuotedIdentifierEnd(text, pos));
}

function readNumber(text: string, pos: number): string | null {
  NUMBER_PATTERN.lastIndex = pos;
  const match = NUMBER_PATTERN.exec(text);
  return match ? match[0] : null;
}

function pushToken(tokens: SqlHighlightToken[], kind: SqlHighlightKind, text: string): void {
  if (text.length === 0) return;
  const last = tokens[tokens.length - 1];
  if (last && last.kind === kind) {
    last.text += text;
    return;
  }
  tokens.push({ kind, text });
}

export function tokenizeSql(sql: string): SqlHighlightToken[] {
  const tokens: SqlHighlightToken[] = [];
  let i = 0;

  while (i < sql.length) {
    const ch = sql[i];
    const next = sql[i + 1];

    // 語の途中の文字は、キーワードにも数値にも、文字列の始まりにもならない。語の終わりまでまとめて進める。
    // 数字も同じで、u1 や order2 の数字を数値の色にしない
    if (i > 0 && isWordChar(sql[i - 1]) && isWordChar(ch)) {
      let end = i + 1;
      while (end < sql.length && isWordChar(sql[end])) end++;
      pushToken(tokens, 'plain', sql.slice(i, end));
      i = end;
      continue;
    }

    if (isLineCommentStart(sql, i)) {
      const text = readLineComment(sql, i);
      pushToken(tokens, 'comment', text);
      i += text.length;
      continue;
    }

    if (ch === '/' && next === '*') {
      const text = readBlockComment(sql, i);
      pushToken(tokens, 'comment', text);
      i += text.length;
      continue;
    }

    // 代替引用符 q'[...]' は文字列としてまとめて扱う
    const qQuoteEnd = readQQuoteEnd(sql, i);
    if (qQuoteEnd != null) {
      const text = sql.slice(i, qQuoteEnd);
      pushToken(tokens, 'string', text);
      i += text.length;
      continue;
    }

    STRING_PREFIX_PATTERN.lastIndex = i;
    const stringPrefix = STRING_PREFIX_PATTERN.exec(sql)?.[0];
    if (stringPrefix) {
      const text = stringPrefix + readStringLiteral(sql, i + stringPrefix.length);
      pushToken(tokens, 'string', text);
      i += text.length;
      continue;
    }

    if (ch === "'") {
      const text = readStringLiteral(sql, i);
      pushToken(tokens, 'string', text);
      i += text.length;
      continue;
    }

    if (ch === '"') {
      const text = readQuotedIdentifier(sql, i);
      pushToken(tokens, 'identifier', text);
      i += text.length;
      continue;
    }

    // t.1st の .1 や 1 のように、修飾の点とその直後は数値にしない（0.5 の点は、数値の途中として先に読んでいる）
    const qualifierDot = (ch === '.' && isWordChar(sql[i - 1])) || sql[i - 1] === '.';
    const number = qualifierDot ? null : readNumber(sql, i);
    if (number) {
      pushToken(tokens, 'number', number);
      i += number.length;
      continue;
    }

    const keyword = matchKeyword(sql, i);
    if (keyword) {
      pushToken(tokens, 'keyword', keyword);
      i += keyword.length;
      continue;
    }

    let matchedOperator = false;
    for (const op of OPERATORS) {
      if (sql.startsWith(op, i)) {
        pushToken(tokens, 'operator', op);
        i += op.length;
        matchedOperator = true;
        break;
      }
    }
    if (matchedOperator) continue;

    pushToken(tokens, 'plain', ch);
    i += 1;
  }

  return tokens;
}

/** エディタ上の印。focus は右側の表示と連動した範囲、error は構文エラーの範囲 */
export interface SqlHighlightMarks {
  focus?: SourceSpan;
  error?: SourceSpan;
}

interface HighlightSegment {
  text: string;
  classes: string[];
}

function inSpan(span: SourceSpan | undefined, offset: number): boolean {
  return Boolean(span && offset >= span.start && offset < span.end);
}

/** トークンを印の境界で切り分け、各片に付けるクラスを決める */
function highlightSegments(sql: string, marks: SqlHighlightMarks): HighlightSegment[] {
  const segments: HighlightSegment[] = [];
  const markEdges = [marks.focus, marks.error]
    .filter((span): span is SourceSpan => Boolean(span))
    .flatMap((span) => [span.start, span.end]);
  let pos = 0;

  for (const { kind, text } of tokenizeSql(sql)) {
    const tokenStart = pos;
    const tokenEnd = pos + text.length;
    pos = tokenEnd;
    const cuts = [
      tokenStart,
      ...markEdges.filter((edge) => edge > tokenStart && edge < tokenEnd).sort((a, b) => a - b),
      tokenEnd,
    ];
    for (let i = 0; i + 1 < cuts.length; i++) {
      const from = cuts[i]!;
      const to = cuts[i + 1]!;
      if (from === to) continue;
      const classes: string[] = [];
      if (kind !== 'plain') classes.push(`sql-hl--${kind}`);
      if (inSpan(marks.focus, from)) classes.push('sql-hl--focus');
      if (inSpan(marks.error, from)) classes.push('sql-hl--error');
      segments.push({ text: text.slice(from - tokenStart, to - tokenStart), classes });
    }
  }
  return segments;
}

function wrapSegment({ text, classes }: HighlightSegment): string {
  const escaped = escapeHtml(text);
  if (classes.length === 0) return escaped;
  return `<span class="${classes.join(' ')}">${escaped}</span>`;
}

export function highlightSqlToHtml(sql: string, focusSpan?: SourceSpan, errorSpan?: SourceSpan): string {
  return highlightSegments(sql, { focus: focusSpan, error: errorSpan }).map(wrapSegment).join('');
}

/**
 * 行ごとの HTML を返す（行番号付きのエディタ用）。
 * 複数行にまたがるトークン（ブロックコメントや改行を含む文字列）は、行の境目で span を閉じて開き直す。
 * 戻り値の長さは sql の行数（改行の数 + 1）に一致する
 */
export function highlightSqlToLineHtml(sql: string, marks: SqlHighlightMarks = {}): string[] {
  const lines: string[] = [''];
  for (const segment of highlightSegments(sql, marks)) {
    const parts = segment.text.split('\n');
    parts.forEach((part, index) => {
      if (index > 0) lines.push('');
      if (part) lines[lines.length - 1] += wrapSegment({ text: part, classes: segment.classes });
    });
  }
  return lines;
}
