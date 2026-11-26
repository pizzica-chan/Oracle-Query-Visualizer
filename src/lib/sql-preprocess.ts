import {
  createTrailingTriviaTrimmer,
  isLineCommentStart,
  isWordChar,
  maskNonCode,
  readBalancedParenEnd,
  readBlockCommentEnd,
  readLineCommentEnd,
  readQQuoteEnd,
  readQQuoteStart,
  readQuotedIdentifierEnd,
  readStringLiteralEnd,
  type CodeRegion,
} from './sql-lex';
import type { ConditionNode, ParsedQuery, SourceSpan, SqlFragment } from './types';

export type { CodeRegion };
export { findCodeRegions, maskNonCode } from './sql-lex';

/** 前処理で取り除いた Oracle 固有構文の記録。processedPos は前処理後 SQL 上の位置 */
interface ProcessedAnchor {
  processedPos: number;
}

/** CAST の型名を MySQL の型名に書き換えた所。processedPos は書き換えた範囲の始まり（AS の直後） */
export interface CastTypeInfo extends ProcessedAnchor {
  /** 元の SQL の型の書き方（`NUMBER(10, 2)` など） */
  originalType: string;
  /** パーサーに渡した型の書き方（`DECIMAL(10, 2)` など）。書き換えていなければ originalType と同じ */
  rewrittenType: string;
}

/** 集約関数の後ろの WITHIN GROUP (…) / KEEP (…)。processedPos は空白に置き換えた範囲の始まり */
export interface AggregateClauseInfo extends ProcessedAnchor {
  /** 元の SQL の書き方（連続する空白は 1 つにまとめる） */
  text: string;
}

/** 旧式外部結合演算子 `(+)` */
export interface OuterJoinMarker extends ProcessedAnchor {
  /** 元 SQL 上の `(+)` の範囲 */
  sourceSpan: SourceSpan;
}

/** 階層問い合わせ（CONNECT BY / START WITH） */
export interface HierarchicalClauseInfo extends ProcessedAnchor {
  startWith?: string;
  connectBy?: string;
  noCycle: boolean;
  /** 元 SQL 上の階層問い合わせ句全体 */
  sourceSpan: SourceSpan;
  startWithSpan?: SourceSpan;
  connectBySpan?: SourceSpan;
}

/** 行制限句（OFFSET … ROWS FETCH FIRST … ROWS ONLY） */
export interface RowLimitInfo extends ProcessedAnchor {
  offset?: string;
  count?: string;
  percent: boolean;
  withTies: boolean;
  /** 元 SQL 上の行制限句全体 */
  sourceSpan: SourceSpan;
  offsetSpan?: SourceSpan;
  countSpan?: SourceSpan;
}

/** オプティマイザヒント `/*+ … *\/` */
export interface OptimizerHintInfo extends ProcessedAnchor {
  /** `/*+` と `*\/` を除いたヒント本文 */
  text: string;
  /** 元 SQL 上のヒントコメント全体 */
  sourceSpan: SourceSpan;
}

/** ORDER BY の NULLS FIRST / NULLS LAST */
export interface NullsOrderInfo extends ProcessedAnchor {
  /** 'FIRST' | 'LAST' */
  position: 'FIRST' | 'LAST';
  sourceSpan: SourceSpan;
  /** 空白に置き換えた NULLS FIRST / LAST の長さ。ORDER BY の項目の範囲をここまで延ばす */
  processedLength: number;
}

export interface PreprocessResult {
  sql: string;
  naturalJoinStarts: number[];
  outerJoinMarkers: OuterJoinMarker[];
  hierarchicalClauses: HierarchicalClauseInfo[];
  rowLimits: RowLimitInfo[];
  hints: OptimizerHintInfo[];
  nullsOrders: NullsOrderInfo[];
  /** CAST の型名を書き換えた位置と、元の型の書き方 */
  castTypes: CastTypeInfo[];
  /** 取り除いた WITHIN GROUP (…) / KEEP (…) の位置と、元の書き方。表示では関数の後ろに戻す */
  aggregateClauses: AggregateClauseInfo[];
  /** ウィンドウ枠の RANGE を ROWS に置き換えた位置（前処理後 SQL 上）。表示では RANGE に戻す */
  rangeFrameStarts: number[];
  /** preprocessed[i] の文字が元 SQL のどの位置か */
  processedToOriginal: number[];
  /** 前処理で置き換えた関数名（大文字の仮の名前 → 元の名前）。表示では元の名前に戻す */
  renamedFunctions: Map<string, string>;
}

interface ProcessState {
  sql: string;
  processedToOriginal: number[];
  /** splice で位置がずれたときに補正する記録（前処理後 SQL 上の位置を持つ） */
  anchors: ProcessedAnchor[];
  /** 同じく補正対象の生オフセット配列 */
  offsetLists: number[][];
}

function initState(sql: string): ProcessState {
  return {
    sql,
    processedToOriginal: Array.from({ length: sql.length }, (_, index) => index),
    anchors: [],
    offsetLists: [],
  };
}

function originalSpanForProcessedRange(state: ProcessState, start: number, end: number): SourceSpan {
  const origStart = state.processedToOriginal[start] ?? start;
  const last = Math.max(start, end - 1);
  const origLast = state.processedToOriginal[last] ?? last;
  return { start: origStart, end: origLast + 1 };
}

/** 左側の splice で processed 長が変わったとき、既に記録した位置を補正する */
function adjustRecordedPositions(state: ProcessState, spliceStart: number, delta: number): void {
  if (delta === 0) return;
  for (const anchor of state.anchors) {
    if (anchor.processedPos > spliceStart) anchor.processedPos += delta;
  }
  for (const list of state.offsetLists) {
    for (let i = 0; i < list.length; i++) {
      if (list[i]! > spliceStart) list[i]! += delta;
    }
  }
}

/** 挿入文字を元範囲へ配る。先頭は origStart、末尾は origLast に載せ、置換全体の span が潰れるのを防ぐ */
function originalOffsetsForInsertion(
  state: ProcessState,
  start: number,
  end: number,
  insertedLength: number,
): number[] {
  if (insertedLength === 0) return [];

  const origStart =
    state.processedToOriginal[start] ??
    state.processedToOriginal[Math.max(0, end - 1)] ??
    start;
  const origLast =
    end > start ? (state.processedToOriginal[end - 1] ?? origStart) : origStart;

  return Array.from({ length: insertedLength }, (_, i) => {
    if (i === insertedLength - 1) return origLast;
    const mapped = origStart + i;
    return mapped < origLast ? mapped : origLast;
  });
}

function spliceProcessed(
  state: ProcessState,
  start: number,
  end: number,
  inserted: string,
  /** 挿入する文字ごとの元 SQL 上の位置。省くと、置き換える範囲の中へ順に配る */
  explicitMap?: number[],
): void {
  const delta = inserted.length - (end - start);
  const insertedMap = explicitMap ?? originalOffsetsForInsertion(state, start, end, inserted.length);
  state.sql = state.sql.slice(0, start) + inserted + state.sql.slice(end);
  state.processedToOriginal = [
    ...state.processedToOriginal.slice(0, start),
    ...insertedMap,
    ...state.processedToOriginal.slice(end),
  ];
  adjustRecordedPositions(state, start, delta);
}

/** 同じ長さの空白へ置き換える。位置対応表が変わらないので記録済み位置の補正が不要 */
function blankOut(state: ProcessState, start: number, end: number): void {
  if (end <= start) return;
  state.sql = state.sql.slice(0, start) + ' '.repeat(end - start) + state.sql.slice(end);
}

interface RegexReplacement {
  pattern: RegExp;
  replace: (match: RegExpExecArray) => string;
  recordStartAt?: (processedStart: number) => void;
}

