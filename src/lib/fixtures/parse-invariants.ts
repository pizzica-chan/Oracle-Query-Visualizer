import type { ConditionNode, ParsedQuery } from '../types';

/** 解析結果の構造的不変条件 — 画面表示の前提が壊れていないか検証 */
export function assertParseInvariants(query: ParsedQuery, label = 'root'): void {
  const tableIds = new Set(query.tables.map((t) => t.id));
  const seenIds = new Set<string>();

  function registerId(scope: string, id: string): void {
    if (seenIds.has(id)) {
      throw new Error(`[${label}] duplicate id "${id}" in ${scope}`);
    }
    seenIds.add(id);
  }

  for (const table of query.tables) {
    registerId('tables', table.id);
    if (!table.table) throw new Error(`[${label}] table without name`);
    if (!table.displayName) throw new Error(`[${label}] table ${table.id} without displayName`);
    if (table.isDerived && !table.derivedQuery) {
      throw new Error(`[${label}] derived table ${table.id} missing derivedQuery`);
    }
    if (table.derivedQuery) {
      assertParseInvariants(table.derivedQuery, `${label}/derived:${table.alias ?? table.table}`);
    }
  }

  for (const join of query.joins) {
    registerId('joins', join.id);
    if (!tableIds.has(join.sourceId)) {
      throw new Error(`[${label}] join ${join.id} references unknown source ${join.sourceId}`);
    }
    if (!tableIds.has(join.targetId)) {
      throw new Error(`[${label}] join ${join.id} references unknown target ${join.targetId}`);
    }
    if (!join.condition.trim()) {
      throw new Error(`[${label}] join ${join.id} has empty condition`);
    }
  }

  if (query.joins.length > 0 && query.tables.length < 2) {
    throw new Error(`[${label}] joins exist but fewer than 2 tables`);
  }

  walkCondition(query.where, `${label}/where`);
  walkCondition(query.having, `${label}/having`);

  if (query.statementType === 'SELECT' && query.columns.length === 0) {
    throw new Error(`[${label}] SELECT with no columns`);
  }

  if (query.statementType === 'UPDATE' && !query.setClauses?.length) {
    throw new Error(`[${label}] UPDATE with no SET clauses`);
  }

  if (query.statementType === 'DELETE' && !query.deleteTargets?.length) {
    throw new Error(`[${label}] DELETE with no targets`);
  }

  if (query.unionBranches) {
    if (query.unionBranches.length < 2) {
      throw new Error(`[${label}] unionBranches with fewer than 2 entries`);
    }
    for (let i = 1; i < query.unionBranches.length; i++) {
      if (!query.unionBranches[i]?.operator) {
        throw new Error(`[${label}] union branch ${i} missing operator`);
      }
    }
    for (const branch of query.unionBranches) {
      registerId('union', branch.id);
      assertParseInvariants(branch.query, `${label}/union:${branch.id}`);
    }
  }

  function walkCondition(node: ConditionNode | undefined, scope: string): void {
    if (!node) return;
    registerId(scope, node.id);

    if (node.type === 'in' && node.nestedQuery && !node.left?.trim()) {
      throw new Error(`[${scope}] IN subquery without left expr`);
    }
    if ((node.type === 'exists' || node.type === 'subquery') && !node.nestedQuery) {
      throw new Error(`[${scope}] ${node.type} node without nestedQuery`);
    }
    if (node.nestedQuery) {
      assertParseInvariants(node.nestedQuery, `${scope}/nested`);
    }
    for (const child of node.children ?? []) {
      walkCondition(child, scope);
    }
  }
}
