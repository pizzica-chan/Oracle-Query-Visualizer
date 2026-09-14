import type { ConditionNode, ParsedQuery, TableRef, UnionBranch } from './types';

export function tableRefMatchesName(table: TableRef, name: string): boolean {
  return name === table.alias || name === table.table || name === table.displayName;
}

/** SET 句から更新対象テーブルを解決（テーブル修飾が無い場合は FROM の先頭テーブル） */
export function getUpdateTargetTables(query: ParsedQuery): TableRef[] {
  if (query.statementType !== 'UPDATE') return [];
  const setClauses = query.setClauses;
  if (!setClauses?.length) return [];

  const tables: TableRef[] = [];
  const seen = new Set<string>();

  for (const set of setClauses) {
    if (!set.table) continue;
    const table = query.tables.find((t) => tableRefMatchesName(t, set.table!));
    if (table && !seen.has(table.id)) {
      seen.add(table.id);
      tables.push(table);
    }
  }

  if (tables.length > 0) return tables;
  return query.tables[0] ? [query.tables[0]] : [];
}

export function isUpdateTargetTable(table: TableRef, query: ParsedQuery): boolean {
  return getUpdateTargetTables(query).some((t) => t.id === table.id);
}

/** 条件ツリー内のサブクエリを再帰的に収集 */
export function collectSubqueriesFromCondition(node: ConditionNode | undefined): ParsedQuery[] {
  if (!node) return [];
  const result: ParsedQuery[] = [];
  if (node.nestedQuery) result.push(node.nestedQuery);
  for (const child of node.children ?? []) {
    result.push(...collectSubqueriesFromCondition(child));
  }
  return result;
}

/** クエリ全体からネストされた SELECT を収集（ルート自身は除く） */
export function collectAllNestedQueries(root: ParsedQuery | null | undefined): ParsedQuery[] {
  if (!root) return [];

  const seen = new Set<ParsedQuery>();
  const result: ParsedQuery[] = [];

  function add(query: ParsedQuery) {
    if (seen.has(query)) return;
    seen.add(query);
    result.push(query);
  }

  function walkQuery(query: ParsedQuery) {
    for (const table of query.tables) {
      if (table.derivedQuery) {
        add(table.derivedQuery);
        walkQuery(table.derivedQuery);
      }
    }
    for (const sub of collectSubqueriesFromCondition(query.where)) {
      add(sub);
      walkQuery(sub);
    }
    for (const sub of collectSubqueriesFromCondition(query.having)) {
      add(sub);
      walkQuery(sub);
    }
    for (const branch of query.unionBranches ?? []) {
      add(branch.query);
      walkQuery(branch.query);
    }
  }

  walkQuery(root);
  return result.filter((q) => q !== root);
}

/** UNION ブランチ本体を除いたサブクエリ（IN / EXISTS / 派生テーブル等） */
export function collectSubqueriesExcludingUnionBranches(root: ParsedQuery): ParsedQuery[] {
  return collectSubqueryRefsExcludingUnionBranches(root).map((ref) => ref.query);
}

export interface SubqueryRef {
  query: ParsedQuery;
  title: string;
}

function truncateSubqueryLabel(label: string, maxLen = 72): string {
  const trimmed = label.trim();
  if (trimmed.length <= maxLen) return trimmed;
  return `${trimmed.slice(0, maxLen - 3)}...`;
}

function formatConditionSubqueryTitle(node: ConditionNode): string {
  const label = node.label.trim();
  const selectIdx = label.search(/\(\s*SELECT\b/i);
  if (selectIdx > 0) {
    return truncateSubqueryLabel(label.slice(0, selectIdx).trim());
  }
  const existsMatch = label.match(/^(NOT EXISTS|EXISTS)\b/i);
  if (existsMatch) {
    return existsMatch[1]!.toUpperCase();
  }
  if (node.type === 'subquery' && node.operator && node.left) {
    return truncateSubqueryLabel(`${node.left} ${node.operator}`);
  }
  return truncateSubqueryLabel(label);
}

function formatDerivedSubqueryTitle(table: TableRef): string {
  return table.alias ?? table.table;
}

function dedupeSubqueryTitle(title: string, used: Map<string, number>): string {
  const count = used.get(title) ?? 0;
  used.set(title, count + 1);
  return count === 0 ? title : `${title} (${count + 1})`;
}

/** UNION ブランチを除き、表示用タイトル付きでサブクエリを収集 */
export function collectSubqueryRefsExcludingUnionBranches(root: ParsedQuery): SubqueryRef[] {
  const unionQuerySet = new Set(root.unionBranches?.map((b) => b.query) ?? []);
  const seen = new Set<ParsedQuery>();
  const usedTitles = new Map<string, number>();
  const result: SubqueryRef[] = [];

  function push(query: ParsedQuery, title: string) {
    if (query === root || unionQuerySet.has(query) || seen.has(query)) return;
    seen.add(query);
    result.push({ query, title: dedupeSubqueryTitle(title, usedTitles) });
  }

  function walkConditions(node: ConditionNode | undefined) {
    if (!node) return;
    if (node.nestedQuery) {
      push(node.nestedQuery, formatConditionSubqueryTitle(node));
      walkQuery(node.nestedQuery);
    }
    for (const child of node.children ?? []) walkConditions(child);
  }

  function walkQuery(query: ParsedQuery) {
    for (const table of query.tables) {
      if (table.derivedQuery) {
        push(table.derivedQuery, formatDerivedSubqueryTitle(table));
        walkQuery(table.derivedQuery);
      }
    }
    walkConditions(query.where);
    walkConditions(query.having);
    for (const branch of query.unionBranches ?? []) {
      walkQuery(branch.query);
    }
  }

  walkQuery(root);
  return result;
}

export function hasUnion(query: ParsedQuery): boolean {
  return (query.unionBranches?.length ?? 0) > 1;
}

export function formatUnionBranches(branches: UnionBranch[] | undefined): string {
  if (!branches || branches.length <= 1) return '';
  return branches
    .map((b, i) => (i === 0 ? 'SELECT' : b.operator ?? 'UNION'))
    .join(' → ');
}

export function countNestedItems(query: ParsedQuery): { unions: number; subqueries: number } {
  const unions = hasUnion(query) ? (query.unionBranches?.length ?? 0) : 0;
  const subqueries = collectAllNestedQueries(query).length;
  return { unions, subqueries };
}