function applyRegexReplacementsInCode(
  state: ProcessState,
  replacements: RegexReplacement[],
): void {
  for (const { pattern, replace, recordStartAt } of replacements) {
    const flags = pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`;
    const re = new RegExp(pattern.source, flags);
    const matches: Array<{ start: number; end: number; match: RegExpExecArray }> = [];
    const masked = maskNonCode(state.sql);
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(masked)) !== null) {
      if (m[0].length === 0) {
        re.lastIndex += 1;
        continue;
      }
      let end = m.index + m[0].length;
      if (masked[end - 1] === '(') {
        const closed = readBalancedParenEnd(masked, end - 1);
        if (closed == null) continue;
        end = closed;
      }
      matches.push({
        start: m.index,
        end,
        match: m,
      });
    }

    matches.sort((a, b) => b.start - a.start);
    for (const { start, end, match } of matches) {
      const inserted = replace(match);
      if (recordStartAt) recordStartAt(start);
      spliceProcessed(state, start, end, inserted);
    }
  }
}

const NATURAL_JOIN_RE =
  /\bNATURAL\s+((?:INNER|LEFT|RIGHT|FULL|CROSS)\s+)?(?:OUTER\s+)?JOIN\b/i;

/** SELECT 直後にだけ現れる修飾子。列名・エイリアスとしては書き換えない */
const SELECT_MODIFIERS = new Set(['ALL', 'DISTINCT', 'UNIQUE']);

function skipMaskedWhitespace(masked: string, pos: number): number {
  let i = pos;
  while (i < masked.length && /\s/.test(masked[i]!)) i += 1;
  return i;
}

function readWord(masked: string, pos: number): { word: string; end: number } | null {
  if (pos >= masked.length || !/[A-Za-z_]/.test(masked[pos]!)) return null;
  let i = pos + 1;
  while (i < masked.length && /[A-Za-z0-9_]/.test(masked[i]!)) i += 1;
  return { word: masked.slice(pos, i), end: i };
}

function findWholeWordStarts(masked: string, keyword: string): number[] {
  const re = new RegExp(`\\b${keyword}\\b`, 'gi');
  const starts: number[] = [];
  let match: RegExpExecArray | null;
  while ((match = re.exec(masked)) !== null) starts.push(match.index);
  return starts;
}

// ---------------------------------------------------------------------------
// 代替引用符 q'[...]' → 通常の文字列リテラル
// ---------------------------------------------------------------------------

/** q'[it's]' のような代替引用符を `'it''s'` へ書き換える（パーサは代替引用符を解さない） */
function rewriteAlternativeQuotes(state: ProcessState): void {
  const replacements: Array<{ start: number; end: number; inserted: string }> = [];
  let i = 0;
  const sql = state.sql;
  while (i < sql.length) {
    if (isLineCommentStart(sql, i)) {
      i = readLineCommentEnd(sql, i);
      continue;
    }
    if (sql[i] === '/' && sql[i + 1] === '*') {
      i = readBlockCommentEnd(sql, i);
      continue;
    }
    if (sql[i] === '"') {
      i = readQuotedIdentifierEnd(sql, i);
      continue;
    }
    const start = readQQuoteStart(sql, i);
    if (start) {
      const end = readQQuoteEnd(sql, i);
      // 閉じていない代替引用符は書き換えない。書き換えると末尾の 2 文字を閉じ記号とみなして別の文字列にしてしまい、
      // 構文エラーにならない。そのまま渡せば、パーサーのエラーから「閉じていません」と示せる
      const closed =
        end != null && end >= start.quoteCharIndex + 4 && sql.slice(end - 2, end) === `${start.terminator}'`;
      if (end != null && !closed) break;
      if (end != null) {
        const body = sql.slice(start.quoteCharIndex + 2, Math.max(start.quoteCharIndex + 2, end - 2));
        replacements.push({ start: i, end, inserted: `'${body.replace(/'/g, "''")}'` });
        i = end;
        continue;
      }
    }
    if (sql[i] === "'") {
      i = readStringLiteralEnd(sql, i);
      continue;
    }
    i += 1;
  }

  for (const { start, end, inserted } of replacements.reverse()) {
    spliceProcessed(state, start, end, inserted);
  }
}

// ---------------------------------------------------------------------------
// オプティマイザヒント /*+ ... */
// ---------------------------------------------------------------------------

function collectOptimizerHints(state: ProcessState): OptimizerHintInfo[] {
  const hints: OptimizerHintInfo[] = [];
  const sql = state.sql;
  let i = 0;
  while (i < sql.length) {
    if (isLineCommentStart(sql, i)) {
      i = readLineCommentEnd(sql, i);
      continue;
    }
    if (sql[i] === "'") {
      i = readStringLiteralEnd(sql, i);
      continue;
    }
    if (sql[i] === '"') {
      i = readQuotedIdentifierEnd(sql, i);
      continue;
    }
    if (sql[i] === '/' && sql[i + 1] === '*') {
      const end = readBlockCommentEnd(sql, i);
      if (sql[i + 2] === '+') {
        const body = sql.slice(i + 3, Math.max(i + 3, end - 2)).trim();
        hints.push({
          processedPos: i,
          text: body,
          sourceSpan: originalSpanForProcessedRange(state, i, end),
        });
        // `+` を空白へ。ヒントであることをパーサへ伝えない（長さは保つ）
        blankOut(state, i + 2, i + 3);
      }
      i = end;
      continue;
    }
    i += 1;
  }
  return hints;
}

// ---------------------------------------------------------------------------
// 旧式外部結合演算子 (+)
// ---------------------------------------------------------------------------

const OUTER_JOIN_OPERATOR_RE = /\(\s*\+\s*\)/g;

function collectOuterJoinMarkers(state: ProcessState): OuterJoinMarker[] {
  const masked = maskNonCode(state.sql);
  // 空白化する範囲は前処理後 SQL 上の長さで持つ。元 SQL の span 長から逆算すると、
  // 先行する書き換えで長さが変わったときに範囲がずれる
  const found: Array<{ marker: OuterJoinMarker; processedEnd: number }> = [];
  OUTER_JOIN_OPERATOR_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = OUTER_JOIN_OPERATOR_RE.exec(masked)) !== null) {
    const start = match.index;
    const end = start + match[0].length;
    found.push({
      marker: {
        processedPos: start,
        sourceSpan: originalSpanForProcessedRange(state, start, end),
      },
      processedEnd: end,
    });
  }
  for (const { marker, processedEnd } of found.slice().reverse()) {
    blankOut(state, marker.processedPos, processedEnd);
  }
  return found.map((entry) => entry.marker);
}

// ---------------------------------------------------------------------------
// 階層問い合わせ CONNECT BY / START WITH
// ---------------------------------------------------------------------------

/** 句の終端になるキーワード（深さ 0 のみ有効） */
const CLAUSE_TERMINATORS = [
  'GROUP',
  'HAVING',
  'ORDER',
  'UNION',
  'MINUS',
  'INTERSECT',
  'EXCEPT',
  'FETCH',
  'OFFSET',
  'FOR',
  'WHERE',
  'START',
  'CONNECT',
  'MODEL',
  'WITH',
];

/**
 * masked 上で pos から句の終端を探す。深さ 0 で終端キーワードか `)` / `;` に当たるまで。
 * excludeKeywords に挙げたキーワードは終端とみなさない
 */
function findClauseEnd(masked: string, pos: number, excludeKeywords: string[]): number {
  let depth = 0;
  let i = pos;
  while (i < masked.length) {
    const ch = masked[i]!;
    if (ch === '(') {
      depth += 1;
      i += 1;
      continue;
    }
    if (ch === ')') {
      if (depth === 0) return i;
      depth -= 1;
      i += 1;
      continue;
    }
    if (ch === ';' && depth === 0) return i;
    if (depth === 0 && /[A-Za-z_]/.test(ch) && !/[\w$]/.test(masked[i - 1] ?? ' ')) {
      const token = readWord(masked, i);
      if (token) {
        const upper = token.word.toUpperCase();
        if (CLAUSE_TERMINATORS.includes(upper) && !excludeKeywords.includes(upper)) return i;
        i = token.end;
        continue;
      }
    }
    i += 1;
  }
  return masked.length;
}

interface HierarchicalPart {
  kind: 'START WITH' | 'CONNECT BY';
  keywordStart: number;
  bodyStart: number;
  end: number;
  noCycle: boolean;
}

function collectHierarchicalParts(masked: string): HierarchicalPart[] {
  const parts: HierarchicalPart[] = [];
  const re = /\b(START\s+WITH|CONNECT\s+BY)\b/gi;
  let match: RegExpExecArray | null;
  while ((match = re.exec(masked)) !== null) {
    const keywordStart = match.index;
    let bodyStart = keywordStart + match[0].length;
    let noCycle = false;
    const kind = /START/i.test(match[1]!) ? 'START WITH' : 'CONNECT BY';

    if (kind === 'CONNECT BY') {
      const afterKeyword = skipMaskedWhitespace(masked, bodyStart);
      const token = readWord(masked, afterKeyword);
      if (token && token.word.toUpperCase() === 'NOCYCLE') {
        noCycle = true;
        bodyStart = token.end;
      }
    }

    const end = findClauseEnd(masked, bodyStart, []);
    parts.push({ kind, keywordStart, bodyStart, end, noCycle });
    re.lastIndex = end;
  }
  return parts;
}

