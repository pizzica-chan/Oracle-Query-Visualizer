import type { ParsedQuery, TableRef } from './types';

export type EffectHighlightKind = 'keyword' | 'table' | 'column' | 'string' | 'emphasis';

export interface EffectTextSegment {
  text: string;
  kind?: EffectHighlightKind;
}

const SQL_KEYWORDS = [
  '実質 INNER JOIN',
  'STRAIGHT JOIN',
  'STRAIGHT_JOIN',
  'INNER JOIN',
  'LEFT JOIN',
  'RIGHT JOIN',
  'FULL JOIN',
  'CROSS JOIN',
  'GROUP BY',
  'ORDER BY',
  'IS NULL',
  'SQL上は',
  'WHERE',
  'HAVING',
  'BETWEEN',
  'EXISTS',
  'DISTINCT',
  'UNION ALL',
  'OFFSET',
  'COUNT DISTINCT',
  'JOIN',
  'LIKE',
  'AND',
  'NOT',
  'OR',
  'IN',
] as const;

const EMPHASIS_PHRASES: readonly string[] = [];

const COLUMN_PATTERN = /^([a-zA-Z_][\w$]*)\.([a-zA-Z_*][\w$]*)/;

interface MatchCandidate {
  length: number;
  kind: EffectHighlightKind;
  text: string;
}

interface TableTermSets {
  tableTerms: string[];
  qualifiedTableTerms: string[];
}

function tableLabel(table: TableRef): string {
  if (table.schema) {
    const physical = `${table.schema}.${table.table}`;
    if (table.alias && table.alias !== table.table) {
      return `${physical}（${table.alias}）`;
    }
    return physical;
  }
  if (table.alias && table.alias !== table.table) {
    return `${table.table}（${table.alias}）`;
  }
  return table.table;
}

function collectTableTerms(query: ParsedQuery): TableTermSets {
  const terms = new Set<string>();
  const qualified = new Set<string>();

  for (const table of query.tables) {
    terms.add(tableLabel(table));
    if (table.table) terms.add(table.table);
    if (table.alias) terms.add(table.alias);
    if (table.displayName) terms.add(table.displayName);

    if (table.schema) {
      const physical = `${table.schema}.${table.table}`;
      terms.add(physical);
      qualified.add(physical);
      if (table.alias && table.alias !== table.table) {
        const withAlias = `${physical}（${table.alias}）`;
        terms.add(withAlias);
        qualified.add(withAlias);
      }
    } else if (table.displayName.includes('.')) {
      qualified.add(table.displayName);
    }
  }

  return {
    tableTerms: [...terms].sort((a, b) => b.length - a.length),
    qualifiedTableTerms: [...qualified].sort((a, b) => b.length - a.length),
  };
}

function isIdentifierChar(ch: string | undefined): boolean {
  return ch !== undefined && /[\w$]/.test(ch);
}

function matchesTerm(text: string, pos: number, term: string): boolean {
  if (!text.startsWith(term, pos)) return false;

  if (term.includes('（') || term.includes('.')) {
    return true;
  }

  const before = pos > 0 ? text[pos - 1] : '';
  const after = text[pos + term.length];
  if (isIdentifierChar(before)) return false;
  if (isIdentifierChar(after)) return false;
  return true;
}

function readSqlQuotedString(text: string, pos: number, quote: "'" | '"'): MatchCandidate | null {
  if (text[pos] !== quote) return null;

  let i = pos + 1;
  while (i < text.length) {
    if (text[i] === quote) {
      if (text[i + 1] === quote) {
        i += 2;
        continue;
      }
      return {
        length: i - pos + 1,
        kind: 'string',
        text: text.slice(pos, i + 1),
      };
    }
    i += 1;
  }

  return {
    length: text.length - pos,
    kind: 'string',
    text: text.slice(pos),
  };
}

