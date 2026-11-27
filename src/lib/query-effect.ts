import type { ConditionNode, JoinEdge, ParsedQuery, SelectColumn, SetClause, SourceSpan, TableModifier, TableRef } from './types';
import { formatJoinDisplayType } from './parser';
import { getUpdateTargetTables } from './query-utils';
import {
  analyzeFullJoinNullRejection,
  conditionTreeWithoutJoinConditions,
  effectiveInnerAnalysisByJoinId,
  formatEffectiveInnerCausePhrase,
  formatEffectiveInnerJoinScopeLine,
  isInnerLikeJoin,
  isCartesianJoin,
  type EffectiveInnerAnalysis,
  type EffectiveInnerReason,
  type FullJoinNullRejection,
} from './join-effective-inner';
import { joinConditionDisplayText } from './join-condition';
import { resolveJoinLayoutSources } from './join-graph-layout';
import { hasUnion } from './query-utils';
import { displayIdentifier, maskNonCode, readBalancedParenEnd } from './sql-lex';

export type EffectAction = 'select' | 'update' | 'delete';

export type EffectLineKind = 'target' | 'scope' | 'filter' | 'aggregate' | 'change' | 'info';

export type ConditionEffectType = 'and' | 'or' | 'not' | 'leaf' | 'join';

export interface ConditionEffectNode {
  id: string;
  type: ConditionEffectType;
  label?: string;
  text?: string;
  sourceSpan?: SourceSpan;
  children?: ConditionEffectNode[];
}

export interface TablePresenceJoin {
  type: string;
  condition: ConditionEffectNode;
}

export interface TablePresenceEntry {
  tableLabel: string;
  tableSourceSpan?: SourceSpan;
  join?: TablePresenceJoin;
}

export interface TablePresenceGroup {
  label: string;
  kind: 'required' | 'optional';
  entries: TablePresenceEntry[];
}

export interface EffectLine {
  text: string;
  sourceSpan?: SourceSpan;
  /** 集約セクションの GROUP BY 見出し（クリック不可・ラベル表示） */
  aggregateLabel?: boolean;
  /** 集約セクションで GROUP BY 配下の列としてインデント表示 */
  aggregateIndent?: boolean;
}

export interface QueryEffectFilterPart {
  label: string;
  root: ConditionEffectNode;
}

export interface QueryEffectSection {
  kind: EffectLineKind;
  title?: string;
  lines?: EffectLine[];
  presenceGroups?: TablePresenceGroup[];
  /** 行の絞り込み: 結合条件と WHERE を分けて表示 */
  filterParts?: QueryEffectFilterPart[];
  conditionRoot?: ConditionEffectNode;
}

export type QueryEffectMode = 'sql' | 'japanese';

export interface QueryEffect {
  action: EffectAction;
  actionLabel: string;
  headline: string;
  summary: string;
  sections: QueryEffectSection[];
}

/**
 * 集約関数の呼び出し（Oracle Database 23 SQL Language Reference「Aggregate Functions」の主なもの）。
 * LISTAGG の WITHIN GROUP と KEEP は前処理で取り除くので、ここでは名前と括弧だけを見る
 */
