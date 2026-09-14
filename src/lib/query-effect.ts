import type { ConditionNode, JoinEdge, ParsedQuery, SelectColumn, SetClause, SourceSpan, TableRef } from './types';
import { formatJoinDisplayType } from './parser';
import { getUpdateTargetTables } from './query-utils';
import {
  effectiveInnerAnalysisByJoinId,
  formatEffectiveInnerJoinScopeLine,
  isInnerLikeJoin,
  joinHasOnCondition,
  type EffectiveInnerAnalysis,
  type EffectiveInnerReason,
} from './join-effective-inner';
import { resolveJoinLayoutSources } from './join-graph-layout';
import { hasUnion } from './query-utils';

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

const AGGREGATE_FUNC_PATTERN =
  /\b(COUNT|SUM|AVG|MIN|MAX|GROUP_CONCAT|BIT_AND|BIT_OR|STD|STDDEV|VARIANCE)\s*\(/i;
const COUNT_DISTINCT_PATTERN = /\bCOUNT\s*\(\s*DISTINCT\b/i;

function columnLabel(col: SelectColumn): string {
  return col.alias ?? col.expression;
}

function hasStarProjection(columns: SelectColumn[]): boolean {
  return columns.some((c) => c.expression === '*' || /\.\*$/.test(c.expression));
}

function formatSelectColumnSql(col: SelectColumn): string {
  return col.alias ? `${col.expression} AS ${col.alias}` : col.expression;
}

function formatOrderByClause(query: ParsedQuery): EffectLine | null {
  if (query.orderBy.length === 0) return null;
  return {
    text: `ORDER BY ${query.orderBy.map((o) => o.text).join(', ')}`,
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

function describePostProcessLinesJapanese(query: ParsedQuery): EffectLine[] {
  const lines: EffectLine[] = [];
  const distinctLine = describeDistinctLineJapanese(query);
  if (distinctLine) lines.push({ text: distinctLine });
  if (query.orderBy.length > 0) {
    lines.push({
      text: `並び順 — ${query.orderBy.map((o) => o.text).join(', ')}`,
      sourceSpan: query.orderBy[0]?.sourceSpan,
    });
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

function describeAggregateLinesJapanese(query: ParsedQuery): EffectLine[] {
  if (query.statementType !== 'SELECT') return [];

  const aggregateCols = query.columns.filter((c) => AGGREGATE_FUNC_PATTERN.test(c.expression));
  const countDistinctCols = query.columns.filter((c) => COUNT_DISTINCT_PATTERN.test(c.expression));
  const lines: EffectLine[] = [];

  if (query.groupBy.length > 0) {
    lines.push({
      text: `${query.groupBy.map((g) => g.text).join(', ')} ごとに集約 — 1グループ = 結果の1行`,
      sourceSpan: query.groupBy[0]?.sourceSpan,
    });
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

  const aggregateCols = query.columns.filter((c) => AGGREGATE_FUNC_PATTERN.test(c.expression));
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

  return [
    'UNION / UNION ALL — 各 SELECT の結果を縦に連結（UNION は重複行を除外、UNION ALL は残す）',
  ];
}

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
  'FULL JOIN': (l, r, c) => `${l} と ${r} を FULL JOIN — 結合条件「${c}」`,
  'CROSS JOIN': (l, r, c) =>
    `${l} と ${r} を CROSS JOIN — 結合条件「${c}」を満たす組み合わせのみ残る`,
};

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
  'FULL JOIN': (s, r, c) => `${s} と ${r} を FULL JOIN — 結合条件「${c}」`,
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
  if (table.isDerived) {
    const base = table.alias || table.table;
    return derivedTableLabelAlreadyPresent(base) ? base : `${base}（派生テーブル）`;
  }
  if (table.alias && table.alias !== table.table) {
    return `${table.table}（${table.alias}）`;
  }
  return table.table;
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
  return col.alias ? `${expression} AS ${col.alias}` : expression;
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
      optionalIds.add(join.targetId);
      for (const id of sourceIds) optionalIds.add(id);
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
): string {
  const sourceLabels = joinSourceLabels(join, tables);
  const sourcesText = sourceLabels.join('、');
  const right = tableName(join, tables, join.targetId);
  const left = sourceLabels.length === 1 ? sourceLabels[0]! : sourcesText;
  const joinType = formatJoinDisplayType(join);
  const condition = join.condition;

  if (effectiveInner) {
    const preservedLabel = join.type === 'LEFT JOIN' ? left : right;
    return formatEffectiveInnerJoinScopeLine(join, preservedLabel, effectiveInner.nullableTable, effectiveInner.reasons);
  }

  if (join.type === 'CROSS JOIN' && !joinHasOnCondition(join)) {
    return sourceLabels.length > 1
      ? `${sourcesText} と ${right} の直積（すべての組み合わせ）`
      : `${left} と ${right} の直積（すべての組み合わせ）`;
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
  return `CROSS JOIN — ${left} と ${right} のすべての組み合わせ`;
}

function inConditionPhrase(node: ConditionNode): string {
  const isNotIn = node.operator === 'NOT IN' || /\bNOT\s+IN\b/i.test(node.label);

  if (node.nestedQuery) {
    const prefix = isNotIn
      ? '別の SELECT が返した値のどれとも一致しない'
      : '別の SELECT が返した値のどれかと一致';
    return `${prefix} — ${node.label}`;
  }

  const prefix = isNotIn ? '次の値のどれとも一致しない' : '次の値のどれかと一致';
  return `${prefix} — ${node.label}`;
}

function conditionPhrase(node: ConditionNode, mode: QueryEffectMode): string {
  if (mode === 'sql') return node.label;

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
    case 'between':
      return `範囲内 — ${node.label}`;
    default:
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
    text: join.condition,
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
  if (mode === 'japanese') {
    if (!query.where) return null;
    return {
      kind: 'filter',
      title: ROW_FILTER_TITLE_JA,
      conditionRoot: buildConditionEffectTree(query.where, mode),
    };
  }

  const effectiveInnerByJoin = effectiveInnerAnalysisByJoinId(query);
  const joinLeaves = buildJoinFilterLeaves(query, effectiveInnerByJoin, mode);
  const filterParts: QueryEffectFilterPart[] = [];

  const joinPart = joinFilterPart(joinLeaves);
  if (joinPart) filterParts.push(joinPart);

  if (query.where) {
    filterParts.push({
      label: 'WHERE',
      root: buildConditionEffectTree(query.where, mode),
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
  { pattern: /^ORDERED/i, text: 'FROM 句の記述順で結合する' },
  { pattern: /^LEADING/i, text: '指定したテーブルから結合を開始する' },
  { pattern: /^USE_NL/i, text: 'ネステッドループ結合を選ばせる' },
  { pattern: /^USE_HASH/i, text: 'ハッシュ結合を選ばせる' },
  { pattern: /^USE_MERGE/i, text: 'ソートマージ結合を選ばせる' },
  { pattern: /^FULL/i, text: '全表走査を選ばせる' },
  { pattern: /^INDEX(?:_[A-Z]+)?/i, text: '指定した索引を使わせる' },
  { pattern: /^NO_INDEX/i, text: '指定した索引を使わせない' },
  { pattern: /^PARALLEL/i, text: 'パラレル実行させる' },
  { pattern: /^FIRST_ROWS/i, text: '先頭行を早く返す実行計画を選ばせる' },
  { pattern: /^ALL_ROWS/i, text: '全行取得のスループットを優先させる' },
  { pattern: /^APPEND/i, text: 'ダイレクトパス挿入させる' },
  { pattern: /^MATERIALIZE/i, text: 'WITH 句の結果を一時表に実体化させる' },
  { pattern: /^INLINE/i, text: 'WITH 句の結果を実体化せず展開させる' },
];

function describeHint(text: string): string {
  const matched = HINT_DESCRIPTIONS.find((entry) => entry.pattern.test(text));
  return matched ? `${text} — ${matched.text}` : text;
}

/** ヒントは実行計画への指示であって、結果集合そのものは変えない */
function pushOptimizerHintLines(lines: EffectLine[], query: ParsedQuery): void {
  if (!query.hints?.length) return;
  for (const hint of query.hints) {
    lines.push({
      text: `ヒント /*+ ${describeHint(hint.text)} */ — 実行計画への指示（結果集合は変わらない）`,
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

function describeScope(query: ParsedQuery, mode: QueryEffectMode): QueryEffectSection | null {
  const lines: EffectLine[] = [];
  let presenceGroups: TablePresenceGroup[] | undefined;
  const effectiveInnerByJoin = effectiveInnerAnalysisByJoinId(query);

  if (query.tables.length === 0) {
    lines.push({ text: '対象テーブルが指定されていません' });
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
      lines.push({ text: `${tableLabel(query.tables[0]!)} の行` });
    } else if (mode === 'japanese') {
      const classification = classifyTablePresenceRequirement(query);
      presenceGroups = buildTablePresenceGroups(classification, mode);

      lines.push({
        text: `${tableLabel(query.tables[0]!)} を起点に行の組み合わせを構成`,
        sourceSpan: query.tables[0]?.sourceSpan,
      });
      pushOptimizerHintLines(lines, query);
      for (const join of query.joins) {
        const effectiveInner = effectiveInnerForJoin(join, query, effectiveInnerByJoin);
        lines.push({
          text: describeJoinJapanese(join, query.tables, effectiveInner),
          sourceSpan: join.sourceSpan,
        });
      }
    } else {
      const classification = classifyTablePresenceRequirement(query);
      const optionalJoins = query.joins.filter((join) => {
        if (join.type === 'CROSS JOIN') return false;
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
        if (join.type === 'CROSS JOIN' && !joinHasOnCondition(join)) {
          lines.push({ text: crossJoinPhrase(join, query.tables) });
        }
      }
    }
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

function describePostProcess(query: ParsedQuery, mode: QueryEffectMode): QueryEffectSection | null {
  const lines = describePostProcessLines(query, mode);
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
  const target = primaryTarget(query);
  const filtered = query.where ? '、WHERE 条件を満たす' : '';
  const distinct = query.statementType === 'SELECT' && query.distinct ? '（重複行除外）' : '';
  const grouped =
    query.statementType === 'SELECT' && query.groupBy.length > 0
      ? '（グループ集約後）'
      : query.statementType === 'SELECT' &&
          query.groupBy.length === 0 &&
          query.columns.some((c) => AGGREGATE_FUNC_PATTERN.test(c.expression))
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
  };
}
