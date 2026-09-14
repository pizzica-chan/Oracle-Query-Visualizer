import type { SourceSpan } from './types';
import {
  isLineCommentStart,
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

function isWordChar(ch: string | undefined): boolean {
  return ch !== undefined && /[\w$]/.test(ch);
}

function matchKeyword(text: string, pos: number): string | null {
  const slice = text.slice(pos);
  for (const keyword of KEYWORDS) {
    const re = new RegExp(`^${keyword.replace(/\s+/g, '\\s+')}(?![\\w$])`, 'i');
    const match = slice.match(re);
    if (match) {
      const before = pos > 0 ? text[pos - 1] : '';
      if (isWordChar(before)) continue;
      return match[0];
    }
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
  const match = text.slice(pos).match(/^(\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/);
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

    const number = readNumber(sql, i);
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

function wrapHighlightSegment(kind: SqlHighlightKind, text: string, focused: boolean): string {
  const escaped = escapeHtml(text);
  if (!focused && kind === 'plain') return escaped;
  const classes: string[] = [];
  if (kind !== 'plain') classes.push(`sql-hl--${kind}`);
  if (focused) classes.push('sql-hl--focus');
  return `<span class="${classes.join(' ')}">${escaped}</span>`;
}

function renderTokenHighlight(
  kind: SqlHighlightKind,
  text: string,
  tokenStart: number,
  focusSpan?: SourceSpan,
): string {
  if (!focusSpan) {
    return wrapHighlightSegment(kind, text, false);
  }

  const tokenEnd = tokenStart + text.length;
  if (tokenEnd <= focusSpan.start || tokenStart >= focusSpan.end) {
    return wrapHighlightSegment(kind, text, false);
  }

  const focusStart = Math.max(focusSpan.start, tokenStart) - tokenStart;
  const focusEnd = Math.min(focusSpan.end, tokenEnd) - tokenStart;

  const before = text.slice(0, focusStart);
  const focused = text.slice(focusStart, focusEnd);
  const after = text.slice(focusEnd);

  return [
    wrapHighlightSegment(kind, before, false),
    wrapHighlightSegment(kind, focused, true),
    wrapHighlightSegment(kind, after, false),
  ].join('');
}

export function highlightSqlToHtml(sql: string, focusSpan?: SourceSpan): string {
  let pos = 0;
  return tokenizeSql(sql)
    .map(({ kind, text }) => {
      const start = pos;
      pos += text.length;
      return renderTokenHighlight(kind, text, start, focusSpan);
    })
    .join('');
}