function collectHierarchicalClauses(state: ProcessState): HierarchicalClauseInfo[] {
  const masked = maskNonCode(state.sql);
  const parts = collectHierarchicalParts(masked);
  if (parts.length === 0) return [];

  // 隣り合う START WITH と CONNECT BY は同じ SELECT の階層問い合わせなので 1 件にまとめる
  const groups: HierarchicalPart[][] = [];
  for (const part of parts) {
    const group = groups[groups.length - 1];
    const prev = group?.[group.length - 1];
    const adjacent =
      prev != null &&
      prev.kind !== part.kind &&
      masked.slice(prev.end, part.keywordStart).trim().length === 0;
    if (group && adjacent) group.push(part);
    else groups.push([part]);
  }

  const clauses = groups.map((group) => buildHierarchicalClause(state, group));

  for (const part of parts.slice().reverse()) {
    blankOut(state, part.keywordStart, part.end);
  }

  return clauses;
}

function buildHierarchicalClause(
  state: ProcessState,
  parts: HierarchicalPart[],
): HierarchicalClauseInfo {
  const first = parts[0]!;
  const last = parts[parts.length - 1]!;
  const startPart = parts.find((p) => p.kind === 'START WITH');
  const connectPart = parts.find((p) => p.kind === 'CONNECT BY');

  const textOf = (part: HierarchicalPart | undefined): string | undefined =>
    part ? state.sql.slice(part.bodyStart, part.end).trim() : undefined;
  const spanOf = (part: HierarchicalPart | undefined): SourceSpan | undefined =>
    part ? originalSpanForProcessedRange(state, part.keywordStart, part.end) : undefined;

  return {
    processedPos: first.keywordStart,
    startWith: textOf(startPart),
    connectBy: textOf(connectPart),
    noCycle: parts.some((p) => p.noCycle),
    sourceSpan: originalSpanForProcessedRange(state, first.keywordStart, last.end),
    startWithSpan: spanOf(startPart),
    connectBySpan: spanOf(connectPart),
  };
}

// ---------------------------------------------------------------------------
// 行制限句 OFFSET … ROWS / FETCH FIRST … ROWS ONLY
// ---------------------------------------------------------------------------

const ROW_LIMIT_RE =
  /\b(?:OFFSET\s+(?<offset>[^\s]+)\s+ROWS?\s*)?(?:FETCH\s+(?:FIRST|NEXT)\s*(?<count>[^\s]+?)?\s*(?<percent>PERCENT\s+)?ROWS?\s+(?<tail>ONLY|WITH\s+TIES))?/gi;

function collectRowLimits(state: ProcessState): RowLimitInfo[] {
  const masked = maskNonCode(state.sql);
  const limits: Array<{ info: RowLimitInfo; processedEnd: number }> = [];
  ROW_LIMIT_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = ROW_LIMIT_RE.exec(masked)) !== null) {
    if (!match[0].trim()) {
      ROW_LIMIT_RE.lastIndex += 1;
      continue;
    }
    const start = match.index;
    const end = start + match[0].trimEnd().length;
    const groups = match.groups ?? {};

    const offsetText = groups.offset?.trim();
    const countText = groups.count?.trim();
    const offsetSpan = offsetText
      ? spanOfSubstring(state, masked, start, end, offsetText)
      : undefined;
    const countSpan = countText
      ? spanOfSubstring(state, masked, start, end, countText, offsetSpan)
      : undefined;

    limits.push({
      info: {
        processedPos: start,
        offset: offsetText,
        count: countText,
        percent: Boolean(groups.percent),
        withTies: /WITH\s+TIES/i.test(groups.tail ?? ''),
        sourceSpan: originalSpanForProcessedRange(state, start, end),
        offsetSpan,
        countSpan,
      },
      processedEnd: end,
    });
    ROW_LIMIT_RE.lastIndex = end;
  }

  for (const { info, processedEnd } of limits.slice().reverse()) {
    blankOut(state, info.processedPos, processedEnd);
  }
  return limits.map((limit) => limit.info);
}

/** 行制限句の中で数値トークンが現れる位置を元 SQL の span に変換する */
function spanOfSubstring(
  state: ProcessState,
  masked: string,
  regionStart: number,
  regionEnd: number,
  token: string,
  after?: SourceSpan,
): SourceSpan | undefined {
  const region = masked.slice(regionStart, regionEnd);
  let index = region.indexOf(token);
  while (index >= 0) {
    const start = regionStart + index;
    const span = originalSpanForProcessedRange(state, start, start + token.length);
    if (!after || span.start >= after.end) return span;
    index = region.indexOf(token, index + 1);
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// ORDER BY … NULLS FIRST / LAST
// ---------------------------------------------------------------------------

const NULLS_ORDER_RE = /\bNULLS\s+(FIRST|LAST)\b/gi;

function collectNullsOrders(state: ProcessState): NullsOrderInfo[] {
  const masked = maskNonCode(state.sql);
  const found: Array<{ info: NullsOrderInfo; processedEnd: number }> = [];
  NULLS_ORDER_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = NULLS_ORDER_RE.exec(masked)) !== null) {
    const start = match.index;
    const end = start + match[0].length;
    found.push({
      info: {
        processedPos: start,
        position: match[1]!.toUpperCase() as 'FIRST' | 'LAST',
        sourceSpan: originalSpanForProcessedRange(state, start, end),
        processedLength: end - start,
      },
      processedEnd: end,
    });
  }
  for (const { info, processedEnd } of found.slice().reverse()) {
    blankOut(state, info.processedPos, processedEnd);
  }
  return found.map((entry) => entry.info);
}

// ---------------------------------------------------------------------------
// 集約の WITHIN GROUP (...) / KEEP (...)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// 結果集合の形を変えない Oracle 固有の修飾（取り除いてから解析する）
// ---------------------------------------------------------------------------

/** `ORDER SIBLINGS BY` の SIBLINGS。階層問い合わせ専用の並び順指定 */
const ORDER_SIBLINGS_RE = /\bORDER\s+(SIBLINGS)\s+BY\b/gi;

/** `FROM t PARTITION (p1)` / `SUBPARTITION (sp1)` / `PARTITION FOR (…)` */
const TABLE_PARTITION_RE = /\b(?:SUB)?PARTITION\s*(?:FOR\s*)?\(/gi;

/** `SAMPLE (10)` / `SAMPLE BLOCK (10) SEED (1)` */
const SAMPLE_RE = /\bSAMPLE\s*(?:BLOCK\s*)?\(/gi;

/** フラッシュバック問い合わせ `AS OF TIMESTAMP …` / `AS OF SCN …` */
const FLASHBACK_RE = /\bAS\s+OF\s+(?:SCN|TIMESTAMP)\b/gi;

/** 行ロック指定 `FOR UPDATE [OF 列] [NOWAIT | WAIT n | SKIP LOCKED]` */
const FOR_UPDATE_RE = /\bFOR\s+UPDATE\b/gi;

/** データベースリンク `table@dblink` */
const DB_LINK_RE = /@[A-Za-z][\w$#]*(?:\.[A-Za-z][\w$#]*)*/g;

/** マスク済みテキスト上の範囲を、後ろから順に空白へ置き換える */
function blankRanges(state: ProcessState, ranges: Array<{ start: number; end: number }>): void {
  for (const range of ranges.slice().sort((a, b) => b.start - a.start)) {
    blankOut(state, range.start, range.end);
  }
}

function matchRanges(masked: string, re: RegExp, group?: number): Array<{ start: number; end: number }> {
  const ranges: Array<{ start: number; end: number }> = [];
  re.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = re.exec(masked)) !== null) {
    if (group != null) {
      // 部分だけ消す（ORDER SIBLINGS BY → ORDER BY）
      const offset = match[0].indexOf(match[group]!);
      ranges.push({ start: match.index + offset, end: match.index + offset + match[group]!.length });
    } else {
      ranges.push({ start: match.index, end: match.index + match[0].length });
    }
  }
  return ranges;
}

/** 開き括弧で終わる正規表現に対し、対応する閉じ括弧までを範囲にする */
function matchRangesWithParen(masked: string, re: RegExp): Array<{ start: number; end: number }> {
  const ranges: Array<{ start: number; end: number }> = [];
  re.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = re.exec(masked)) !== null) {
    const parenStart = match.index + match[0].length - 1;
    const end = readBalancedParenEnd(masked, parenStart);
    if (end == null) continue;
    ranges.push({ start: match.index, end });
    re.lastIndex = end;
  }
  return ranges;
}