const AGGREGATE_CALL_RE =
  /(?<![\w$#.`"\u0080-\uFFFF])(?:COUNT|SUM|AVG|MIN|MAX|STDDEV|STDDEV_POP|STDDEV_SAMP|VARIANCE|VAR_POP|VAR_SAMP|MEDIAN|LISTAGG|COLLECT|CORR|COVAR_POP|COVAR_SAMP|REGR_\w+|APPROX_COUNT_DISTINCT|ANY_VALUE)\s*\(/giu;
const COUNT_DISTINCT_PATTERN = /(?<![\w$#.`"\u0080-\uFFFF])COUNT\s*\(\s*DISTINCT\b/iu;

/**
 * 行をグループにまとめる集約関数を含むか。OVER の付く呼び出しは分析関数で、行をまとめずに各行へ値を付けるので数えない。
 * 文字列リテラルの中の `SUM(` は関数ではないので、maskNonCode で隠してから探す
 */
function hasGroupingAggregate(col: SelectColumn): boolean {
  const masked = maskNonCode(col.expression);
  for (const match of masked.matchAll(AGGREGATE_CALL_RE)) {
    let callEnd = readBalancedParenEnd(masked, match.index + match[0].length - 1);
    // `LISTAGG(…) WITHIN GROUP (…) OVER (…)` や `MAX(…) KEEP (…) OVER (…)` は、OVER の前に句が挟まる
    const between = callEnd === null ? null : /^\s*(?:WITHIN\s+GROUP|KEEP)\s*\(/i.exec(masked.slice(callEnd));
    if (callEnd !== null && between) {
      callEnd = readBalancedParenEnd(masked, callEnd + between[0].length - 1) ?? callEnd;
    }
    if (callEnd !== null && /^\s*OVER\b/i.test(masked.slice(callEnd))) continue;
    return true;
  }
  return false;
}


function columnLabel(col: SelectColumn): string {
  return col.alias ?? col.expression;
}

function hasStarProjection(columns: SelectColumn[]): boolean {
  return columns.some((c) => c.expression === '*' || /\.\*$/.test(c.expression));
}

function formatSelectColumnSql(col: SelectColumn): string {
  return col.alias ? `${col.expression} AS ${displayIdentifier(col.alias)}` : col.expression;
}

function formatOrderByClause(query: ParsedQuery): EffectLine | null {
  if (query.orderBy.length === 0) return null;
  return {
    // ORDER SIBLINGS BY は、階層の順を保って同じ親の行どうしを並べる。SIBLINGS を落とすと結果全体の並べ替えに読める
    text: `ORDER ${query.orderSiblingsSpan ? 'SIBLINGS ' : ''}BY ${query.orderBy.map((o) => o.text).join(', ')}`,
    sourceSpan: query.orderBy[0]?.sourceSpan,
  };
}

/** FETCH FIRST n [PERCENT] ROWS ONLY | WITH TIES の表示文字列 */
function formatFetchClause(query: ParsedQuery): string {
  const unit = query.rowLimitPercent ? ' PERCENT' : '';
  const tail = query.rowLimitWithTies ? 'WITH TIES' : 'ONLY';
  return `FETCH FIRST ${query.limit}${unit} ROWS ${tail}`;
}

function formatLimitClauseLine(query: ParsedQuery): EffectLine | null {
  if (!query.limit && !query.offset) return null;

  const parts: string[] = [];
  if (query.offset != null) parts.push(`OFFSET ${query.offset} ROWS`);
  if (query.limit != null) parts.push(formatFetchClause(query));

  return {
    text: parts.join(' '),
    sourceSpan: query.rowLimitSpan ?? query.limitSpan ?? query.offsetSpan,
  };
}

function describeDistinctLineJapanese(query: ParsedQuery): string {
  if (!query.distinct) return '';

  if (query.groupBy.length > 0) {
    return 'DISTINCT — 集約後、SELECT 列の組み合わせが同じ行を1行にまとめる';
  }

  if (hasStarProjection(query.columns)) {
    return 'DISTINCT — 行全体（すべての列）が同じものを1行にまとめる';
  }

  const cols = query.columns.map(columnLabel).join(', ');
  return `DISTINCT — ${cols} の組み合わせが同じ行を1行にまとめる`;
}

/** WHERE に ROWNUM の条件があるか（サブクエリの中は見ない） */
function whereHasRownum(node: ConditionNode | undefined): boolean {
  if (!node) return false;
  if (node.isRownum) return true;
  return (node.children ?? []).some(whereHasRownum);
}

function describePostProcessLinesJapanese(query: ParsedQuery): EffectLine[] {
  const lines: EffectLine[] = [];
  const distinctLine = describeDistinctLineJapanese(query);
  if (distinctLine) lines.push({ text: distinctLine });
  if (query.orderBy.length > 0) {
    const items = query.orderBy.map((o) => orderByItemText(o.text, query)).join(', ');
    // 階層問い合わせの ORDER BY は、CONNECT BY が作った階層の順を置き換える。階層の順を保つには ORDER SIBLINGS BY を使い、
    // 同じ親の行どうしだけを並べる（Oracle Database 19c SQL Language Reference「Hierarchical Queries」: If you want to
    // order rows of siblings of the same parent, then use the ORDER SIBLINGS BY clause / ORDER BY … will override the
    // hierarchical order of the CONNECT BY results）
    const text = query.orderSiblingsSpan
      ? `並び順（ORDER SIBLINGS BY） — 階層の順を保ったまま、同じ親を持つ行どうしを ${items} の順に並べる`
      : query.hierarchical
        ? `並び順 — ${items}（階層問い合わせの階層の順は、この並び順で置き換わる。階層の順を保つなら ORDER SIBLINGS BY を使う）`
        : `並び順 — ${items}`;
    lines.push({ text, sourceSpan: query.orderBy[0]?.sourceSpan });
    // 同じ SELECT の ORDER BY は、ROWNUM で絞ったあとの行を並べ替える。並べ替えた結果の上位の行になるとは限らない
    // （Oracle Database 23 SQL Language Reference「ROWNUM Pseudocolumn」）
    if (whereHasRownum(query.where)) {
      lines.push({
        text: 'ROWNUM と ORDER BY — ORDER BY は ROWNUM で絞ったあとの行を並べ替える。残る行は、並べ替えた結果の上位の行とは限らない（上位の行を取るには、ORDER BY を書いたサブクエリの外で ROWNUM を使うか、FETCH FIRST を使う）',
        sourceSpan: query.orderBy[0]?.sourceSpan,
      });
    }
  }
  if (query.offset) {
    lines.push({
      text: `先頭スキップ — ${query.offset} 行を飛ばしてから取得`,
      sourceSpan: query.offsetSpan,
    });
  }
  if (query.limit) {
    const unit = query.rowLimitPercent ? `${query.limit}%` : `${query.limit} 行`;
    const ties = query.rowLimitWithTies ? '（WITH TIES — 同順位の行も返す）' : '';
    lines.push({
      text: query.offset
        ? `件数上限 — スキップ後最大 ${unit}${ties}`
        : `件数上限 — 最大 ${unit}${ties}`,
      sourceSpan: query.limitSpan ?? query.rowLimitSpan,
    });
  }
  return lines;
}

function describePostProcessLines(query: ParsedQuery, mode: QueryEffectMode): EffectLine[] {
  if (mode === 'japanese') return describePostProcessLinesJapanese(query);

  const lines: EffectLine[] = [];
  if (query.distinct) {
    lines.push({ text: 'DISTINCT' });
  }
  const orderBy = formatOrderByClause(query);
  if (orderBy) lines.push(orderBy);
  const limit = formatLimitClauseLine(query);
  if (limit) lines.push(limit);
  return lines;
}

function formatLimitSummary(query: ParsedQuery): string {
  const unit = query.rowLimitPercent ? `${query.limit}%` : `${query.limit} 行`;
  if (query.limit && query.offset) {
    return ` — ${query.offset} 行スキップ後最大 ${unit}`;
  }
  if (query.limit) return ` — 最大 ${unit}`;
  if (query.offset) return ` — ${query.offset} 行スキップ後`;
  return '';
}

/** ORDER BY の項目が、SELECT の列の位置（`ORDER BY 2`）なら、その列を書き添える */
function orderByItemText(item: string, query: ParsedQuery): string {
  const position = /^\s*(\d+)(?:\s+(?:ASC|DESC))?(?:\s+NULLS\s+(?:FIRST|LAST))?\s*$/i.exec(item);
  if (!position) return item;
  const column = query.columns[Number(position[1]) - 1];
  // SELECT の列の位置で並べる（Oracle Database 23 SQL Language Reference の SELECT、order_by_clause の position）
  return column ? `${item}（SELECT の ${position[1]} 列目: ${column.alias ?? column.expression}）` : item;
}

/**
 * GROUP BY の項目が整数なら、位置ではなく値として読む。GROUP_BY_POSITION_ENABLED（既定は FALSE。26ai から）が TRUE のときだけ、
 * SELECT の列の位置になる（Oracle Database Reference「GROUP_BY_POSITION_ENABLED」）。値として読むと、どの行も同じ値なので 1 つのグループになる
 */
function groupByPositionNote(query: ParsedQuery): string {
  const position = query.groupBy.find((g) => /^\s*\d+\s*$/.test(g.text));
  if (!position) return '';
  const n = position.text.trim();
  return `（GROUP BY の ${n} は、既定では列の位置ではなく数値の ${n} として読むので、ほかに列が無ければすべての行が 1 つのグループになる。GROUP_BY_POSITION_ENABLED を TRUE にすると、SELECT の ${n} 列目でまとめる）`;
}

function describeAggregateLinesJapanese(query: ParsedQuery): EffectLine[] {
  if (query.statementType !== 'SELECT') return [];

  const aggregateCols = query.columns.filter(hasGroupingAggregate);
  const countDistinctCols = query.columns.filter((c) => COUNT_DISTINCT_PATTERN.test(c.expression));
  const lines: EffectLine[] = [];

  if (query.groupBy.length > 0) {
    lines.push({
      text: `${query.groupBy.map((g) => g.text).join(', ')} ごとに集約 — 1グループ = 結果の1行${groupByPositionNote(query)}`,
      sourceSpan: query.groupBy[0]?.sourceSpan,
    });
    // ROLLUP と CUBE は、グループごとの行に加えて小計の行を作る。書かないと、結果の行がグループの数より多い理由が分からない
    // （Oracle Database 23 Data Warehousing Guide「SQL for Aggregation in Data Warehouses」）。
    // `GROUP BY a, ROLLUP (b)` のように外にも列があると、小計は a ごとに作り、総計の行は作らない
    const subtotalKind = (g: { text: string }) => /^\s*(ROLLUP|CUBE)\s*\(/i.exec(g.text)?.[1]?.toUpperCase();
    const withGrandTotal = query.groupBy.every((g) => subtotalKind(g));
    for (const g of query.groupBy) {
      const kind = subtotalKind(g);
      if (!kind) continue;
      const subtotals = kind === 'ROLLUP' ? '列の段階ごとの小計の行' : '列のすべての組み合わせごとの小計の行';
      lines.push({
        text: withGrandTotal
          ? `${kind} — ${subtotals}と、総計の行も加わる`
          : `${kind} — ${subtotals}も加わる（${kind} の外の列ごとに作り、総計の行は作らない）`,
        sourceSpan: g.sourceSpan,
      });
    }
  } else if (aggregateCols.length > 0) {
    lines.push({ text: '集約関数のみ — 全体を1グループとして計算（結果は最大1行）' });
  }

  for (const col of countDistinctCols) {
    lines.push({
      text: `${columnLabel(col)} — 重複値を除いて数える（COUNT DISTINCT）`,
      sourceSpan: col.sourceSpan,
    });
  }

  return lines;
}

function describeAggregateLines(query: ParsedQuery, mode: QueryEffectMode): EffectLine[] {
  if (mode === 'japanese') return describeAggregateLinesJapanese(query);

  if (query.statementType !== 'SELECT') return [];

  const lines: EffectLine[] = [];

  if (query.groupBy.length > 0) {
    lines.push({ text: 'GROUP BY', aggregateLabel: true });
    for (const g of query.groupBy) {
      lines.push({ text: g.text, sourceSpan: g.sourceSpan, aggregateIndent: true });
    }
  }

  const aggregateCols = query.columns.filter(hasGroupingAggregate);
  for (const col of aggregateCols) {
    lines.push({
      text: formatSelectColumnSql(col),
      sourceSpan: col.sourceSpan,
    });
  }

  return lines;
}

function describeUnionCombination(query: ParsedQuery): string[] {
  if (!query.unionBranches || query.unionBranches.length < 2) return [];

  const operators = query.unionBranches
    .slice(1)
    .map((b) => b.operator ?? 'UNION')
    .filter((op, i, arr) => arr.indexOf(op) === i);

  if (operators.length === 1 && operators[0] === 'UNION ALL') {
    return ['UNION ALL — 各 SELECT の結果をそのまま縦に連結（重複も残る）'];
  }
  if (operators.length === 1 && operators[0] === 'UNION') {
    return ['UNION — 各 SELECT の結果を縦に連結し、完全に同じ行は1行にまとめる'];
  }

  // MINUS と INTERSECT は連結ではない。UNION と同じ説明にすると、行を除く・絞る演算が行を足す演算に見える。
  // 集合演算子の優先順位はどれも同じで、括弧が無ければ上から順に評価する
  // （Oracle Database 23 SQL Language Reference「The UNION [ALL], INTERSECT, MINUS Operators」）
  const notes = operators.map((op) => SET_OPERATOR_NOTES[op] ?? `${op} — 集合演算で前の結果と組み合わせる`);
  return operators.length > 1 ? [...notes, '集合演算は、括弧が無ければ上から順に適用される'] : notes;
}

/** 集合演算子ごとの説明。MINUS と INTERSECT は、重複の無い行を返す */
const SET_OPERATOR_NOTES: Record<string, string> = {
  'UNION ALL': 'UNION ALL — 前の結果に、この SELECT の結果をそのまま縦に連結（重複も残る）',
  UNION: 'UNION — 前の結果に、この SELECT の結果を縦に連結し、完全に同じ行は1行にまとめる',
  MINUS: 'MINUS — 前の結果から、この SELECT の結果にもある行を除く（残った行の重複は1行にまとめる）',
  EXCEPT: 'EXCEPT — 前の結果から、この SELECT の結果にもある行を除く（残った行の重複は1行にまとめる）',
  INTERSECT: 'INTERSECT — 前の結果とこの SELECT の結果の両方にある行だけを残す（重複は1行にまとめる）',
};

const JOIN_SCOPE: Record<string, (left: string, right: string, condition: string) => string> = {
  'INNER JOIN': (l, r, c) =>
    `${l} と ${r} を INNER JOIN — 結合条件「${c}」を満たす組み合わせのみ残る`,
  JOIN: (l, r, c) => `${l} と ${r} を JOIN — 結合条件「${c}」を満たす組み合わせのみ残る`,
  'STRAIGHT JOIN': (l, r, c) =>
    `${l} と ${r} を STRAIGHT JOIN — 結合条件「${c}」を満たす組み合わせのみ残る（FROM 句の記述順で結合）`,
  'LEFT JOIN': (l, r, c) =>
    `${l} の行をすべて残し ${r} を LEFT JOIN — 結合条件「${c}」（${r} が無くても ${l} は残る）`,
  'RIGHT JOIN': (l, r, c) =>
    `${r} の行をすべて残し ${l} を RIGHT JOIN — 結合条件「${c}」`,
  'FULL JOIN': (l, r, c) => `${l} と ${r} を FULL JOIN — 結合条件「${c}」（相手が無くても、${l} と ${r} の行がどちらも残る）`,
  'CROSS JOIN': (l, r, c) =>
    `${l} と ${r} を CROSS JOIN — 結合条件「${c}」を満たす組み合わせのみ残る`,
};

/**
 * WHERE などで片側または両側の NULL の行が除かれる FULL JOIN の文。除かれない FULL JOIN は JOIN_SCOPE の文を使う。
 * `a FULL JOIN b ON … WHERE a.x > 0` は、a の無い行が除かれて a LEFT JOIN b と同じ行になる
 */
function describeNullRejectedFullJoin(
  left: string,
  right: string,
  condition: string,
  rejection: FullJoinNullRejection,
): string {
  const c = joinConditionDisplayText(condition);
  const sqlSide = `SQL 上は FULL JOIN（相手が無くても ${left} と ${right} の行がどちらも残る）だが`;
  if (rejection.leftRejected && rejection.rightRejected) {
    const cause = formatEffectiveInnerCausePhrase([...rejection.leftReasons, ...rejection.rightReasons]);
    return `${left} と ${right} は実質 INNER JOIN — 結合条件「${c}」を満たす組み合わせのみ残る。${sqlSide}、${cause} ${left} が無い行も ${right} が無い行も除外される`;
  }
  if (rejection.leftRejected) {
    const cause = formatEffectiveInnerCausePhrase(rejection.leftReasons);
    return `${left} と ${right} は実質 LEFT JOIN — 結合条件「${c}」（${right} が無くても ${left} は残る）。${sqlSide}、${cause} ${left} が無い行は除外される`;
  }
  const cause = formatEffectiveInnerCausePhrase(rejection.rightReasons);
  return `${left} と ${right} は実質 RIGHT JOIN — 結合条件「${c}」（${left} が無くても ${right} は残る）。${sqlSide}、${cause} ${right} が無い行は除外される`;
}

const MULTI_SOURCE_JOIN_SCOPE: Record<string, (sources: string, target: string, condition: string) => string> = {
  'INNER JOIN': (s, r, c) =>
    `${s} と ${r} を INNER JOIN — 結合条件「${c}」を満たす組み合わせのみ残る`,
  JOIN: (s, r, c) => `${s} と ${r} を JOIN — 結合条件「${c}」を満たす組み合わせのみ残る`,
  'STRAIGHT JOIN': (s, r, c) =>
    `${s} と ${r} を STRAIGHT JOIN — 結合条件「${c}」を満たす組み合わせのみ残る（FROM 句の記述順で結合）`,
  'LEFT JOIN': (s, r, c) =>
    `${s} を基点に ${r} を LEFT JOIN — 結合条件「${c}」（${r} が無い組み合わせも LEFT 側は残る）`,
  'RIGHT JOIN': (s, r, c) =>
    `${r} を基点に ${s} を RIGHT JOIN — 結合条件「${c}」`,
  'FULL JOIN': (s, r, c) => `${s} と ${r} を FULL JOIN — 結合条件「${c}」（相手が無くても、${s} と ${r} の行がどちらも残る）`,
  'CROSS JOIN': (s, r, c) =>
    `${s} と ${r} を CROSS JOIN — 結合条件「${c}」を満たす組み合わせのみ残る`,
};

const ACTION_LABELS: Record<ParsedQuery['statementType'], { action: EffectAction; label: string; verb: string }> = {
  SELECT: { action: 'select', label: '表示', verb: '表示される' },
  UPDATE: { action: 'update', label: '更新', verb: '更新される' },
  DELETE: { action: 'delete', label: '削除', verb: '削除される' },
};

function derivedTableLabelAlreadyPresent(name: string): boolean {
  return /派生テーブル/.test(name);
}

function tablePrimaryName(table: TableRef): string {
  // WITH で定義した CTE も、解析結果では派生テーブル（isDerived）として持つ。ほかの欄と同じく「r（CTE）」と書き、派生テーブルと書かない
  if (table.displayName.includes('（CTE）')) return table.displayName;
  if (table.isDerived) {
    const base = table.alias || table.table;
    return derivedTableLabelAlreadyPresent(base) ? base : `${base}（派生テーブル）`;
  }
  // schema 付きの表は schema も書く。対象テーブルの欄（displayName）と同じ名前にする
  const physical = table.schema ? `${table.schema}.${table.table}` : table.table;
  if (table.alias && table.alias !== table.table) {
    return `${physical}（${table.alias}）`;
  }
  return physical;
}

function tableRefByName(tables: TableRef[], name: string): TableRef | undefined {
  return tables.find((t) => t.alias === name || t.table === name || t.displayName === name);
}

function formatSummaryTableList(tables: TableRef[], multiSuffix = ''): string {
  if (tables.length === 0) return 'テーブル';
  const names = tables.map((t) => tablePrimaryName(t));
  if (names.length === 1) return names[0]!;
  if (names.length === 2) return `${names[0]} と ${names[1]}`;
  return `${names[0]} など ${names.length} テーブル${multiSuffix}`;
}

function deleteTargetTables(query: ParsedQuery): TableRef[] {
  if (!query.deleteTargets?.length) return [];
  const tables: TableRef[] = [];
  const seen = new Set<string>();
  for (const target of query.deleteTargets) {
    const table = tableRefByName(query.tables, target.name);
    if (table && !seen.has(table.id)) {
      seen.add(table.id);
      tables.push(table);
    }
  }
  // `DELETE FROM (SELECT …) WHERE …` の対象のインラインビューは名前を持たないので、名前で探せない。テーブルが 1 つならそれが対象
  if (tables.length === 0 && query.tables.length === 1) return [query.tables[0]!];
  return tables;
}

function updatedTargetTables(query: ParsedQuery): TableRef[] {
  return getUpdateTargetTables(query);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function tableQualifierPrefixes(table: TableRef): string[] {
  const prefixes = new Set<string>();
  if (table.alias) prefixes.add(table.alias);
  if (!table.isDerived) {
    if (table.schema) prefixes.add(`${table.schema}.${table.table}`);
    prefixes.add(table.table);
  }
  return [...prefixes];
}

function replaceTableQualifiersInExpression(expression: string, tables: TableRef[]): string {
  let result = expression;
  const replacements = tables
    .flatMap((table) =>
      tableQualifierPrefixes(table).map((prefix) => ({
        prefix,
        label: tablePrimaryName(table),
      })),
    )
    .sort((a, b) => b.prefix.length - a.prefix.length);

  for (const { prefix, label } of replacements) {
    const qualified = new RegExp(`(?<![\\w.])${escapeRegExp(prefix)}\\.`, 'g');
    result = result.replace(qualified, `${label}.`);
  }
  return result;
}

function formatSelectColumnLine(col: SelectColumn, tables: TableRef[]): string {
  const expression = replaceTableQualifiersInExpression(col.expression, tables);
  if (col.expression === '*') return '*（すべての列）';
  return col.alias ? `${expression} AS ${displayIdentifier(col.alias)}` : expression;
}

function formatSetClauseLine(set: SetClause, tables: TableRef[]): string {
  if (set.table) {
    const table = tableRefByName(tables, set.table);
    const tableName = table ? tablePrimaryName(table) : set.table;
    return `${tableName}.${set.column} = ${set.value}`;
  }
  return set.label;
}

function describeOperationTarget(query: ParsedQuery): QueryEffectSection | null {
  if (query.statementType === 'SELECT') {
    if (query.columns.length === 0) return null;
    return {
      kind: 'target',
      title: '表示対象',
      lines: query.columns.map((col) => ({
        text: formatSelectColumnLine(col, query.tables),
        sourceSpan: col.sourceSpan,
      })),
    };
  }

  if (query.statementType === 'UPDATE') {
    if (!query.setClauses?.length) return null;
    return {
      kind: 'target',
      title: '更新対象',
      lines: query.setClauses.map((set) => ({ text: formatSetClauseLine(set, query.tables) })),
    };
  }

  if (query.statementType === 'DELETE') {
    const targets = deleteTargetTables(query);
    const tables = targets.length > 0 ? targets : query.tables.filter((t) => !t.isDerived);
    if (tables.length === 0) return null;
    return {
      kind: 'target',
      title: '削除対象',
      lines: tables.map((t) => ({ text: tablePrimaryName(t), sourceSpan: t.sourceSpan })),
    };
  }

  return null;
}

/**
 * 対象テーブル欄の起点のテーブル。別名を付けたテーブルは、要約や参加テーブルの欄と同じく「users（u）」と書く。
 * 別名だけ（「u の行」）だと、要約の「users（u） の行」と別のテーブルに見える
 */
function scopeTableLabel(table: TableRef): string {
  if (!table.isDerived && table.alias && table.alias !== table.table) return tablePrimaryName(table);
  return tableLabel(table);
}

function tableLabel(table: TableRef): string {
  if (table.displayName.includes('（CTE）')) return table.displayName;
  if (table.isDerived) {
    return derivedTableLabelAlreadyPresent(table.displayName)
      ? table.displayName
      : `${table.displayName}（派生テーブル）`;
  }
  return table.displayName;
}

function mergeSameTypeGroups(
  nodes: ConditionEffectNode[],
  type: 'and' | 'or',
): ConditionEffectNode[] {
  return nodes.flatMap((node) => {
    if (node.type === type && node.children) {
      return node.children;
    }
    return [node];
  });
}

function tableName(_join: JoinEdge, tables: TableRef[], id: string): string {
  const t = tables.find((x) => x.id === id);
  return t ? tableLabel(t) : id;
}

function joinSourceLabels(join: JoinEdge, tables: TableRef[]): string[] {
  return resolveJoinLayoutSources(join, tables).map((id) => tableName(join, tables, id));
}

export interface TablePresenceClassification {
  required: TableRef[];
  optional: TableRef[];
  /** 外部結合だが実質 INNER となり必須側に含まれるテーブル id */
  effectiveInnerTableIds: Set<string>;
}

function tableIndexInFrom(query: ParsedQuery, tableId: string): number {
  return query.tables.findIndex((t) => t.id === tableId);
}

function markRightJoinLeftSideOptional(
  query: ParsedQuery,
  join: JoinEdge,
  requiredIds: Set<string>,
  optionalIds: Set<string>,
): void {
  const targetIdx = tableIndexInFrom(query, join.targetId);
  if (targetIdx < 0) return;

  for (const table of query.tables) {
    if (tableIndexInFrom(query, table.id) >= targetIdx) continue;
    optionalIds.add(table.id);
    requiredIds.delete(table.id);
  }
}

/**
 * 必須テーブルから INNER / LEFT JOIN 経由の上流を辿る。
 * RIGHT JOIN 実質 INNER 時の seed 復元専用 — ON が中間表を経由する場合に b 等を落とさない。
 */
function expandRequiredUpstreamTables(
  query: ParsedQuery,
  tableId: string,
  visited = new Set<string>(),
): Set<string> {
  const upstream = new Set<string>();
  if (visited.has(tableId)) return upstream;
  visited.add(tableId);

  for (const join of query.joins) {
    if (join.targetId !== tableId) continue;
    if (!isInnerLikeJoin(join) && join.type !== 'LEFT JOIN') continue;

    const sourceIds = new Set<string>(resolveJoinLayoutSources(join, query.tables));
    if (join.sourceId && join.sourceId !== tableId) {
      sourceIds.add(join.sourceId);
    }

    for (const sourceId of sourceIds) {
      if (sourceId === tableId) continue;
      upstream.add(sourceId);
      for (const nested of expandRequiredUpstreamTables(query, sourceId, visited)) {
        upstream.add(nested);
      }
    }
  }

  return upstream;
}

/** JOIN 種別と実質 INNER から、結果行にレコードが必須か任意かを分類 */
export function classifyTablePresenceRequirement(query: ParsedQuery): TablePresenceClassification {
  const effectiveInnerByJoin = effectiveInnerAnalysisByJoinId(query);
  const fullJoinRejection = analyzeFullJoinNullRejection(query);
  const requiredIds = new Set<string>();
  const optionalIds = new Set<string>();
  const effectiveInnerTableIds = new Set<string>();

  if (query.tables.length === 0) {
    return { required: [], optional: [], effectiveInnerTableIds };
  }

  requiredIds.add(query.tables[0]!.id);

  for (const join of query.joins) {
    const analysis = effectiveInnerByJoin.get(join.id);
    const effectiveInner = Boolean(analysis && analysis.reasons.length > 0);
    const sourceIds = resolveJoinLayoutSources(join, query.tables);

    if (isInnerLikeJoin(join)) {
      requiredIds.add(join.targetId);
      for (const id of sourceIds) requiredIds.add(id);
      optionalIds.delete(join.targetId);
    } else if (join.type === 'LEFT JOIN') {
      if (effectiveInner) {
        requiredIds.add(join.targetId);
        optionalIds.delete(join.targetId);
        effectiveInnerTableIds.add(join.targetId);
      } else {
        optionalIds.add(join.targetId);
      }
    } else if (join.type === 'RIGHT JOIN') {
      requiredIds.add(join.targetId);
      optionalIds.delete(join.targetId);
      if (effectiveInner && analysis) {
        const rejectedIds = analysis.nullableTableIds;
        const seedIds = new Set<string>([...sourceIds, ...rejectedIds]);
        for (const id of rejectedIds) {
          effectiveInnerTableIds.add(id);
        }
        for (const id of seedIds) {
          requiredIds.add(id);
          optionalIds.delete(id);
          for (const upstream of expandRequiredUpstreamTables(query, id)) {
            requiredIds.add(upstream);
            optionalIds.delete(upstream);
          }
        }
      } else {
        markRightJoinLeftSideOptional(query, join, requiredIds, optionalIds);
      }
    } else if (join.type === 'FULL JOIN') {
      // FULL JOIN は、相手の無い行を両側とも残す。左側（結合先より前の表すべて）も結合先も、行が無いことがある。
      // ただし WHERE などがその側の NULL の行を除くなら、その側の行は必ずある（analyzeFullJoinNullRejection）
      const rejection = fullJoinRejection.get(join.id);
      if (rejection?.rightRejected) {
        requiredIds.add(join.targetId);
        optionalIds.delete(join.targetId);
      } else {
        optionalIds.add(join.targetId);
      }
      if (!rejection?.leftRejected) {
        const targetIdx = query.tables.findIndex((t) => t.id === join.targetId);
        for (const table of query.tables.slice(0, Math.max(targetIdx, 0))) {
          requiredIds.delete(table.id);
          optionalIds.add(table.id);
        }
      }
    } else if (join.type === 'CROSS JOIN') {
      // ON / USING 付きは isInnerLikeJoin 側。ここは直積（ON なし）のみ
      requiredIds.add(join.targetId);
    }
  }

  for (const id of requiredIds) optionalIds.delete(id);

  return {
    required: query.tables.filter((t) => requiredIds.has(t.id)),
    optional: query.tables.filter((t) => optionalIds.has(t.id)),
    effectiveInnerTableIds,
  };
}

function tablePresenceLabel(table: TableRef): string {
  if (table.isDerived) return tableLabel(table);
  return tablePrimaryName(table);
}

function formatTableNameForPresence(
  table: TableRef,
  classification: TablePresenceClassification,
  markEffectiveInner: boolean,
): string {
  const name = tablePresenceLabel(table);
  if (markEffectiveInner && classification.effectiveInnerTableIds.has(table.id)) {
    return `${name}（実質 INNER JOIN）`;
  }
  return name;
}

function buildTablePresenceGroups(
  classification: TablePresenceClassification,
  mode: QueryEffectMode,
): TablePresenceGroup[] {
  const requiredLabel = mode === 'japanese' ? PRESENCE_REQUIRED_LABEL_JA : PRESENCE_REQUIRED_LABEL;
  const optionalLabel = mode === 'japanese' ? PRESENCE_OPTIONAL_LABEL_JA : PRESENCE_OPTIONAL_LABEL;

  return [
    {
      label: requiredLabel,
      kind: 'required',
      entries: classification.required.map((t) => ({
        tableLabel: formatTableNameForPresence(t, classification, true),
        tableSourceSpan: t.sourceSpan,
      })),
    },
    {
      label: optionalLabel,
      kind: 'optional',
      entries: classification.optional.map((t) => ({
        tableLabel: formatTableNameForPresence(t, classification, false),
        tableSourceSpan: t.sourceSpan,
      })),
    },
  ];
}

function describeJoinJapanese(
  join: JoinEdge,
  tables: TableRef[],
  effectiveInner?: { nullableTable: TableRef; reasons: EffectiveInnerReason[] },
  fullJoinRejection?: FullJoinNullRejection,
): string {
  const sourceLabels = joinSourceLabels(join, tables);
  const sourcesText = sourceLabels.join('、');
  const right = tableName(join, tables, join.targetId);
  const left = sourceLabels.length === 1 ? sourceLabels[0]! : sourcesText;
  // 文面は結合の意味で選ぶ。`LEFT JOIN（(+)）` や `NATURAL LEFT JOIN` のような装飾付き表示名で
  // 引くと JOIN_SCOPE に載らず汎用 JOIN 文へ落ち、「左側は残る」という外部結合の意味が消える
  const joinType = join.type;
  const condition = join.condition;

  if (join.type === 'FULL JOIN' && (fullJoinRejection?.leftRejected || fullJoinRejection?.rightRejected)) {
    return describeNullRejectedFullJoin(left, right, condition, fullJoinRejection);
  }

  if (effectiveInner) {
    const preservedLabel = join.type === 'LEFT JOIN' ? left : right;
    return formatEffectiveInnerJoinScopeLine(join, preservedLabel, effectiveInner.nullableTable, effectiveInner.reasons);
  }

  // ON / USING の無い結合（CROSS JOIN とカンマ結合）は、すべての行の組み合わせを作る。
  // 「結合条件を満たす組み合わせのみ残る」と書くと、条件があるように読める
  if (isCartesianJoin(join)) {
    // LATERAL のインラインビューは、FROM 句で左にある表の列を参照できる（SQL Language Reference の SELECT の LATERAL。
    // ページの文は要約でしか確かめていない）。左の表の行ごとに作るので、どの行とも組み合わせる直積とは読めない
    if (tables.find((t) => t.id === join.targetId)?.isLateral) {
      return `${left} の行ごとに ${right} を作って組み合わせる（LATERAL — ${right} は左にある表の列を参照できる）`;
    }
    return `${left} と ${right} の直積（すべての組み合わせ）`;
  }

  if (sourceLabels.length > 1) {
    const fn = MULTI_SOURCE_JOIN_SCOPE[joinType] ?? MULTI_SOURCE_JOIN_SCOPE.JOIN;
    return fn(sourcesText, right, condition);
  }

  const fn = JOIN_SCOPE[joinType] ?? JOIN_SCOPE.JOIN;
  return fn(left, right, condition);
}

function crossJoinPhrase(join: JoinEdge, tables: TableRef[]): string {
  const sourceLabels = joinSourceLabels(join, tables);
  const right = tableName(join, tables, join.targetId);
  const left = sourceLabels.length === 1 ? sourceLabels[0]! : sourceLabels.join('、');
  if (tables.find((t) => t.id === join.targetId)?.isLateral) {
    return `LATERAL — ${left} の行ごとに ${right} を作って組み合わせる`;
  }
  if (join.type === 'CROSS JOIN') return `CROSS JOIN — ${left} と ${right} のすべての組み合わせ`;
  return `${formatJoinDisplayType(join)} — ${left} と ${right} のすべての組み合わせ（結合条件が無いので CROSS JOIN と同じ）`;
}

/** 値の一覧（`(1, NULL)`）に NULL が書かれているか。文字列の中の NULL は数えない */
function listContainsNullLiteral(label: string): boolean {
  const masked = maskNonCode(label);
  const inList = /\bIN\s*\(/i.exec(masked);
  if (!inList) return false;
  const open = inList.index + inList[0].length - 1;
  const close = readBalancedParenEnd(masked, open);
  if (close === null) return false;
  // 一覧の中の括弧（`NVL(x, NULL)` のような関数の引数）は、一覧の値ではないので伏せる
  let items = masked.slice(open + 1, close - 1);
  for (let previous = ''; previous !== items; ) {
    previous = items;
    items = items.replace(/\([^()]*\)/g, (group) => ' '.repeat(group.length));
  }
  return /(?:^|,)\s*NULL\s*(?:,|$)/i.test(items);
}

function inConditionPhrase(node: ConditionNode): string {
  const isNotIn = node.operator === 'NOT IN' || /\bNOT\s+IN\b/i.test(node.label);

  // NOT IN の相手に NULL が 1 つでもあると、比べた結果が真にならず、どの行も残らない。見落としやすいので書き添える
  // （Oracle Database 23 SQL Language Reference「IN Condition」）
  if (node.nestedQuery) {
    const prefix = isNotIn
      ? '別の SELECT が返した値のどれとも一致しない（その値に NULL が 1 つでもあると、どの行も残らない）'
      : '別の SELECT が返した値のどれかと一致';
    return `${prefix} — ${node.label}`;
  }

  if (isNotIn && listContainsNullLiteral(node.label)) {
    return `次の値のどれとも一致しない（一覧に NULL があるので、どの行も残らない） — ${node.label}`;
  }
  const prefix = isNotIn ? '次の値のどれとも一致しない' : '次の値のどれかと一致';
  return `${prefix} — ${node.label}`;
}

/** NULL と比べる比較演算子 */
const NULL_COMPARISON_OPERATORS = new Set(['=', '<>', '!=', '^=', '<', '>', '<=', '>=']);

/**
 * `x = NULL` のように NULL と比べる条件。結果は UNKNOWN になり、どの行でも真にならない。
 * NULL かどうかは IS NULL / IS NOT NULL で調べる（Oracle Database 23 SQL Language Reference「Nulls」）
 */
function comparesWithNullLiteral(node: ConditionNode): boolean {
  if (!NULL_COMPARISON_OPERATORS.has(node.operator ?? '')) return false;
  return /^NULL$/i.test(node.left?.trim() ?? '') || /^NULL$/i.test(node.right?.trim() ?? '');
}

/**
 * ROWNUM と数値を比べる条件が、件数をどう絞るか。
 * - never: どの行も満たさない。ROWNUM は条件を満たして残った行に 1 から振るので、最初の行は 1 になり、
 *   1 のときに偽になる条件ではじかれると、次の行もまた 1 になってはじかれ続ける
 *   （Oracle Database 19c SQL Language Reference「ROWNUM Pseudocolumn」: The first row fetched is assigned a
 *   ROWNUM of 1 and makes the condition false. The second row to be fetched is now the first row and is also
 *   assigned a ROWNUM of 1 …）。ページの例は `ROWNUM > 1` だが、`ROWNUM = 2` や `ROWNUM < 1` も同じ仕組みで偽になる
 * - always: どの行も満たす。ROWNUM は 1 から振る番号なので、`ROWNUM >= 1` や `ROWNUM > 0` は件数を絞らない
 * - limit: 先頭の何件かだけを残す
 */
function rownumComparisonKind(node: ConditionNode): 'never' | 'always' | 'limit' {
  const left = node.left?.trim().toUpperCase();
  const right = node.right?.trim().toUpperCase();
  const op = (node.operator ?? '').replace('^=', '<>').replace('!=', '<>');
  const flipped: Record<string, string> = { '<': '>', '<=': '>=', '>': '<', '>=': '<=', '=': '=', '<>': '<>' };
  const [operator, value] =
    left === 'ROWNUM' ? [op, right] : right === 'ROWNUM' ? [flipped[op] ?? '', left] : ['', undefined];
  if (!value || !/^\d+(?:\.\d+)?$/.test(value) || !(operator in flipped)) return 'limit';
  const c = Number(value);
  const holds = (n: number): boolean =>
    operator === '<' ? n < c : operator === '<=' ? n <= c : operator === '>' ? n > c : operator === '>=' ? n >= c : operator === '=' ? n === c : n !== c;
  if (!holds(1)) return 'never';
  if (operator === '>' || operator === '>=') return 'always';
  if (operator === '<>' && !(Number.isInteger(c) && c >= 1)) return 'always';
  return 'limit';
}

function conditionPhrase(node: ConditionNode, mode: QueryEffectMode): string {
  if (mode === 'sql') return node.label;
  if (node.isRownum) {
    const kind = rownumComparisonKind(node);
    if (kind === 'never') {
      return `どの行も満たさない（ROWNUM は残った行に 1 から振るので、ROWNUM が 1 のときに偽になる条件は、次の行でも 1 のまま偽になる） — ${node.label}`;
    }
    if (kind === 'always') {
      return `件数を絞らない（ROWNUM は 1 から振る番号なので、どの行も満たす） — ${node.label}`;
    }
    return `行番号（ROWNUM）で件数を絞る — ${node.label}`;
  }

  switch (node.type) {
    case 'exists': {
      const isNotExists = /\bNOT\s+EXISTS\b/i.test(node.label);
      const prefix = isNotExists ? '関連行が存在しないものだけ' : '関連行が存在するものだけ';
      return `${prefix} — ${node.label}`;
    }
    case 'in':
      return inConditionPhrase(node);
    case 'like':
      return `パターン一致 — ${node.label}`;
    // NOT BETWEEN は範囲の外の行を残す。否定を見ずに「範囲内」と書くと逆の意味の説明になる
    case 'between':
      return `${/\bNOT\b/i.test(node.operator ?? '') ? '範囲外' : '範囲内'} — ${node.label}`;
    default:
      // NOT LIKE は、パーサーが LIKE とは別の比較として返す
      if (/^NOT\s+LIKE$/i.test(node.operator ?? '')) return `パターンに一致しない — ${node.label}`;
      if (comparesWithNullLiteral(node)) {
        return `NULL と比べた結果は真にならない（NULL かどうかは IS NULL / IS NOT NULL で調べる） — ${node.label}`;
      }
      return node.label;
  }
}

/** WHERE / HAVING を AND / OR / NOT の入れ子ツリーに変換 */
export function buildConditionEffectTree(
  node: ConditionNode,
  mode: QueryEffectMode = 'sql',
): ConditionEffectNode {
  if (node.type === 'and' && node.children?.length) {
    if (node.children.length === 1) {
      return buildConditionEffectTree(node.children[0]!, mode);
    }
    return {
      id: node.id,
      type: 'and',
      label: 'すべて満たす（AND）',
      children: mergeSameTypeGroups(node.children.map((child) => buildConditionEffectTree(child, mode)), 'and'),
    };
  }
  if (node.type === 'or' && node.children?.length) {
    if (node.children.length === 1) {
      return buildConditionEffectTree(node.children[0]!, mode);
    }
    return {
      id: node.id,
      type: 'or',
      label: 'いずれかを満たす（OR）',
      children: mergeSameTypeGroups(node.children.map((child) => buildConditionEffectTree(child, mode)), 'or'),
    };
  }
  if (node.type === 'not') {
    const inner = node.children?.[0];
    return {
      id: node.id,
      type: 'not',
      label: '除外（NOT）',
      children: inner ? [buildConditionEffectTree(inner, mode)] : [],
    };
  }
  return {
    id: node.id,
    type: 'leaf',
    text: conditionPhrase(node, mode),
    sourceSpan: node.sourceSpan,
  };
}

export function collectLeafTexts(node: ConditionEffectNode): string[] {
  if (node.type === 'join') {
    const header = node.label ? [node.label] : [];
    return [...header, ...(node.children ?? []).flatMap(collectLeafTexts)];
  }
  if (node.type === 'leaf') return node.text ? [node.text] : [];
  return (node.children ?? []).flatMap(collectLeafTexts);
}

/** 結合条件ブロック（JOIN 種別 + ON 句）を抽出 */
export function collectJoinFilterNodes(root: ConditionEffectNode): ConditionEffectNode[] {
  if (root.type === 'join') return [root];
  if (root.type === 'and' || root.type === 'or' || root.type === 'not') {
    return (root.children ?? []).flatMap(collectJoinFilterNodes);
  }
  return [];
}

function effectiveInnerForJoin(
  join: JoinEdge,
  query: ParsedQuery,
  effectiveInnerByJoin: Map<string, EffectiveInnerAnalysis>,
): { nullableTable: TableRef; reasons: EffectiveInnerReason[] } | undefined {
  const analysis = effectiveInnerByJoin.get(join.id);
  if (!analysis || analysis.reasons.length === 0) return undefined;

  const nullableId =
    analysis.nullableTableIds[0] ??
    (join.type === 'LEFT JOIN' ? join.targetId : join.sourceId);
  const nullableTable = query.tables.find((t) => t.id === nullableId);
  if (!nullableTable) return undefined;

  return { nullableTable, reasons: analysis.reasons };
}

const SCOPE_SECTION_TITLE_JOIN = '結合するテーブル';
const SCOPE_SECTION_TITLE_JOIN_JA = '検索範囲';
const SCOPE_SECTION_TITLE_SINGLE = '対象テーブル';
const PRESENCE_REQUIRED_LABEL = '必須';
const PRESENCE_REQUIRED_LABEL_JA = 'レコード必須';
const PRESENCE_OPTIONAL_LABEL = '任意（外部結合）';
const PRESENCE_OPTIONAL_LABEL_JA = 'レコード任意（外部結合）';
const ROW_FILTER_TITLE = '行の絞り込み';
const ROW_FILTER_TITLE_JA = '行の絞り込み（WHERE）';

function scopeSectionTitle(query: ParsedQuery, mode: QueryEffectMode): string {
  if (query.joins.length === 0) return SCOPE_SECTION_TITLE_SINGLE;
  return mode === 'japanese' ? SCOPE_SECTION_TITLE_JOIN_JA : SCOPE_SECTION_TITLE_JOIN;
}

function effectiveInnerCauseLabel(reasons: EffectiveInnerReason[]): string {
  if (reasons.some((r) => r.kind === 'inner_join')) {
    return '後続の結合で必須';
  }
  const parts: string[] = [];
  if (reasons.some((r) => r.kind === 'where')) parts.push('WHERE');
  if (reasons.some((r) => r.kind === 'having')) parts.push('HAVING');
  if (parts.length === 0) return '後続条件で必須';
  return `${parts.join(' / ')} で必須`;
}

function effectiveInnerFilterTag(join: JoinEdge, reasons: EffectiveInnerReason[]): string {
  return `${join.type}（実質 INNER JOIN — ${effectiveInnerCauseLabel(reasons)}）`;
}

function joinFilterHeader(
  join: JoinEdge,
  effectiveInner?: { nullableTable: TableRef; reasons: EffectiveInnerReason[] },
): string {
  if (effectiveInner) {
    return effectiveInnerFilterTag(join, effectiveInner.reasons);
  }
  const typeLabel = formatJoinDisplayType(join);
  if (!join.isNatural && (join.type === 'INNER JOIN' || join.type === 'JOIN')) {
    return 'INNER JOIN';
  }
  return typeLabel;
}

function buildJoinConditionEffectNode(join: JoinEdge, mode: QueryEffectMode): ConditionEffectNode {
  if (join.conditionRoot) {
    return buildConditionEffectTree(join.conditionRoot, mode);
  }
  return {
    id: `join-cond-${join.id}`,
    type: 'leaf',
    text: joinConditionDisplayText(join.condition),
    sourceSpan: join.sourceSpan,
  };
}

function findOptionalJoinForTable(
  table: TableRef,
  optionalJoins: JoinEdge[],
  query: ParsedQuery,
): JoinEdge | undefined {
  return optionalJoins.find((join) => {
    if (join.type === 'LEFT JOIN') return join.targetId === table.id;
    if (join.type === 'RIGHT JOIN') return join.sourceId === table.id;
    if (join.type === 'FULL JOIN') {
      return (
        join.targetId === table.id ||
        resolveJoinLayoutSources(join, query.tables).includes(table.id)
      );
    }
    return false;
  });
}

function attachOptionalJoinsToPresenceGroups(
  groups: TablePresenceGroup[],
  query: ParsedQuery,
  classification: TablePresenceClassification,
  optionalJoins: JoinEdge[],
  mode: QueryEffectMode,
): TablePresenceGroup[] {
  return groups.map((group) => {
    if (group.kind !== 'optional') return group;
    return {
      ...group,
      entries: group.entries.map((entry) => {
        const table = classification.optional.find(
          (t) => formatTableNameForPresence(t, classification, false) === entry.tableLabel,
        );
        if (!table) return entry;
        const join = findOptionalJoinForTable(table, optionalJoins, query);
        if (!join) return entry;
        return {
          ...entry,
          join: {
            type: formatJoinDisplayType(join),
            condition: buildJoinConditionEffectNode(join, mode),
          },
        };
      }),
    };
  });
}

function buildJoinFilterNode(
  join: JoinEdge,
  effectiveInner: { nullableTable: TableRef; reasons: EffectiveInnerReason[] } | undefined,
  mode: QueryEffectMode,
): ConditionEffectNode {
  return {
    id: `join-filter-${join.id}`,
    type: 'join',
    label: joinFilterHeader(join, effectiveInner),
    sourceSpan: join.sourceSpan,
    children: [buildJoinConditionEffectNode(join, mode)],
  };
}

/** INNER / 実質 INNER JOIN の ON だけが行の絞り込みに相当する */
function isJoinRowFilter(
  join: JoinEdge,
  effectiveInner?: { nullableTable: TableRef; reasons: EffectiveInnerReason[] },
): boolean {
  // 直積は行を絞り込まない。条件の無い結合を「結合条件」の節に入れると、条件の無い項目が並ぶ
  if (isCartesianJoin(join)) return false;
  if (isInnerLikeJoin(join)) return true;
  return Boolean(effectiveInner);
}

function buildJoinFilterLeaves(
  query: ParsedQuery,
  effectiveInnerByJoin: Map<string, EffectiveInnerAnalysis>,
  mode: QueryEffectMode,
): ConditionEffectNode[] {
  return query.joins.flatMap((join) => {
    const effectiveInner = effectiveInnerForJoin(join, query, effectiveInnerByJoin);
    if (!isJoinRowFilter(join, effectiveInner)) return [];
    return [
      buildJoinFilterNode(join, effectiveInner, mode),
    ];
  });
}

function joinFilterPart(joinLeaves: ConditionEffectNode[]): QueryEffectFilterPart | null {
  if (joinLeaves.length === 0) return null;
  if (joinLeaves.length === 1) {
    return { label: '結合条件', root: joinLeaves[0]! };
  }
  return {
    label: '結合条件',
    root: {
      id: 'join-filter-root',
      type: 'and',
      label: 'すべて満たす（AND）',
      children: joinLeaves,
    },
  };
}

function describeRowFilterSection(query: ParsedQuery, mode: QueryEffectMode): QueryEffectSection | null {
  const rowFilter = conditionTreeWithoutJoinConditions(query.where, query.joins);

  if (mode === 'japanese') {
    if (!rowFilter) return null;
    return {
      kind: 'filter',
      title: ROW_FILTER_TITLE_JA,
      conditionRoot: buildConditionEffectTree(rowFilter, mode),
    };
  }

  const effectiveInnerByJoin = effectiveInnerAnalysisByJoinId(query);
  const joinLeaves = buildJoinFilterLeaves(query, effectiveInnerByJoin, mode);
  const filterParts: QueryEffectFilterPart[] = [];

  const joinPart = joinFilterPart(joinLeaves);
  if (joinPart) filterParts.push(joinPart);

  if (rowFilter) {
    filterParts.push({
      label: 'WHERE',
      root: buildConditionEffectTree(rowFilter, mode),
    });
  }

  if (filterParts.length === 0) return null;

  return {
    kind: 'filter',
    title: ROW_FILTER_TITLE,
    filterParts,
  };
}

/** よく使うヒントの意味。一覧に無いものはヒント本文をそのまま見せる */
const HINT_DESCRIPTIONS: Array<{ pattern: RegExp; text: string }> = [
  { pattern: /^ORDERED\b/i, text: 'FROM 句の記述順で結合する' },
  { pattern: /^LEADING\b/i, text: '指定したテーブルから結合を開始する' },
  { pattern: /^USE_NL\b/i, text: 'ネステッドループ結合を選ばせる' },
  { pattern: /^USE_HASH\b/i, text: 'ハッシュ結合を選ばせる' },
  { pattern: /^USE_MERGE\b/i, text: 'ソートマージ結合を選ばせる' },
  { pattern: /^FULL\b/i, text: '全表走査を選ばせる' },
  { pattern: /^INDEX(?:_[A-Z]+)?\b/i, text: '指定した索引を使わせる' },
  { pattern: /^NO_INDEX\b/i, text: '指定した索引を使わせない' },
  { pattern: /^PARALLEL\b/i, text: 'パラレル実行させる' },
  { pattern: /^FIRST_ROWS\b/i, text: '先頭行を早く返す実行計画を選ばせる' },
  { pattern: /^ALL_ROWS\b/i, text: '全行取得のスループットを優先させる' },
  { pattern: /^APPEND\b/i, text: 'ダイレクトパス挿入させる' },
  { pattern: /^MATERIALIZE\b/i, text: 'WITH 句の結果を一時表に実体化させる' },
  { pattern: /^INLINE\b/i, text: 'WITH 句の結果を実体化せず展開させる' },
];

/** 1 つのコメントに並べたヒント（`LEADING(e) USE_NL(d) FULL(e)`）を、1 つずつに分ける */
const HINT_ITEM_RE = /[A-Za-z_][\w$#]*(?:\s*\((?:[^()]|\([^()]*\))*\))?/g;

/**
 * 一覧にあるヒントの意味を「LEADING(e) は指定したテーブルから結合を開始する」の形で並べる。
 * 一覧に無いヒントは書かない（ヒント全体はコメントのとおりに見せている）
 */
function describeHintItems(text: string): string {
  const items = text.match(HINT_ITEM_RE) ?? [];
  return items
    .map((item) => {
      const matched = HINT_DESCRIPTIONS.find((entry) => entry.pattern.test(item));
      return matched ? `${item.replace(/\s+/g, ' ')} は${matched.text}` : '';
    })
    .filter(Boolean)
    .join('、');
}

/** ヒントは実行計画への指示であって、結果集合そのものは変えない */
function pushOptimizerHintLines(lines: EffectLine[], query: ParsedQuery): void {
  if (!query.hints?.length) return;
  for (const hint of query.hints) {
    const meanings = describeHintItems(hint.text);
    lines.push({
      text: `ヒント /*+ ${hint.text} */ — 実行計画への指示（結果集合は変わらない）${meanings ? `。${meanings}` : ''}`,
      sourceSpan: hint.sourceSpan,
    });
  }
}

/** 階層問い合わせ（CONNECT BY / START WITH）の説明 */
export function describeHierarchicalLines(query: ParsedQuery): EffectLine[] {
  const hierarchical = query.hierarchical;
  if (!hierarchical) return [];

  const lines: EffectLine[] = [];
  if (hierarchical.startWith) {
    lines.push({
      text: `階層の起点 — START WITH ${hierarchical.startWith} を満たす行から辿る`,
      sourceSpan: hierarchical.startWithSpan,
    });
  }
  if (hierarchical.connectBy) {
    const cycle = hierarchical.noCycle ? '（NOCYCLE — 循環を検出したらそこで打ち切る）' : '';
    lines.push({
      text: `階層の親子関係 — CONNECT BY ${hierarchical.connectBy} で親から子へ辿る${cycle}`,
      sourceSpan: hierarchical.connectBySpan,
    });
  }
  if (lines.length > 0) {
    lines.push({
      text: '階層問い合わせ — 起点から辿れた行が階層順に展開される（LEVEL で深さを取得できる）',
      sourceSpan: hierarchical.sourceSpan,
    });
  }
  return lines;
}

/**
 * 表の後ろの、読む行を変える指定の説明。文は SQL Language Reference の SELECT の意味の説明に合わせた
 * （sample_clause・partition_extension_clause・flashback_query_clause・dblink。ページが長く、文は要約でしか確かめていない）
 */
function tableModifierPhrase(modifier: TableModifier, statementType: ParsedQuery['statementType']): string {
  // UPDATE と DELETE は、行を読むのではなく、更新・削除の対象にする
  const verb = statementType === 'SELECT' ? '読む' : '対象にする';
  switch (modifier.kind) {
    case 'sample':
      return /\bSEED\b/i.test(modifier.text)
        ? '表の全部ではなく、無作為に選んだ一部の行だけを読む（括弧の中の数は、各行が選ばれる確率の %。SEED を書くと、実行のたびに同じ行を選ぼうとする）'
        : '表の全部ではなく、無作為に選んだ一部の行だけを読む（括弧の中の数は、各行が選ばれる確率の %。選ばれる行は実行のたびに変わる）';
    case 'partition':
      return `表のうち、指定したパーティションの行だけを${verb}`;
    case 'flashback':
      return '今のデータではなく、指定した時点（SCN か時刻）にあった行を読む';
    case 'dblink':
      return `データベースリンクの先のデータベースにある表を${verb}`;
  }
}

function pushTableModifierLines(lines: EffectLine[], query: ParsedQuery): void {
  for (const table of query.tables) {
    for (const modifier of table.modifiers ?? []) {
      lines.push({
        text: `${tablePrimaryName(table)} の ${modifier.text} — ${tableModifierPhrase(modifier, query.statementType)}`,
        sourceSpan: modifier.sourceSpan,
      });
    }
  }
}

function describeScope(query: ParsedQuery, mode: QueryEffectMode): QueryEffectSection | null {
  const lines: EffectLine[] = [];
  let presenceGroups: TablePresenceGroup[] | undefined;
  const effectiveInnerByJoin = effectiveInnerAnalysisByJoinId(query);

  if (query.tables.length === 0) {
    // FROM の無い SELECT（`SELECT 1 + 1`）は、表を読まずに式の値を 1 行だけ返す
    lines.push({
      text: query.statementType === 'SELECT' ? 'FROM が無いので、表を読まずに式の値を 1 行だけ返す' : '対象テーブルが指定されていません',
    });
  } else {
    if (query.ctes?.length) {
      for (const cte of query.ctes) {
        lines.push({
          text: `${cte.name}（CTE）— WITH で定義された一時結果セット`,
          sourceSpan: cte.sourceSpan,
        });
      }
    }
    if (query.joins.length === 0) {
      lines.push({ text: `${scopeTableLabel(query.tables[0]!)} の行` });
    } else if (mode === 'japanese') {
      const classification = classifyTablePresenceRequirement(query);
      presenceGroups = buildTablePresenceGroups(classification, mode);

      lines.push({
        text: `${scopeTableLabel(query.tables[0]!)} を起点に行の組み合わせを構成`,
        sourceSpan: query.tables[0]?.sourceSpan,
      });
      pushOptimizerHintLines(lines, query);
      const fullJoinRejection = analyzeFullJoinNullRejection(query);
      for (const join of query.joins) {
        const effectiveInner = effectiveInnerForJoin(join, query, effectiveInnerByJoin);
        lines.push({
          text: describeJoinJapanese(join, query.tables, effectiveInner, fullJoinRejection.get(join.id)),
          sourceSpan: join.sourceSpan,
        });
      }
    } else {
      const classification = classifyTablePresenceRequirement(query);
      const optionalJoins = query.joins.filter((join) => {
        if (isCartesianJoin(join)) return false;
        const effectiveInner = effectiveInnerForJoin(join, query, effectiveInnerByJoin);
        return !isJoinRowFilter(join, effectiveInner);
      });
      presenceGroups = attachOptionalJoinsToPresenceGroups(
        buildTablePresenceGroups(classification, mode),
        query,
        classification,
        optionalJoins,
        mode,
      );
      pushOptimizerHintLines(lines, query);
      for (const join of query.joins) {
        if (isCartesianJoin(join)) {
          lines.push({ text: crossJoinPhrase(join, query.tables) });
        }
      }
    }
    pushTableModifierLines(lines, query);
  }

  if (lines.length === 0 && !presenceGroups) return null;

  return { kind: 'scope', title: scopeSectionTitle(query, mode), lines, presenceGroups };
}

function describeFilterSection(
  node: ConditionNode | undefined,
  title: string,
  mode: QueryEffectMode,
): QueryEffectSection | null {
  if (!node) return null;
  return {
    kind: 'filter',
    title,
    conditionRoot: buildConditionEffectTree(node, mode),
  };
}

function describeAggregation(query: ParsedQuery, mode: QueryEffectMode): QueryEffectSection[] {
  if (query.statementType !== 'SELECT') return [];

  const aggregateLines = describeAggregateLines(query, mode);
  if (aggregateLines.length === 0 && query.groupBy.length === 0) return [];

  const sections: QueryEffectSection[] = [
    {
      kind: 'aggregate',
      title: '集約',
      lines: aggregateLines,
    },
  ];

  const havingTitle =
    mode === 'japanese'
      ? '集約後の HAVING 条件（グループ単位でさらに絞り込み）'
      : 'HAVING';
  const having = describeFilterSection(query.having, havingTitle, mode);
  if (having) sections.push(having);

  return sections;
}

function describeChanges(query: ParsedQuery): QueryEffectSection | null {
  if (query.statementType === 'UPDATE' && query.setClauses?.length) {
    return {
      kind: 'change',
      title: '更新内容',
      lines: query.setClauses.map((s) => ({ text: s.label })),
    };
  }
  return null;
}

function describeHierarchicalSection(query: ParsedQuery): QueryEffectSection | null {
  const lines = describeHierarchicalLines(query);
  return lines.length > 0 ? { kind: 'info', title: '階層問い合わせ', lines } : null;
}

/**
 * 行ロックの指定（FOR UPDATE など）。読んだ行をロックするのは、結果の行とは別の、この SQL の作用。
 * 出典: Oracle Database 23 SQL Language Reference の SELECT の for_update_clause
 */
function describeLockingLines(query: ParsedQuery, mode: QueryEffectMode): EffectLine[] {
  const clause = query.lockingClause;
  if (!clause) return [];
  const sourceSpan = query.lockingClauseSpan;
  if (mode === 'sql') return [{ text: clause, sourceSpan }];

  const shared = /\b(?:SHARE)\b/i.test(clause);
  const lines: EffectLine[] = [
    {
      text: shared
        ? `共有ロック（${clause}） — 読んだ行は、トランザクションが終わるまでほかのセッションが変更できない`
        : `行ロック（${clause}） — 選んだ行は、トランザクションが終わるまでほかのセッションがロックも更新もできない`,
      sourceSpan,
    },
  ];
  const of = /\bOF\s+(.+?)(?=\s+(?:NOWAIT|WAIT|SKIP)\b|$)/i.exec(clause)?.[1];
  if (of) lines.push({ text: `OF ${of} — 指定した列の表の行だけをロックする`, sourceSpan });
  if (/\bSKIP\s+LOCKED\b/i.test(clause)) {
    lines.push({ text: 'SKIP LOCKED — ほかのトランザクションがロックしている行は、結果に入れずに飛ばす', sourceSpan });
  }
  if (/\bNOWAIT\b/i.test(clause)) {
    lines.push({ text: 'NOWAIT — ロックできない行があれば、待たずにエラーにする', sourceSpan });
  }
  const wait = /\bWAIT\s+(\d+)(?:\s+(SECONDS|MILLISECONDS|MICROSECONDS))?/i.exec(clause);
  if (wait) {
    const unit = { MILLISECONDS: 'ミリ秒', MICROSECONDS: 'マイクロ秒' }[wait[2]?.toUpperCase() ?? ''] ?? '秒';
    lines.push({ text: `WAIT ${wait[1]} — ロックできるまで、最大 ${wait[1]} ${unit}待つ`, sourceSpan });
  }
  return lines;
}

function describePostProcess(query: ParsedQuery, mode: QueryEffectMode): QueryEffectSection | null {
  const lines = [...describePostProcessLines(query, mode), ...describeLockingLines(query, mode)];
  return lines.length > 0 ? { kind: 'info', title: '後処理', lines } : null;
}

function primaryTarget(query: ParsedQuery): string {
  if (query.statementType === 'DELETE' && query.deleteTargets?.length) {
    return formatSummaryTableList(deleteTargetTables(query));
  }
  if (query.statementType === 'UPDATE') {
    return formatSummaryTableList(updatedTargetTables(query));
  }
  if (query.joins.length > 0) {
    return formatSummaryTableList(query.tables, 'の組み合わせ');
  }
  const main = query.tables[0];
  return main ? tablePrimaryName(main) : 'テーブル';
}

function buildSummary(query: ParsedQuery, meta: (typeof ACTION_LABELS)[ParsedQuery['statementType']]): string {
  // `SELECT SYSDATE FROM DUAL` のように DUAL だけを読む SELECT は、式の値が 1 行だけ返る（DUAL は 1 行だけのダミー表）。
  // FROM の無い SELECT（`SELECT 1 + 1`）も同じ。SQL Language Reference の SELECT では FROM 句は省略できる
  // （「Use the optional FROM clause …」。ページの文は要約でしか確かめていない）
  if (query.statementType === 'SELECT' && query.tables.length === 0) {
    const condition = query.where ? 'WHERE 条件を満たすときだけ、' : '';
    return `${condition}式の値が 1 行の結果として${meta.verb}`;
  }
  if (
    query.statementType === 'SELECT' &&
    query.joins.length === 0 &&
    query.tables.length === 1 &&
    !query.tables[0]!.isDerived &&
    query.tables[0]!.table.toUpperCase() === 'DUAL'
  ) {
    const condition = conditionTreeWithoutJoinConditions(query.where, query.joins) ? 'WHERE 条件を満たすときだけ、' : '';
    return `${condition}式の値が 1 行の結果として${meta.verb}`;
  }
  // 「users の行」「users のうち、WHERE 条件を満たす行」。テーブル名と「行」の間に「の」を入れて文をつなぐ
  const primary = primaryTarget(query);
  // テーブル名や「（u）」の後ろは空白を空け、「組み合わせ」「3 テーブル」のような日本語の後ろは詰める
  const target = /[\p{sc=Hiragana}\p{sc=Katakana}\p{sc=Han}ー]$/u.test(primary) ? `${primary}の` : `${primary} の`;
  const filtered = conditionTreeWithoutJoinConditions(query.where, query.joins)
    ? 'うち、WHERE 条件を満たす'
    : '';
  const distinct = query.statementType === 'SELECT' && query.distinct ? '（重複行除外）' : '';
  const grouped =
    query.statementType === 'SELECT' && query.groupBy.length > 0
      ? '（グループ集約後）'
      : query.statementType === 'SELECT' &&
          query.groupBy.length === 0 &&
          query.columns.some(hasGroupingAggregate)
        ? '（全体集約）'
        : '';
  const limit = formatLimitSummary(query);

  if (query.statementType === 'SELECT') {
    return `${target}${filtered}行${grouped}${distinct}が結果として${meta.verb}${limit}`;
  }
  if (query.statementType === 'UPDATE') {
    return `${target}${filtered}行が${meta.verb}${limit}`;
  }
  return `${target}${filtered}行が${meta.verb}${limit}`;
}

export function buildQueryEffect(query: ParsedQuery, mode: QueryEffectMode = 'sql'): QueryEffect {
  const meta = ACTION_LABELS[query.statementType];
  const sections: QueryEffectSection[] = [];

  const target = describeOperationTarget(query);
  if (target) sections.push(target);

  const scope = describeScope(query, mode);
  if (scope) sections.push(scope);

  const where = describeRowFilterSection(query, mode);
  if (where) sections.push(where);

  const hierarchical = describeHierarchicalSection(query);
  if (hierarchical) sections.push(hierarchical);

  sections.push(...describeAggregation(query, mode));

  const changes = describeChanges(query);
  if (changes) sections.push(changes);

  const post = describePostProcess(query, mode);
  if (post) sections.push(post);

  return {
    action: meta.action,
    actionLabel: meta.label,
    headline: `${meta.label}対象`,
    summary: buildSummary(query, meta),
    sections,
  };
}

export interface UnionQueryEffect {
  branches: Array<{ operator?: string; effect: QueryEffect }>;
  unionNotes: string[];
  /**
   * 集合演算の結果全体に掛かる ORDER BY・OFFSET・行制限。無ければ null。
   * 各ブランチの説明には出ないので、別に出さないと、並び順や件数の上限が画面から消える
   */
  wholeResult: QueryEffectSection | null;
}

export function buildUnionQueryEffect(
  query: ParsedQuery,
  mode: QueryEffectMode = 'sql',
): UnionQueryEffect | null {
  if (!hasUnion(query) || !query.unionBranches) return null;
  return {
    unionNotes: describeUnionCombination(query),
    branches: query.unionBranches.map((branch) => ({
      operator: branch.operator,
      effect: buildQueryEffect(branch.query, mode),
    })),
    wholeResult: describeUnionWholeResult(query, mode),
  };
}

function describeUnionWholeResult(query: ParsedQuery, mode: QueryEffectMode): QueryEffectSection | null {
  // DISTINCT は最初のブランチのもので、結果全体のものではないので外す
  const lines = describePostProcessLines({ ...query, distinct: false }, mode);
  return lines.length > 0 ? { kind: 'info', title: '集合演算の結果全体の後処理', lines } : null;
}
