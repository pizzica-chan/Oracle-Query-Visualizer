import { collectAllNestedQueries, collectSubqueriesFromCondition } from './query-utils';
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

/** CTE の参照は、parser.ts の attachCteDefinitions が表示名を「名前（CTE）」にして作る */
function isCteReference(table: TableRef): boolean {
  return Boolean(table.isDerived && table.displayName?.endsWith('（CTE）'));
}

/**
 * 別名 alias のテーブルについて、ツールチップの文を返す。別名を説明する必要がなければ undefined。
 * - FROM 句のサブクエリ（派生テーブル）は、parser.ts が table と alias を同じ値で作るので、同じでも説明する
 * - CTE の参照は「WITH 句の名前」と書く。別名を付けずに参照したときは、名前そのものなので説明しない
 * - 実テーブルは、別名が実テーブル名と違うときだけ説明する
 */
function aliasTooltipText(alias: string, table: TableRef): string | undefined {
  if (!sameAliasName(table.alias, alias)) return undefined;
  if (isCteReference(table)) {
    return sameAliasName(table.table, alias) ? undefined : `${alias} は WITH 句の ${table.table} の別名`;
  }
  if (table.isDerived) return `${alias} は派生テーブル（FROM 句のサブクエリ）の別名`;
  if (sameAliasName(table.alias, table.table)) return undefined;
  return `${alias} は ${table.schema ? `${table.schema}.${table.table}` : table.table} の別名`;
}

/**
 * 別名どうしを、大文字小文字を区別せずに比べる。
 * Oracle は引用符なしの名前の大文字小文字を区別せず、大文字として扱う（Oracle Database 23 SQL Language Reference
 * 「Database Object Names and Qualifiers」）。区別して比べると、同じ別名になる `O` と `o` を別物として
 * 「指す先が 1 つ」と判定してしまうので、区別しない側で重複を数える
 */
function sameAliasName(a: string | undefined, b: string): boolean {
  return a !== undefined && a.toLowerCase() === b.toLowerCase();
}

/**
 * query と、その中のすべての階層のクエリを返す。
 * collectAllNestedQueries が見る派生テーブル・WHERE / HAVING・UNION に加えて、
 * CTE の定義、スカラーサブクエリ（SELECT 列・SET・ORDER BY の中）、JOIN の ON の中のサブクエリもたどる。
 * 別名の重複の判定で 1 か所でも見落とすと、同じ別名の別のテーブルを指す字句に誤った名前を出すため
 */
function collectAllScopes(root: ParsedQuery): ParsedQuery[] {
  const seen = new Set<ParsedQuery>();
  const walk = (query: ParsedQuery) => {
    if (seen.has(query)) return;
    seen.add(query);
    for (const nested of collectAllNestedQueries(query)) walk(nested);
    for (const cte of query.ctes ?? []) walk(cte.query);
    for (const sub of query.embeddedSubqueries ?? []) walk(sub);
    for (const join of query.joins) {
      for (const sub of collectSubqueriesFromCondition(join.conditionRoot)) walk(sub);
    }
  };
  walk(root);
  return [...seen];
}

/**
 * 別名（エイリアス）を指す字句に、実テーブル名の説明を返す。ツールチップ用。
 * table の字句は別名そのもの、column の字句は `別名.列` の別名部分で判定する。
 *
 * 説明文にはサブクエリの中の字句も入るが、字句がどの階層のものかは分からない。
 * そこで query とその中のすべての階層を見て、同じ別名が指す先が 1 つに決まるときだけ返す。
 * 外側が `orders o`、EXISTS の中が `order_items o` のように指す先が分かれるときは、誤った名前を出さないよう返さない。
 * 別名が実テーブル名と同じとき、別名の無いテーブル、どこにも無い別名も undefined
 */
export function aliasTooltipFor(segment: EffectTextSegment, query?: ParsedQuery): string | undefined {
  if (!query || (segment.kind !== 'table' && segment.kind !== 'column')) return undefined;
  const alias = segment.kind === 'column' ? segment.text.split('.')[0] : segment.text;
  if (!alias) return undefined;
  // 説明文の字句 1 つごとに全階層をたどると、字句の数 × 階層の数の処理になる。クエリごとに結果を覚えておく
  let cache = aliasTooltipCache.get(query);
  if (!cache) {
    cache = new Map();
    aliasTooltipCache.set(query, cache);
  }
  if (!cache.has(alias)) cache.set(alias, computeAliasTooltip(alias, query));
  return cache.get(alias);
}

/** 解析結果（ParsedQuery）は作り直されるたびに別のオブジェクトになるので、WeakMap なら古い結果は自然に消える */
const aliasTooltipCache = new WeakMap<ParsedQuery, Map<string, string | undefined>>();

function computeAliasTooltip(alias: string, query: ParsedQuery): string | undefined {
  const texts = new Set<string>();
  let usedAsPlainName = false;
  for (const scope of collectAllScopes(query)) {
    for (const table of scope.tables) {
      if (!sameAliasName(table.alias, alias) && !(!table.alias && sameAliasName(table.table, alias))) continue;
      const text = aliasTooltipText(alias, table);
      if (text) texts.add(text);
      else usedAsPlainName = true;
    }
  }
  // 同じ名前が、ある階層では別名、別の階層では実テーブル名そのものとして使われているときも、指す先が決まらない
  return texts.size === 1 && !usedAsPlainName ? [...texts][0] : undefined;
}