/** フラッシュバック句は `AS OF TIMESTAMP <式>` まで消す */
function flashbackRanges(sql: string, masked: string): Array<{ start: number; end: number }> {
  const ranges: Array<{ start: number; end: number }> = [];
  FLASHBACK_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = FLASHBACK_RE.exec(masked)) !== null) {
    const end = readFlashbackExprEnd(sql, masked, match.index + match[0].length);
    ranges.push({ start: match.index, end });
    FLASHBACK_RE.lastIndex = end;
  }
  return ranges;
}

const INTERVAL_TAIL_RE = /^\s*'(?:[^']|'')*'\s+[A-Za-z]+(?:\s*\(\s*\d+\s*\))?(?:\s+TO\s+[A-Za-z]+(?:\s*\(\s*\d+\s*\))?)?/i;

/**
 * `AS OF TIMESTAMP` / `AS OF SCN` の後ろの式の終わり。式は値・関数の呼び出し・括弧・INTERVAL のリテラルを
 * 算術の演算子でつないだもの（`SYSTIMESTAMP - INTERVAL '1' HOUR`）。演算子が続かなくなった所で止め、
 * 後ろの別名（`t`）や句のキーワードは残す
 */
function readFlashbackExprEnd(sql: string, masked: string, from: number): number {
  let i = from;
  let end = from;
  for (;;) {
    i = skipMaskedWhitespace(masked, i);
    // 値の 1 つ
    if (sql[i] === "'") {
      i = readStringLiteralEnd(sql, i);
    } else if (masked[i] === '(') {
      i = readBalancedParenEnd(masked, i) ?? masked.length;
    } else {
      const word = /^[A-Za-z0-9_$#.]+/.exec(masked.slice(i))?.[0];
      if (!word) return end;
      i += word.length;
      const upper = word.toUpperCase();
      if (upper === 'INTERVAL') {
        const tail = INTERVAL_TAIL_RE.exec(sql.slice(i))?.[0];
        if (tail) i += tail.length;
      } else if ((upper === 'TIMESTAMP' || upper === 'DATE') && sql[skipMaskedWhitespace(masked, i)] === "'") {
        i = readStringLiteralEnd(sql, skipMaskedWhitespace(masked, i));
      } else if (masked[skipMaskedWhitespace(masked, i)] === '(') {
        i = readBalancedParenEnd(masked, skipMaskedWhitespace(masked, i)) ?? masked.length;
      }
    }
    end = i;
    // 演算子が続けば、次の値を読む
    const next = skipMaskedWhitespace(masked, i);
    const operator = /^(?:\|\||[-+*/])/.exec(masked.slice(next))?.[0];
    if (!operator) return end;
    i = next + operator.length;
  }
}

/** 行ロック指定は文末までの修飾なので、まとめて消す */
function forUpdateRanges(masked: string): Array<{ start: number; end: number }> {
  const ranges: Array<{ start: number; end: number }> = [];
  FOR_UPDATE_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = FOR_UPDATE_RE.exec(masked)) !== null) {
    let end = match.index + match[0].length;
    // OF 列リスト / NOWAIT / WAIT n / SKIP LOCKED を食べる
    for (;;) {
      const i = skipMaskedWhitespace(masked, end);
      const token = readWord(masked, i);
      if (!token) break;
      const word = token.word.toUpperCase();
      if (word === 'OF' || word === 'NOWAIT' || word === 'WAIT' || word === 'SKIP' || word === 'LOCKED') {
        end = token.end;
        continue;
      }
      // OF / WAIT の直後に来る列名・秒数は取り込む
      const prev = readWord(masked, skipMaskedWhitespace(masked, match.index));
      if (prev && /^(?:OF|WAIT)$/i.test(masked.slice(i - 3, i).trim())) {
        end = token.end;
        continue;
      }
      break;
    }
    // `FOR UPDATE OF a.col, b.col` の列リストを消す
    let i = skipMaskedWhitespace(masked, end);
    while (i < masked.length && /[\w$#.,\s]/.test(masked[i]!) && !/;/.test(masked[i]!)) {
      if (masked[i] === '\n' && masked.slice(i).trim().length === 0) break;
      i += 1;
    }
    ranges.push({ start: match.index, end: Math.max(end, i) });
    FOR_UPDATE_RE.lastIndex = ranges[ranges.length - 1]!.end;
  }
  return ranges;
}

/**
 * 解析結果の形（対象テーブル・結合・条件）を変えない Oracle 固有の修飾を取り除く。
 * パーサはこれらを解さないため、残すと SQL 全体が解析できなくなる
 */
function stripNonStructuralClauses(state: ProcessState): void {
  const masked = maskNonCode(state.sql);
  blankRanges(state, [
    ...matchRanges(masked, ORDER_SIBLINGS_RE, 1),
    ...matchRangesWithParen(masked, TABLE_PARTITION_RE),
    ...matchRangesWithParen(masked, SAMPLE_RE),
    ...flashbackRanges(state.sql, masked),
    ...forUpdateRanges(masked),
    ...matchRanges(masked, DB_LINK_RE),
  ]);
}

// RANGE の後ろが境界のキーワードか数値のときだけ置き換える。INTERVAL などの式の境界はパーサが ROWS でも読めない
const RANGE_FRAME_RE = /\bRANGE(?=\s+(?:BETWEEN\b|UNBOUNDED\b|CURRENT\s+ROW\b|\d))/gi;

/**
 * ウィンドウ枠の RANGE を、同じ長さの `ROWS ` に置き換える。パーサは ROWS の枠しか読めない。
 * 置き換えた位置を返す。表示では RANGE に戻す（ROWS と RANGE は数える単位が違い、集計の結果が変わる）
 */
