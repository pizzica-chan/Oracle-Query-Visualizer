import { maskNonCode } from './sql-lex';
import type { ConditionNode, JoinEdge, ParsedQuery, SetClause, DeleteTarget, TableRef } from './types';

export interface AliasResolutionOptions {
  /**
   * 同じ実テーブルを複数回参照する（自己結合）とき、その別名を実テーブル名へ潰さない。
   * 表示上は潰しても別途エイリアスを併記できるが、比較では u1 と u2 が同一名になり
   * 「出力列や条件がどちらのインスタンスに掛かるか」の違いが消えてしまうため、比較側では true にする。
   */
  keepSelfJoinAliases?: boolean;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function physicalTableName(table: TableRef): string {
  return table.schema ? `${table.schema}.${table.table}` : table.table;
}

/** 同じ実テーブルを 2 回以上参照しているときの、その正規化名の集合 */
function selfJoinedPhysicalNames(tables: TableRef[]): Set<string> {
  const counts = new Map<string, number>();
  for (const t of tables) {
    if (t.isDerived) continue;
    const key = physicalTableName(t).toLowerCase();
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const duplicated = new Set<string>();
  for (const [key, count] of counts) {
    if (count > 1) duplicated.add(key);
  }
  return duplicated;
}

export function buildAliasMap(
  tables: TableRef[],
  options: AliasResolutionOptions = {},
): Map<string, string> {
  const selfJoined = options.keepSelfJoinAliases ? selfJoinedPhysicalNames(tables) : null;
  const map = new Map<string, string>();
  for (const t of tables) {
    if (!t.alias || t.isDerived) continue;
    const physical = physicalTableName(t);
    if (selfJoined?.has(physical.toLowerCase())) continue;
    map.set(t.alias, physical);
  }
  return map;
}

/**
 * `alias.` を実テーブル名へ置換する。
 * 文字列リテラル・コメント内（例: `note = 'u.name'`）は置換しない。
 */
export function resolveAliasesInText(text: string, aliasMap: Map<string, string>): string {
  if (!text || aliasMap.size === 0) return text;

  const masked = maskNonCode(text);
  const aliases = [...aliasMap.keys()].sort((a, b) => b.length - a.length);
  const hits: Array<{ start: number; end: number; replacement: string }> = [];

  for (const alias of aliases) {
    const tableName = aliasMap.get(alias)!;
    // Oracle の識別子は引用しない限り大文字小文字を区別しない（`u` と `U` は同じ別名）
    const qualified = new RegExp(`(?<![\\w.\`])${escapeRegExp(alias)}\\.`, 'gi');
    let match: RegExpExecArray | null;
    while ((match = qualified.exec(masked)) !== null) {
      hits.push({
        start: match.index,
        end: match.index + match[0].length,
        replacement: `${tableName}.`,
      });
    }
  }

  if (hits.length === 0) return text;

  // 置換で長さが変わるため後ろから適用する
  // （別名同士は `<alias>.` 全体に一致するので範囲が重なることはない）
  hits.sort((a, b) => b.start - a.start);
  let result = text;
  for (const hit of hits) {
    result = result.slice(0, hit.start) + hit.replacement + result.slice(hit.end);
  }
  return result;
}

function resolveStandaloneAlias(name: string, aliasMap: Map<string, string>): string {
  const direct = aliasMap.get(name);
  if (direct) return direct;
  // Oracle の識別子は引用しない限り大文字小文字を区別しない（SET / DELETE 対象の `U` と `u` は同じ）
  const lowered = name.toLowerCase();
  for (const [alias, physical] of aliasMap) {
    if (alias.toLowerCase() === lowered) return physical;
  }
  return name;
}

function resolveConditionNode(
  node: ConditionNode,
  aliasMap: Map<string, string>,
  options: AliasResolutionOptions,
): ConditionNode {
  return {
    ...node,
    label: resolveAliasesInText(node.label, aliasMap),
    left: node.left ? resolveAliasesInText(node.left, aliasMap) : undefined,
    right: node.right ? resolveAliasesInText(node.right, aliasMap) : undefined,
    children: node.children?.map((child) => resolveConditionNode(child, aliasMap, options)),
    nestedQuery: node.nestedQuery
      ? applyAliasResolution(node.nestedQuery, true, options)
      : undefined,
  };
}

function resolveTableRef(
  table: TableRef,
  options: AliasResolutionOptions,
  aliasMap: Map<string, string>,
): TableRef {
  // 別名を残したテーブル（自己結合）は表示名も別名のままにする。
  // 条件式が `u1.id` のままなのに表示名だけ `users` にすると、
  // どちらのインスタンスの話か読み取れなくなる
  const keepsAlias = Boolean(table.alias) && !aliasMap.has(table.alias!);
  const displayName =
    table.isDerived || keepsAlias
      ? table.displayName
      : table.schema
        ? `${table.schema}.${table.table}`
        : table.table;
  return {
    ...table,
    displayName,
    derivedQuery: table.derivedQuery
      ? applyAliasResolution(table.derivedQuery, true, options)
      : undefined,
  };
}

function resolveJoin(
  join: JoinEdge,
  aliasMap: Map<string, string>,
  options: AliasResolutionOptions,
): JoinEdge {
  return {
    ...join,
    layoutCondition: join.layoutCondition ?? join.condition,
    layoutConditionParts: join.layoutConditionParts ?? join.conditionParts,
    layoutConditionRoot: join.layoutConditionRoot ?? join.conditionRoot,
    condition: resolveAliasesInText(join.condition, aliasMap),
    conditionParts: join.conditionParts
      ? {
          left: resolveAliasesInText(join.conditionParts.left, aliasMap),
          operator: join.conditionParts.operator,
          right: resolveAliasesInText(join.conditionParts.right, aliasMap),
        }
      : undefined,
    conditionRoot: join.conditionRoot
      ? resolveConditionNode(join.conditionRoot, aliasMap, options)
      : undefined,
  };
}

function resolveSetClause(set: SetClause, aliasMap: Map<string, string>): SetClause {
  return {
    ...set,
    label: resolveAliasesInText(set.label, aliasMap),
    table: set.table ? resolveStandaloneAlias(set.table, aliasMap) : undefined,
  };
}

function resolveDeleteTarget(target: DeleteTarget, aliasMap: Map<string, string>): DeleteTarget {
  const resolvedName = resolveStandaloneAlias(target.name, aliasMap);
  return {
    name: resolvedName,
    label: resolvedName,
  };
}

/** 解析結果の表示・比較用にエイリアスを実テーブル名へ置換する */
export function applyAliasResolution(
  query: ParsedQuery,
  enabled: boolean,
  options: AliasResolutionOptions = {},
): ParsedQuery {
  if (!enabled) return query;

  const aliasMap = buildAliasMap(query.tables, options);

  return {
    ...query,
    tables: query.tables.map((table) => resolveTableRef(table, options, aliasMap)),
    joins: query.joins.map((j) => resolveJoin(j, aliasMap, options)),
    where: query.where ? resolveConditionNode(query.where, aliasMap, options) : undefined,
    having: query.having ? resolveConditionNode(query.having, aliasMap, options) : undefined,
    columns: query.columns.map((col) => ({
      ...col,
      expression: resolveAliasesInText(col.expression, aliasMap),
    })),
    setClauses: query.setClauses?.map((s) => resolveSetClause(s, aliasMap)),
    deleteTargets: query.deleteTargets?.map((d) => resolveDeleteTarget(d, aliasMap)),
    groupBy: query.groupBy.map((g) => ({
      ...g,
      text: resolveAliasesInText(g.text, aliasMap),
    })),
    orderBy: query.orderBy.map((o) => ({
      ...o,
      text: resolveAliasesInText(o.text, aliasMap),
    })),
    unionBranches: query.unionBranches?.map((branch) => ({
      ...branch,
      query: applyAliasResolution(branch.query, true, options),
    })),
  };
}

export function formatTableLabel(table: TableRef, resolved: boolean): { primary: string; aliasNote?: string } {
  if (table.isDerived) {
    return { primary: table.displayName, aliasNote: table.alias };
  }
  if (!resolved || !table.alias) {
    return { primary: table.displayName };
  }
  const primary = table.schema ? `${table.schema}.${table.table}` : table.table;
  return { primary, aliasNote: table.alias };
}
