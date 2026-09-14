import {
  isLineCommentStart,
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
}

export interface PreprocessResult {
  sql: string;
  naturalJoinStarts: number[];
  outerJoinMarkers: OuterJoinMarker[];
  hierarchicalClauses: HierarchicalClauseInfo[];
  rowLimits: RowLimitInfo[];
  hints: OptimizerHintInfo[];
  nullsOrders: NullsOrderInfo[];
  /** preprocessed[i] の文字が元 SQL のどの位置か */
  processedToOriginal: number[];
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
): void {
  const delta = inserted.length - (end - start);
  const insertedMap = originalOffsetsForInsertion(state, start, end, inserted.length);
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
function flashbackRanges(masked: string): Array<{ start: number; end: number }> {
  const ranges: Array<{ start: number; end: number }> = [];
  FLASHBACK_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = FLASHBACK_RE.exec(masked)) !== null) {
    let i = skipMaskedWhitespace(masked, match.index + match[0].length);
    if (masked[i] === '(') {
      const end = readBalancedParenEnd(masked, i);
      i = end ?? masked.length;
    } else {
      // 括弧が無いときは次の句のキーワードまで
      while (i < masked.length && !/[\s,;)]/.test(masked[i]!)) i += 1;
    }
    ranges.push({ start: match.index, end: i });
    FLASHBACK_RE.lastIndex = i;
  }
  return ranges;
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
    ...flashbackRanges(masked),
    ...forUpdateRanges(masked),
    ...matchRanges(masked, DB_LINK_RE),
  ]);
}

const WITHIN_GROUP_RE = /\bWITHIN\s+GROUP\s*\(/gi;
const KEEP_RE = /\bKEEP\s*\(/gi;

function stripTrailingFunctionClauses(state: ProcessState): void {
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
    for (const range of ranges.reverse()) blankOut(state, range.start, range.end);
  }
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

/** CAST(x AS NUMBER(10,2)) の型名だけを書き換える。列名の NUMBER は触らない */
function rewriteCastTypes(state: ProcessState): void {
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
    if (rewritten !== text) spliceProcessed(state, region.start, region.end, rewritten);
  }
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
  const replacements: Array<{ start: number; end: number; inserted: string }> = [];

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

      const columns = state.sql
        .slice(i + 1, listEnd - 1)
        .split(',')
        .map((c) => c.trim())
        .filter(Boolean);
      if (columns.length > 1) {
        const value = state.sql.slice(valueStart, valueEnd);
        replacements.push({
          start: i,
          end: valueEnd,
          inserted: columns.map((column) => `${column} = ${value}`).join(', '),
        });
      }
      i = valueEnd;
    }
  }

  for (const { start, end, inserted } of replacements.reverse()) {
    spliceProcessed(state, start, end, inserted);
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
// `#` / `$` を含む識別子
// ---------------------------------------------------------------------------

/** 引用していない Oracle 識別子。`#` と `$` は 2 文字目以降に使える */
const ORACLE_IDENTIFIER_RE = /[A-Za-z][A-Za-z0-9_$#]*/g;

/**
 * Oracle は `EMP#` や `USER$` のような識別子を許すが、パーサ側は `#` を行コメント開始として
 * 扱って**エラーも出さずに行の残りを捨てる**。引用してパーサへ渡し、名前をそのまま残す
 */
function quoteIdentifiersWithSpecialChars(state: ProcessState): void {
  const masked = maskNonCode(state.sql);
  const targets: Array<{ start: number; end: number }> = [];
  ORACLE_IDENTIFIER_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = ORACLE_IDENTIFIER_RE.exec(masked)) !== null) {
    const word = match[0];
    if (!word.includes('#') && !word.includes('$')) continue;
    targets.push({ start: match.index, end: match.index + word.length });
  }

  for (const { start, end } of targets.reverse()) {
    spliceProcessed(state, start, end, `\`${state.sql.slice(start, end)}\``);
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
  stripTrailingFunctionClauses(state);
  rewriteCastTypes(state);
  normalizeSelectModifiers(state);
  expandMultiColumnUpdateSet(state);
  insertOmittedDeleteFrom(state);

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
    processedToOriginal: state.processedToOriginal,
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

function isIdentChar(ch: string | undefined): boolean {
  return ch !== undefined && /[\w$]/.test(ch);
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
  if (isIdentChar(sql[pos + 2])) return null;
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
  if (isIdentChar(sql[end])) return null;
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
  };
}