function rewriteRangeFrames(state: ProcessState): number[] {
  const starts: number[] = [];
  const masked = maskNonCode(state.sql);
  // OVER (…) の中だけを見る。外の `WHERE e.range BETWEEN 1 AND 2` の列名を書き換えない
  const overRe = /\bOVER\s*\(/gi;
  let over: RegExpExecArray | null;
  while ((over = overRe.exec(masked)) !== null) {
    const open = over.index + over[0].length - 1;
    const close = readBalancedParenEnd(masked, open);
    if (close == null) continue;
    const inside = masked.slice(open, close);
    RANGE_FRAME_RE.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = RANGE_FRAME_RE.exec(inside)) !== null) {
      if (/[.\w$#]/.test(inside[match.index - 1] ?? '')) continue;
      starts.push(open + match.index);
    }
    overRe.lastIndex = close;
  }
  for (const start of starts) {
    state.sql = `${state.sql.slice(0, start)}ROWS ${state.sql.slice(start + 5)}`;
  }
  return starts;
}

const WITHIN_GROUP_RE = /\bWITHIN\s+GROUP\s*\(/gi;
const KEEP_RE = /\bKEEP\s*\(/gi;

/**
 * 集約関数の後ろの WITHIN GROUP (…) / KEEP (…) を取り除く。パーサはこれらを解さない。
 * 取り除いた所と元の書き方を返す。表示では関数の後ろに戻す（LISTAGG の並び順や KEEP の選び方が画面から消えないように）
 */
function stripTrailingFunctionClauses(state: ProcessState, sql: string): AggregateClauseInfo[] {
  const records: AggregateClauseInfo[] = [];
  for (const re of [WITHIN_GROUP_RE, KEEP_RE]) {
    const masked = maskNonCode(state.sql);
    const ranges: Array<{ start: number; end: number }> = [];
    re.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = re.exec(masked)) !== null) {
      const parenStart = match.index + match[0].length - 1;
      const end = readBalancedParenEnd(masked, parenStart);
      if (end == null) continue;
      ranges.push({ start: match.index, end });
      re.lastIndex = end;
    }
    for (const range of ranges) {
      // 元の SQL から取る。前処理の途中の SQL では、中の NULLS FIRST / LAST などが空白になっている
      const original = originalSpanForProcessedRange(state, range.start, range.end);
      records.push({ processedPos: range.start, text: sql.slice(original.start, original.end).replace(/\s+/g, ' ') });
    }
    for (const range of ranges.reverse()) blankOut(state, range.start, range.end);
  }
  return records;
}

// ---------------------------------------------------------------------------
// Oracle のデータ型 → パーサが解する型名
// ---------------------------------------------------------------------------

const ORACLE_CAST_TYPES: Array<[RegExp, string]> = [
  [/\bVARCHAR2\b/gi, 'VARCHAR'],
  [/\bNVARCHAR2\b/gi, 'VARCHAR'],
  [/\bNUMBER\b/gi, 'DECIMAL'],
  [/\bBINARY_DOUBLE\b/gi, 'DOUBLE'],
  [/\bBINARY_FLOAT\b/gi, 'FLOAT'],
  [/\bPLS_INTEGER\b/gi, 'SIGNED'],
  [/\bCLOB\b/gi, 'CHAR'],
  [/\bNCLOB\b/gi, 'CHAR'],
  [/\bRAW\b/gi, 'BINARY'],
];

/**
 * CAST(x AS NUMBER(10,2)) の型名だけを書き換える。列名の NUMBER は触らない。
 * 書き換えた所と元の型の書き方を返す。表示では元の型名に戻す（DECIMAL と書いていない SQL に DECIMAL と出さない）
 */
function rewriteCastTypes(state: ProcessState): CastTypeInfo[] {
  const records: CastTypeInfo[] = [];
  const masked = maskNonCode(state.sql);
  const castRe = /\bCAST\s*\(/gi;
  const regions: Array<{ start: number; end: number }> = [];
  let match: RegExpExecArray | null;
  castRe.lastIndex = 0;
  while ((match = castRe.exec(masked)) !== null) {
    const parenStart = match.index + match[0].length - 1;
    const end = readBalancedParenEnd(masked, parenStart);
    if (end == null) continue;
    const asIndex = findAsKeywordInRegion(masked, parenStart + 1, end - 1);
    if (asIndex == null) continue;
    regions.push({ start: asIndex, end: end - 1 });
  }

  for (const region of regions.reverse()) {
    const text = state.sql.slice(region.start, region.end);
    let rewritten = text;
    for (const [pattern, replacement] of ORACLE_CAST_TYPES) {
      rewritten = rewritten.replace(pattern, replacement);
    }
    // 書き換えない CAST も記録する。表示で型名から元の型を探すとき、DECIMAL と書いた CAST と、
    // NUMBER を DECIMAL に書き換えた CAST を見分けるため
    if (rewritten !== text) spliceProcessed(state, region.start, region.end, rewritten);
    // 左側の書き換えで位置がずれるので、記録はすぐに補正の対象へ入れる
    const record: CastTypeInfo = {
      processedPos: region.start,
      originalType: text.replace(/^AS\s+/i, '').trim(),
      rewrittenType: rewritten.replace(/^AS\s+/i, '').trim(),
    };
    state.anchors.push(record);
    records.push(record);
  }
  return records;
}

function findAsKeywordInRegion(masked: string, start: number, end: number): number | null {
  let depth = 0;
  for (let i = start; i < end; i += 1) {
    const ch = masked[i]!;
    if (ch === '(') depth += 1;
    else if (ch === ')') depth -= 1;
    else if (
      depth === 0 &&
      (ch === 'A' || ch === 'a') &&
      /^AS\b/i.test(masked.slice(i, i + 3)) &&
      !/[\w$]/.test(masked[i - 1] ?? ' ')
    ) {
      return i + 2;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// SELECT UNIQUE → SELECT DISTINCT / DELETE t → DELETE FROM t
// ---------------------------------------------------------------------------

function normalizeSelectModifiers(state: ProcessState): void {
  const masked = maskNonCode(state.sql);
  const strips: Array<{ start: number; end: number; inserted: string }> = [];
  for (const start of findWholeWordStarts(masked, 'SELECT')) {
    let optionEnd = start + 'SELECT'.length;
    let i = skipMaskedWhitespace(masked, optionEnd);
    let hasDistinct = false;
    let found = false;
    while (true) {
      const token = readWord(masked, i);
      if (!token || !SELECT_MODIFIERS.has(token.word.toUpperCase())) break;
      const option = token.word.toUpperCase();
      if (option === 'DISTINCT' || option === 'UNIQUE') hasDistinct = true;
      found = true;
      optionEnd = token.end;
      i = skipMaskedWhitespace(masked, token.end);
    }
    if (!found) continue;
    strips.push({ start, end: optionEnd, inserted: hasDistinct ? 'SELECT DISTINCT' : 'SELECT' });
  }

  for (const strip of strips.reverse()) {
    if (state.sql.slice(strip.start, strip.end) === strip.inserted) continue;
    spliceProcessed(state, strip.start, strip.end, strip.inserted);
  }
}

/**
 * Oracle の複数列同時更新 `SET (a, b) = (SELECT x, y FROM t)` を
 * `SET a = (SELECT x, y FROM t), b = (SELECT x, y FROM t)` へ展開する。
 * パーサはこの構文を解さないため、どの列がどの副問合せで更新されるかを残したまま渡す
 */
function expandMultiColumnUpdateSet(state: ProcessState): void {
  const masked = maskNonCode(state.sql);
  const setStarts = findWholeWordStarts(masked, 'SET');
  const replacements: Array<{ start: number; end: number; inserted: string; map: number[] }> = [];

  for (const setStart of setStarts) {
    // SET 句の終わり（WHERE / 文末 / 閉じ括弧）まで
    const clauseEnd = findClauseEnd(masked, setStart + 'SET'.length, []);
    let i = setStart + 'SET'.length;

    while (i < clauseEnd) {
      if (masked[i] !== '(') {
        i += 1;
        continue;
      }
      const listEnd = readBalancedParenEnd(masked, i);
      if (listEnd == null || listEnd > clauseEnd) break;

      const afterList = skipMaskedWhitespace(masked, listEnd);
      if (masked[afterList] !== '=') {
        i = listEnd;
        continue;
      }
      const valueStart = skipMaskedWhitespace(masked, afterList + 1);
      if (masked[valueStart] !== '(') {
        i = listEnd;
        continue;
      }
      const valueEnd = readBalancedParenEnd(masked, valueStart);
      if (valueEnd == null) break;

      const columns: Array<{ text: string; start: number }> = [];
      let cursor = i + 1;
      for (const raw of state.sql.slice(i + 1, listEnd - 1).split(',')) {
        const text = raw.trim();
        if (text) columns.push({ text, start: cursor + raw.length - raw.trimStart().length });
        cursor += raw.length + 1;
      }
      if (columns.length > 1) {
        // 複製した副問合せの文字は、元の副問合せの同じ文字の位置に対応させる。置き換える範囲の中へ順に配ると、
        // 2 つ目以降の複製の中の範囲（式の中のサブクエリの列など）が、元の SQL の別の場所を指す
        const orig = (pos: number): number => state.processedToOriginal[pos] ?? pos;
        let inserted = '';
        const map: number[] = [];
        const push = (text: string, offsets: number[]) => {
          inserted += text;
          map.push(...offsets);
        };
        columns.forEach((column, index) => {
          if (index > 0) push(', ', [orig(valueEnd - 1), orig(valueEnd - 1)]);
          push(column.text, Array.from(column.text, (_, k) => orig(column.start + k)));
          push(' = ', [orig(afterList), orig(afterList), orig(afterList)]);
          push(
            state.sql.slice(valueStart, valueEnd),
            Array.from({ length: valueEnd - valueStart }, (_, k) => orig(valueStart + k)),
          );
        });
        replacements.push({ start: i, end: valueEnd, inserted, map });
      }
      i = valueEnd;
    }
  }

  for (const { start, end, inserted, map } of replacements.reverse()) {
    spliceProcessed(state, start, end, inserted, map);
  }
}

/** Oracle は `DELETE emp WHERE …` のように FROM を省略できる */
function insertOmittedDeleteFrom(state: ProcessState): void {
  const masked = maskNonCode(state.sql);
  const starts = findWholeWordStarts(masked, 'DELETE');
  for (const start of starts.reverse()) {
    const afterKeyword = start + 'DELETE'.length;
    const i = skipMaskedWhitespace(masked, afterKeyword);
    const token = readWord(masked, i);
    if (!token) continue;
    if (token.word.toUpperCase() === 'FROM') continue;
    spliceProcessed(state, afterKeyword, i, ' FROM ');
  }
}

// ---------------------------------------------------------------------------
// 文字列リテラル中のバックスラッシュ
// ---------------------------------------------------------------------------

/**
 * Oracle の文字列リテラルはバックスラッシュをエスケープとして解釈しない
 * （末尾がバックスラッシュでもそこで文字列は閉じる）。パーサ側はエスケープとして読むので、二重化して渡す
 */
function escapeBackslashesInStringLiterals(state: ProcessState): void {
  const replacements: Array<{ start: number; end: number; inserted: string }> = [];
  const sql = state.sql;
  let i = 0;
  while (i < sql.length) {
    if (isLineCommentStart(sql, i)) {
      i = readLineCommentEnd(sql, i);
      continue;
    }
    if (sql[i] === '/' && sql[i + 1] === '*') {
      i = readBlockCommentEnd(sql, i);
      continue;
    }
    if (sql[i] === '"') {
      i = readQuotedIdentifierEnd(sql, i);
      continue;
    }
    if (sql[i] === "'") {
      const end = readStringLiteralEnd(sql, i);
      const text = sql.slice(i, end);
      if (text.includes('\\')) {
        replacements.push({ start: i, end, inserted: text.replace(/\\/g, '\\\\') });
      }
      i = end;
      continue;
    }
    i += 1;
  }

  for (const { start, end, inserted } of replacements.reverse()) {
    spliceProcessed(state, start, end, inserted);
  }
}

// ---------------------------------------------------------------------------
// `#` / `$` / ASCII 以外の文字を含む識別子
// ---------------------------------------------------------------------------

/**
 * 引用していない Oracle 識別子。先頭はデータベースの文字セットの英字、2 文字目以降は英数字と `_` `$` `#`
 * （Oracle Database 23 SQL Language Reference「Database Object Names and Qualifiers」）。
 * 日本語の文字セットなら、カタカナ・ひらがな・漢字も英数字に入る。
 * 文字・数字・結合文字だけの並びに限る。全角の空白や記号は含めず、パーサーのエラーで位置を示す
 */
const ORACLE_IDENTIFIER_RE = /\p{L}[\p{L}\p{N}\p{M}_$#]*/gu;

/**
 * Oracle は `EMP#` や `USER$` のような識別子を許すが、パーサ側は `#` を行コメント開始として
 * 扱って**エラーも出さずに行の残りを捨てる**。引用してパーサへ渡し、名前をそのまま残す。
 * ASCII 以外の文字を含む識別子（`ユーザー`、`受注2` など）も引用する。パーサーは漢字と一部のラテン文字しか
 * 識別子に認めず、カタカナやひらがなのテーブル名で構文エラーになる。引用しても名前は変わらない
 */
function quoteIdentifiersWithSpecialChars(state: ProcessState): void {
  const masked = maskNonCode(state.sql);
  const targets: Array<{ start: number; end: number }> = [];
  ORACLE_IDENTIFIER_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = ORACLE_IDENTIFIER_RE.exec(masked)) !== null) {
    const word = match[0];
    // 語の途中（`1abc` の abc など）から始まる並びは、識別子の先頭ではない
    if (isWordChar(masked[match.index - 1])) continue;
    // バインド変数（`:名前`）の名前は引用しない。引用すると `:` と名前が離れ、構文エラーになる
    if (masked[match.index - 1] === ':') continue;
    const hasSpecial = word.includes('#') || word.includes('$');
    const hasNonAscii = /[^\x00-\x7f]/.test(word);
    if (!hasSpecial && !hasNonAscii) continue;
    // U+10000 以降（サロゲートペア）はパーサーが読めないので、パーサーのエラーに任せる
    if (/[\ud800-\udfff]/.test(word)) continue;
    targets.push({ start: match.index, end: match.index + word.length });
  }

  for (const { start, end } of targets.reverse()) {
    spliceProcessed(state, start, end, `\`${state.sql.slice(start, end)}\``);
  }
}

// ---------------------------------------------------------------------------
// 集約関数の DISTINCT と、パーサーが読めない集約関数の名前
// ---------------------------------------------------------------------------

/**
 * `SUM(DISTINCT a)` の DISTINCT。Oracle は集約関数の引数の前に DISTINCT を書ける
 * （Oracle Database 23 SQL Language Reference「Aggregate Functions」）が、パーサーは COUNT でしか読めず、
 * 構文エラーになる。`DISTINCT(a)` の形なら読めるので、DISTINCT の後ろの引数を括弧で囲む（表示は parser.ts で元の形に戻す）
 */
const AGGREGATE_DISTINCT_RE =
  /(?<![\w$#.`\u0080-￿])(?:SUM|AVG|MIN|MAX|STDDEV|STDDEV_POP|STDDEV_SAMP|VARIANCE|VAR_POP|VAR_SAMP|MEDIAN)\s*\(\s*DISTINCT\b/giu;

/**
 * 集約関数の UNIQUE。Oracle では DISTINCT と同じ意味（Oracle Database 23 SQL Language Reference
 * 「Aggregate Functions」: DISTINCT and UNIQUE, which are synonymous）だが、パーサーは読めない。
 * DISTINCT に書き換える（表示も DISTINCT になる）
 */
const AGGREGATE_UNIQUE_RE =
  /(?<![\w$#.`\u0080-￿])(?:COUNT|SUM|AVG|MIN|MAX|STDDEV|STDDEV_POP|STDDEV_SAMP|VARIANCE|VAR_POP|VAR_SAMP|MEDIAN)\s*\(\s*(UNIQUE)\b/giu;

function rewriteAggregateUnique(state: ProcessState): void {
  const masked = maskNonCode(state.sql);
  const starts = [...masked.matchAll(AGGREGATE_UNIQUE_RE)].map((m) => m.index + m[0].length - 'UNIQUE'.length);
  for (const start of starts.reverse()) spliceProcessed(state, start, start + 'UNIQUE'.length, 'DISTINCT');
}

/**
 * 階層問い合わせの演算子 CONNECT_BY_ROOT と、SELECT 列などに書いた PRIOR（Oracle Database 23 SQL Language Reference
 * 「Hierarchical Query Operators」）。パーサーは読めないので、`CONNECT_BY_ROOT(e.name)` の関数の形にして読ませ、
 * 表示は parser.ts で元の形に戻す。CONNECT BY 句の中の PRIOR は、句ごと取り除いてあるので対象にならない
 */
const HIERARCHICAL_OPERATOR_RE = /(?<![\w$#.`"\u0080-￿])(?:CONNECT_BY_ROOT|PRIOR)(?=\s)/giu;
/** 演算子の後ろの列（修飾付き、引用識別子を含む） */
const OPERAND_COLUMN_RE = /^(?:"(?:[^"]|"")*"|[\p{L}_][\p{L}\p{N}_$#]*)(?:\s*\.\s*(?:"(?:[^"]|"")*"|[\p{L}_][\p{L}\p{N}_$#]*))*/u;

function parenthesizeHierarchicalOperators(state: ProcessState): void {
  const masked = maskNonCode(state.sql);
  const inserts: Array<{ at: number; text: string }> = [];
  for (const match of masked.matchAll(HIERARCHICAL_OPERATOR_RE)) {
    const keywordEnd = match.index + match[0].length;
    // 引用識別子は masked では空白に見えるので、元の SQL の空白だけを飛ばす
    const operandStart = keywordEnd + (/^\s*/.exec(state.sql.slice(keywordEnd))?.[0].length ?? 0);
    // `PRIOR (a + b)` は、そのままでも関数の呼び出しとして読める
    if (masked[operandStart] === '(') continue;
    const operand = OPERAND_COLUMN_RE.exec(state.sql.slice(operandStart))?.[0];
    if (!operand) continue;
    inserts.push({ at: keywordEnd, text: '(' }, { at: operandStart + operand.length, text: ')' });
  }
  inserts.sort((a, b) => b.at - a.at);
  for (const { at, text } of inserts) spliceProcessed(state, at, at, text);
}

function parenthesizeAggregateDistinct(state: ProcessState): void {
  const masked = maskNonCode(state.sql);
  const inserts: Array<{ at: number; text: string }> = [];
  for (const match of masked.matchAll(AGGREGATE_DISTINCT_RE)) {
    const openParen = masked.indexOf('(', match.index);
    const closeParenEnd = readBalancedParenEnd(masked, openParen);
    if (closeParenEnd == null) continue;
    const argStart = skipMaskedWhitespace(masked, match.index + match[0].length);
    let argEnd = closeParenEnd - 1;
    while (argEnd > argStart && /\s/.test(masked[argEnd - 1]!)) argEnd -= 1;
    if (argEnd <= argStart) continue;
    inserts.push({ at: argStart, text: '(' }, { at: argEnd, text: ')' });
  }
  // 後ろから挿入して、前にある挿入位置をずらさない
  inserts.sort((a, b) => b.at - a.at);
  for (const { at, text } of inserts) spliceProcessed(state, at, at, text);
}

/**
 * 集約関数の VARIANCE。パーサーは集約関数の名前として予約しているのに読む規則を持たず、構文エラーになる。
 * SQL に現れない仮の名前に置き換えて普通の関数として読ませ、表示では parser.ts が元の名前に戻す
 */
const RESERVED_AGGREGATE_NAME_RE = /(?<![\w$#.`\u0080-￿])VARIANCE(?=\s*\()/giu;

function renameReservedAggregates(state: ProcessState): Map<string, string> {
  const renamed = new Map<string, string>();
  const masked = maskNonCode(state.sql);
  const matches = [...masked.matchAll(RESERVED_AGGREGATE_NAME_RE)];
  if (matches.length === 0) return renamed;
  const upperSql = state.sql.toUpperCase();
  const placeholderFor = (name: string): string => {
    const upper = name.toUpperCase();
    for (const [placeholder, original] of renamed) if (original === upper) return placeholder;
    let placeholder = `QV_${upper}_`;
    while (upperSql.includes(placeholder)) placeholder += '_';
    renamed.set(placeholder, upper);
    return placeholder;
  };
  const replacements = matches.map((match) => ({
    start: match.index,
    end: match.index + match[0].length,
    text: placeholderFor(match[0]),
  }));
  for (const { start, end, text } of replacements.reverse()) spliceProcessed(state, start, end, text);
  return renamed;
}

// ---------------------------------------------------------------------------
// UPDATE の SET a = DEFAULT
// ---------------------------------------------------------------------------

/** SET 句の終わりを示す語 */
const SET_CLAUSE_END_WORDS = new Set(['WHERE', 'RETURN', 'RETURNING', 'LOG']);

/**
 * UPDATE の `SET a = DEFAULT`。Oracle は列を既定値に戻す書き方として DEFAULT を書ける
 * （Oracle Database 23 SQL Language Reference「UPDATE」の update_set_clause）が、パーサーは
 * `DEFAULT(a)` の関数の形しか読めない。SET の値がちょうど DEFAULT の 1 語のときだけ、
 * 引用識別子にして列の名前として読ませる（表示は DEFAULT のまま）
 */
function quoteUpdateSetDefault(state: ProcessState): void {
  const masked = maskNonCode(state.sql);
  const firstUpdate = findWholeWordStarts(masked, 'UPDATE')[0];
  if (firstUpdate === undefined) return;
  const starts: number[] = [];
  for (const setStart of findWholeWordStarts(masked, 'SET')) {
    if (setStart < firstUpdate) continue;
    let depth = 0;
    let i = setStart + 'SET'.length;
    /** いま読んでいる `列 = 値` の始まり（SET の直後か、深さ 0 の `,` の直後） */
    let itemStart = i;
    while (i < masked.length) {
      const ch = masked[i]!;
      if (ch === '(') depth += 1;
      else if (ch === ')') depth -= 1;
      else if (ch === ',' && depth === 0) itemStart = i + 1;
      if (depth < 0) break;
      const atWordStart = /[A-Za-z_]/.test(ch) && !isWordChar(masked[i - 1]) && masked[i - 1] !== '.';
      const token = atWordStart ? readWord(masked, i) : null;
      if (!token) {
        i += 1;
        continue;
      }
      const word = token.word.toUpperCase();
      if (depth === 0 && SET_CLAUSE_END_WORDS.has(word)) break;
      if (depth === 0 && word === 'DEFAULT') {
        const next = skipMaskedWhitespace(masked, token.end);
        const after = masked[next];
        const nextWord = readWord(masked, next)?.word.toUpperCase();
        const endsValue =
          after === undefined ||
          after === ',' ||
          after === ';' ||
          (nextWord !== undefined && SET_CLAUSE_END_WORDS.has(nextWord));
        // 値の位置（`列 =` の直後）の DEFAULT だけを見る。`b != DEFAULT` のような比較の右の DEFAULT は書き換えない
        const isAssignedValue = /^[^=<>!:^]*=$/.test(masked.slice(itemStart, i).trim());
        if (isAssignedValue && endsValue) starts.push(i);
      }
      i = token.end;
    }
  }
  // 同じ長さの引用識別子は作れないので、長さの変わる書き換えにする
  for (const start of starts.sort((a, b) => b - a)) {
    spliceProcessed(state, start, start + 'DEFAULT'.length, '"DEFAULT"');
  }
}

// ---------------------------------------------------------------------------
// 引用識別子 "Name" → `Name`
// ---------------------------------------------------------------------------

/** パーサは Oracle の `"Name"` を文字列リテラルとして扱うので、同じ長さのバッククォートへ置き換える */
function rewriteQuotedIdentifiers(state: ProcessState): void {
  const sql = state.sql;
  let out = '';
  let i = 0;
  let changed = false;
  while (i < sql.length) {
    if (isLineCommentStart(sql, i)) {
      const end = readLineCommentEnd(sql, i);
      out += sql.slice(i, end);
      i = end;
      continue;
    }
    if (sql[i] === '/' && sql[i + 1] === '*') {
      const end = readBlockCommentEnd(sql, i);
      out += sql.slice(i, end);
      i = end;
      continue;
    }
    if (sql[i] === "'") {
      const end = readStringLiteralEnd(sql, i);
      out += sql.slice(i, end);
      i = end;
      continue;
    }
    if (sql[i] === '"') {
      const end = readQuotedIdentifierEnd(sql, i);
      // 閉じていない引用識別子は書き換えない。最後の 1 文字を閉じ記号に置き換えると、構文エラーにならずに別の名前として読まれる
      if (end - i < 2 || sql[end - 1] !== '"') return;
      const inner = sql.slice(i + 1, Math.max(i + 1, end - 1));
      // 長さを保つため `""` は `` `` `` へ 1:1 で置き換える
      out += `\`${inner.replace(/""/g, '``')}\``;
      changed = true;
      i = end;
      continue;
    }
    out += sql[i];
    i += 1;
  }
  if (changed && out.length === sql.length) {
    state.sql = out;
  }
}

// ---------------------------------------------------------------------------

export function preprocessSqlForParser(sql: string): PreprocessResult {
  const state = initState(sql);
  const naturalJoinStarts: number[] = [];
  state.offsetLists.push(naturalJoinStarts);

  rewriteAlternativeQuotes(state);

  const hints = collectOptimizerHints(state);
  state.anchors.push(...hints);

  const rowLimits = collectRowLimits(state);
  state.anchors.push(...rowLimits);

  const hierarchicalClauses = collectHierarchicalClauses(state);
  state.anchors.push(...hierarchicalClauses);

  const outerJoinMarkers = collectOuterJoinMarkers(state);
  state.anchors.push(...outerJoinMarkers);

  const nullsOrders = collectNullsOrders(state);
  state.anchors.push(...nullsOrders);

  stripNonStructuralClauses(state);
  const aggregateClauses = stripTrailingFunctionClauses(state, sql);
  state.anchors.push(...aggregateClauses);
  const rangeFrameStarts = rewriteRangeFrames(state);
  state.offsetLists.push(rangeFrameStarts);
  const castTypes = rewriteCastTypes(state);
  normalizeSelectModifiers(state);
  expandMultiColumnUpdateSet(state);
  insertOmittedDeleteFrom(state);
  quoteUpdateSetDefault(state);

  applyRegexReplacementsInCode(state, [
    {
      pattern: NATURAL_JOIN_RE,
      replace: (match) => {
        const type = match[1]?.trim().toUpperCase() || 'INNER';
        return `${type} JOIN`;
      },
      recordStartAt: (processedStart) => naturalJoinStarts.push(processedStart),
    },
  ]);

  escapeBackslashesInStringLiterals(state);
  rewriteAggregateUnique(state);
  parenthesizeAggregateDistinct(state);
  parenthesizeHierarchicalOperators(state);
  const renamedFunctions = renameReservedAggregates(state);
  quoteIdentifiersWithSpecialChars(state);

  // 位置が動かない書き換えなので、記録済みのオフセットはそのまま使える
  rewriteQuotedIdentifiers(state);

  return {
    sql: state.sql,
    naturalJoinStarts,
    outerJoinMarkers,
    hierarchicalClauses,
    rowLimits,
    hints,
    nullsOrders,
    castTypes,
    aggregateClauses,
    rangeFrameStarts,
    processedToOriginal: state.processedToOriginal,
    renamedFunctions,
  };
}

export function remapSourceSpan(
  map: number[],
  span: SourceSpan | undefined,
): SourceSpan | undefined {
  if (!span || span.end <= span.start) return span;
  const start = map[span.start];
  if (start === undefined) return span;
  const endAnchor = Math.min(Math.max(span.end - 1, span.start), map.length - 1);
  const endOrig = map[endAnchor];
  if (endOrig === undefined) return span;
  return { start, end: endOrig + 1 };
}

function remapSqlFragment(map: number[], fragment: SqlFragment): SqlFragment {
  const sourceSpan = remapSourceSpan(map, fragment.sourceSpan);
  return sourceSpan ? { ...fragment, sourceSpan } : fragment;
}

function remapConditionNode(
  map: number[],
  node: ConditionNode | undefined,
  originalSql?: string,
): ConditionNode | undefined {
  if (!node) return undefined;
  const sourceSpan = remapSourceSpan(map, node.sourceSpan);
  const children = node.children
    ?.map((child) => remapConditionNode(map, child, originalSql))
    .filter((child): child is ConditionNode => Boolean(child));
  const nestedQuery = node.nestedQuery
    ? remapParsedQuerySpans(map, node.nestedQuery, originalSql)
    : undefined;
  return {
    ...node,
    ...(sourceSpan ? { sourceSpan } : {}),
    ...(children?.length ? { children } : {}),
    ...(nestedQuery ? { nestedQuery } : {}),
  };
}

function skipSqlTrivia(sql: string, pos: number): number {
  let i = pos;
  while (i < sql.length) {
    const ch = sql[i];
    const next = sql[i + 1];
    if (ch !== undefined && /\s/.test(ch)) {
      i += 1;
      continue;
    }
    if (isLineCommentStart(sql, i)) {
      i = readLineCommentEnd(sql, i);
      continue;
    }
    if (ch === '/' && next === '*') {
      i = readBlockCommentEnd(sql, i);
      continue;
    }
    break;
  }
  return i;
}

function aliasEquals(a: string, b: string): boolean {
  return a.localeCompare(b, undefined, { sensitivity: 'accent' }) === 0;
}

function isAsKeywordAt(sql: string, pos: number): number | null {
  if (sql.slice(pos, pos + 2).toUpperCase() !== 'AS') return null;
  if (isWordChar(sql[pos + 2])) return null;
  return pos + 2;
}

function matchAliasTokenAt(sql: string, pos: number, alias: string): number | null {
  const ch = sql[pos];
  if (ch === '"') {
    const end = readQuotedIdentifierEnd(sql, pos);
    if (end <= pos + 1 || sql[end - 1] !== '"') return null;
    const inner = sql.slice(pos + 1, end - 1).replace(/""/g, '"');
    return aliasEquals(inner, alias) ? end : null;
  }
  const end = pos + alias.length;
  if (end > sql.length) return null;
  if (!aliasEquals(sql.slice(pos, end), alias)) return null;
  if (isWordChar(sql[end])) return null;
  return end;
}

function extendColumnSpanWithAlias(
  sql: string,
  alias: string | undefined,
  span: SourceSpan | undefined,
): SourceSpan | undefined {
  if (!span || !alias) return span;
  let pos = skipSqlTrivia(sql, span.end);
  const afterAs = isAsKeywordAt(sql, pos);
  if (afterAs != null) pos = skipSqlTrivia(sql, afterAs);
  const aliasEnd = matchAliasTokenAt(sql, pos, alias);
  if (aliasEnd == null) return span;
  return { start: span.start, end: aliasEnd };
}

export function remapParsedQuerySpans(
  map: number[],
  query: ParsedQuery,
  originalSql?: string,
): ParsedQuery {
  return {
    ...query,
    sourceSpan: remapSourceSpan(map, query.sourceSpan),
    // 以下は前処理の時点で元 SQL 座標
    hintSpan: query.hintSpan,
    rowLimitSpan: query.rowLimitSpan,
    limitSpan: query.limitSpan,
    offsetSpan: query.offsetSpan,
    hierarchical: query.hierarchical,
    tables: query.tables.map((table) => ({
      ...table,
      sourceSpan: remapSourceSpan(map, table.sourceSpan),
      derivedQuery: table.derivedQuery
        ? remapParsedQuerySpans(map, table.derivedQuery, originalSql)
        : undefined,
    })),
    joins: query.joins.map((join) => ({
      ...join,
      sourceSpan: remapSourceSpan(map, join.sourceSpan),
      conditionRoot: remapConditionNode(map, join.conditionRoot, originalSql),
      layoutConditionRoot: remapConditionNode(map, join.layoutConditionRoot, originalSql),
    })),
    columns: query.columns.map((col) => {
      let sourceSpan = remapSourceSpan(map, col.sourceSpan);
      if (originalSql) {
        sourceSpan = extendColumnSpanWithAlias(originalSql, col.alias, sourceSpan);
      }
      return { ...col, sourceSpan };
    }),
    where: remapConditionNode(map, query.where, originalSql),
    having: remapConditionNode(map, query.having, originalSql),
    groupBy: query.groupBy.map((g) => remapSqlFragment(map, g)),
    orderBy: query.orderBy.map((o) => remapSqlFragment(map, o)),
    ctes: query.ctes?.map((cte) => ({
      ...cte,
      sourceSpan: remapSourceSpan(map, cte.sourceSpan),
      query: remapParsedQuerySpans(map, cte.query, originalSql),
    })),
    unionBranches: query.unionBranches?.map((branch) => ({
      ...branch,
      sourceSpan: remapSourceSpan(map, branch.sourceSpan),
      query: remapParsedQuerySpans(map, branch.query, originalSql),
    })),
    embeddedSubqueries: query.embeddedSubqueries?.map((sub) => remapParsedQuerySpans(map, sub, originalSql)),
  };
}

/**
 * 解析結果の中のすべての範囲（sourceSpan / limitSpan など、名前が Span で終わるもの）を delta だけ後ろへずらす。
 * 解析は前後の空白を取り除いた SQL で行うので、呼び出し元が渡した SQL の座標に戻すのに使う。
 * 解析結果はこの解析で作ったばかりのオブジェクトなので、範囲のオブジェクトをその場で差し替える
 */
export function shiftParsedQuerySpans(query: ParsedQuery, delta: number): ParsedQuery {
  if (delta === 0) return query;
  visitSpans(query, (span) => ({ start: span.start + delta, end: span.end + delta }));
  return query;
}

/**
 * 解析結果の中のすべての範囲から、終端の後ろに付いた空白とコメントを除く。
 * sql は範囲の座標の基準になっている SQL（入力の SQL）
 */
export function trimParsedQuerySpanEnds(query: ParsedQuery, sql: string): ParsedQuery {
  const trimEnd = createTrailingTriviaTrimmer(sql);
  visitSpans(query, (span) => {
    const end = trimEnd(span.start, span.end);
    return end === span.end ? span : { start: span.start, end };
  });
  return query;
}

/**
 * 名前が Span で終わるフィールドの範囲を、update の戻り値で差し替える。
 * 同じ範囲のオブジェクトを複数の要素が持っていても、update は 1 回だけ呼ぶ（2 回ずらさない）
 */
function visitSpans(root: unknown, update: (span: SourceSpan) => SourceSpan): void {
  const seen = new Set<object>();
  const replaced = new Map<SourceSpan, SourceSpan>();
  const visit = (value: unknown): void => {
    if (!value || typeof value !== 'object' || seen.has(value)) return;
    seen.add(value);
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    const record = value as Record<string, unknown>;
    for (const [key, child] of Object.entries(record)) {
      if (key.endsWith('Span') && isSpan(child)) {
        let next = replaced.get(child);
        if (!next) {
          next = update(child);
          replaced.set(child, next);
        }
        if (next !== child) record[key] = next;
      } else {
        visit(child);
      }
    }
  };
  visit(root);
}

function isSpan(value: unknown): value is SourceSpan {
  return (
    !!value &&
    typeof value === 'object' &&
    typeof (value as SourceSpan).start === 'number' &&
    typeof (value as SourceSpan).end === 'number'
  );
}
