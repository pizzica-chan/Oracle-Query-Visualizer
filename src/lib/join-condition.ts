import type { ConditionNode, JoinEdge, ParsedQuery, TableRef } from './types';

function formatSubqueryInJoinLabel(query: ParsedQuery): string {
  const from = query.tables.map((t) => t.alias ?? t.table).join(', ');
  const firstCol = query.columns[0]?.expression;
  const cols =
    query.columns.length === 1 && (firstCol === '1' || firstCol === '*') ? firstCol! : `${query.columns.length}列`;
  const where = query.where ? ` WHERE ${formatJoinConditionLabel(query.where)}` : '';
  return `SELECT ${cols} FROM ${from}${where}`;
}

/** JOIN ON 条件の表示用文字列（サブクエリ内の相関参照を含む） */
export function formatJoinConditionLabel(node: ConditionNode): string {
  if (node.type === 'and' || node.type === 'or') {
    const parts = node.children?.map(formatJoinConditionLabel) ?? [];
    if (parts.length <= 1) return parts[0] ?? node.label;
    return parts.join(` ${node.operator} `);
  }

  if (node.type === 'not') {
    const inner = node.children?.[0];
    return inner ? `NOT (${formatJoinConditionLabel(inner)})` : 'NOT';
  }

  if (node.type === 'exists' && node.nestedQuery) {
    const op = /\bNOT\s+EXISTS\b/i.test(node.label) ? 'NOT EXISTS' : 'EXISTS';
    return `${op} (${formatSubqueryInJoinLabel(node.nestedQuery)})`;
  }

  if ((node.type === 'in' || node.type === 'subquery') && node.nestedQuery) {
    const op = node.operator ?? (node.type === 'in' ? 'IN' : '=');
    return `${node.left ?? ''} ${op} (${formatSubqueryInJoinLabel(node.nestedQuery)})`.trim();
  }

  return node.label;
}

/** JOIN 条件の意味解析用テキスト（USING は conditionRoot の等価条件に展開） */
export function resolveJoinConditionExpression(join: JoinEdge): string {
  const root = join.layoutConditionRoot ?? join.conditionRoot;
  if (root) return formatJoinConditionLabel(root);
  return join.layoutCondition ?? join.condition;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function addTableIdFromLeadingQualifier(expr: string, tables: TableRef[], ids: Set<string>): void {
  const match = expr.trim().match(/^("?)([a-zA-Z_][\w$]*)\1\.(?:"?)([a-zA-Z_*][\w$]*)(?:"?)/);
  if (!match) return;
  const id = resolveNameToTableId(match[2]!, tables);
  if (id) ids.add(id);
}

function resolveNameToTableId(name: string, tables: TableRef[]): string | undefined {
  const normalized = name.trim();
  const byAlias = tables.find((t) => t.alias === normalized);
  if (byAlias) return byAlias.id;
  if (tables.some((t) => t.id === normalized)) return normalized;
  const byTable = tables.filter((t) => t.table === normalized || t.displayName === normalized);
  if (byTable.length === 1) return byTable[0]!.id;
  return undefined;
}

function collectTableIdsFromExpression(expr: string | undefined, tables: TableRef[], ids: Set<string>): void {
  if (!expr) return;

  addTableIdFromLeadingQualifier(expr, tables, ids);

  for (const table of tables) {
    if (!table.alias) continue;
    const re = new RegExp(`\\b${escapeRegExp(table.alias)}\\.`, 'i');
    if (re.test(expr)) ids.add(table.id);
  }

  for (const table of tables.filter((t) => !t.alias)) {
    for (const term of [table.table, table.displayName].filter(Boolean) as string[]) {
      const re = new RegExp(`\\b${escapeRegExp(term)}\\.`, 'i');
      if (re.test(expr)) ids.add(table.id);
    }
  }
}

function collectTableIdsFromConditionNode(
  node: ConditionNode,
  tables: TableRef[],
  ids: Set<string>,
): void {
  collectTableIdsFromExpression(node.left, tables, ids);
  collectTableIdsFromExpression(node.right, tables, ids);
  collectTableIdsFromExpression(node.label, tables, ids);

  if (node.nestedQuery) {
    collectTableIdsFromParsedQuery(node.nestedQuery, tables, ids);
  }

  node.children?.forEach((child) => collectTableIdsFromConditionNode(child, tables, ids));
}

function collectTableIdsFromParsedQuery(query: ParsedQuery, tables: TableRef[], ids: Set<string>): void {
  if (query.where) collectTableIdsFromConditionNode(query.where, tables, ids);
  if (query.having) collectTableIdsFromConditionNode(query.having, tables, ids);
  for (const join of query.joins) {
    collectTableIdsFromJoinCondition(join, tables, ids);
  }
}

/** JOIN ON 条件から参照されるテーブル id（サブクエリ内の相関参照を含む） */
export function collectTableIdsFromJoinCondition(
  join: JoinEdge,
  tables: TableRef[],
  ids: Set<string>,
): void {
  ids.add(join.targetId);

  const root = join.layoutConditionRoot ?? join.conditionRoot;
  if (root) {
    collectTableIdsFromConditionNode(root, tables, ids);
    return;
  }

  const condition = join.layoutCondition ?? join.condition;
  collectTableIdsFromExpression(condition, tables, ids);

  if (join.layoutConditionParts ?? join.conditionParts) {
    const parts = join.layoutConditionParts ?? join.conditionParts!;
    collectTableIdsFromExpression(parts.left, tables, ids);
    collectTableIdsFromExpression(parts.right, tables, ids);
  }
}