function findBestMatch(
  text: string,
  pos: number,
  tableTerms: string[],
  qualifiedTableTerms: string[],
): MatchCandidate | null {
  const sqlString = readSqlQuotedString(text, pos, "'");
  if (sqlString) return sqlString;
  const sqlDoubleString = readSqlQuotedString(text, pos, '"');
  if (sqlDoubleString) return sqlDoubleString;

  if (text[pos] === '「') {
    const end = text.indexOf('」', pos + 1);
    if (end !== -1) {
      return {
        length: end - pos + 1,
        kind: 'string',
        text: text.slice(pos, end + 1),
      };
    }
  }

  for (const phrase of EMPHASIS_PHRASES) {
    if (matchesTerm(text, pos, phrase)) {
      return { length: phrase.length, kind: 'emphasis', text: phrase };
    }
  }

  for (const keyword of SQL_KEYWORDS) {
    if (matchesTerm(text, pos, keyword)) {
      return { length: keyword.length, kind: 'keyword', text: keyword };
    }
  }

  for (const term of qualifiedTableTerms) {
    if (matchesTerm(text, pos, term)) {
      return { length: term.length, kind: 'table', text: term };
    }
  }

  const columnMatch = text.slice(pos).match(COLUMN_PATTERN);
  if (columnMatch) {
    return {
      length: columnMatch[0].length,
      kind: 'column',
      text: columnMatch[0],
    };
  }

  for (const term of tableTerms) {
    if (matchesTerm(text, pos, term)) {
      return { length: term.length, kind: 'table', text: term };
    }
  }

  return null;
}

function segmentInnerCondition(
  text: string,
  tableTerms: string[],
  qualifiedTableTerms: string[],
): EffectTextSegment[] {
  const segments: EffectTextSegment[] = [];
  let pos = 0;

  while (pos < text.length) {
    let matched = false;
    for (const term of qualifiedTableTerms) {
      if (matchesTerm(text, pos, term)) {
        segments.push({ text: term, kind: 'table' });
        pos += term.length;
        matched = true;
        break;
      }
    }
    if (matched) continue;

    const columnMatch = text.slice(pos).match(COLUMN_PATTERN);
    if (columnMatch) {
      segments.push({ text: columnMatch[0], kind: 'column' });
      pos += columnMatch[0].length;
      continue;
    }

    matched = false;
    for (const term of tableTerms) {
      if (matchesTerm(text, pos, term)) {
        segments.push({ text: term, kind: 'table' });
        pos += term.length;
        matched = true;
        break;
      }
    }
    if (matched) continue;

    let nextPos = pos + 1;
    while (nextPos < text.length) {
      const hasQualifiedTable = qualifiedTableTerms.some((term) => matchesTerm(text, nextPos, term));
      const hasColumn = COLUMN_PATTERN.test(text.slice(nextPos));
      const hasTable = tableTerms.some((term) => matchesTerm(text, nextPos, term));
      if (hasQualifiedTable || hasColumn || hasTable) break;
      nextPos += 1;
    }
    segments.push({ text: text.slice(pos, nextPos) });
    pos = nextPos;
  }

  return mergeAdjacentPlainSegments(segments);
}

function segmentQuotedString(
  text: string,
  tableTerms: string[],
  qualifiedTableTerms: string[],
): EffectTextSegment[] {
  const inner = text.slice(1, -1);
  return [
    { text: '「', kind: 'string' },
    ...segmentInnerCondition(inner, tableTerms, qualifiedTableTerms),
    { text: '」', kind: 'string' },
  ];
}

function mergeAdjacentPlainSegments(segments: EffectTextSegment[]): EffectTextSegment[] {
  const merged: EffectTextSegment[] = [];
  for (const segment of segments) {
    const prev = merged.at(-1);
    if (prev && !prev.kind && !segment.kind) {
      prev.text += segment.text;
    } else {
      merged.push({ ...segment });
    }
  }
  return merged;
}

export function segmentEffectText(text: string, query?: ParsedQuery): EffectTextSegment[] {
  const { tableTerms, qualifiedTableTerms } = query
    ? collectTableTerms(query)
    : { tableTerms: [], qualifiedTableTerms: [] };
  const segments: EffectTextSegment[] = [];
  let pos = 0;

  while (pos < text.length) {
    const match = findBestMatch(text, pos, tableTerms, qualifiedTableTerms);

    if (!match) {
      let nextPos = pos + 1;
      while (nextPos < text.length && !findBestMatch(text, nextPos, tableTerms, qualifiedTableTerms)) {
        nextPos += 1;
      }
      segments.push({ text: text.slice(pos, nextPos) });
      pos = nextPos;
      continue;
    }

    if (match.kind === 'string') {
      if (match.text.startsWith("'") || match.text.startsWith('"')) {
        segments.push({ text: match.text, kind: 'string' });
      } else {
        segments.push(...segmentQuotedString(match.text, tableTerms, qualifiedTableTerms));
      }
    } else {
      segments.push({ text: match.text, kind: match.kind });
    }
    pos += match.length;
  }

  return mergeAdjacentPlainSegments(segments);
}
