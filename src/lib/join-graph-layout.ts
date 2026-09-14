import type { JoinEdge, TableRef } from './types';
import { collectTableIdsFromJoinCondition } from './join-condition';

const LAYOUT_H_GAP = 290;
const LAYOUT_V_GAP = 128;
const LAYOUT_X0 = 40;
const LAYOUT_Y0 = 72;

function tableIndex(tables: TableRef[], tableId: string): number {
  return tables.findIndex((t) => t.id === tableId);
}

/** ON 条件から参照されるテーブル id を抽出 */
export function getTableIdsReferencedInJoin(join: JoinEdge, tables: TableRef[]): string[] {
  const ids = new Set<string>();
  collectTableIdsFromJoinCondition(join, tables, ids);
  return [...ids];
}

/** target より前に ON で参照されるテーブル id（ファンイン用・FROM 順） */
export function resolveJoinLayoutSources(join: JoinEdge, tables: TableRef[]): string[] {
  const targetId = join.targetId;
  const targetIdx = tableIndex(tables, targetId);
  const referenced = getTableIdsReferencedInJoin(join, tables);

  const sources = referenced
    .filter((id) => id !== targetId)
    .filter((id) => tableIndex(tables, id) < targetIdx)
    .sort((a, b) => tableIndex(tables, a) - tableIndex(tables, b));

  if (sources.length > 0) return sources;
  if (join.sourceId && join.sourceId !== targetId) return [join.sourceId];
  return [];
}

/** JOIN 条件欄・説明用 — ON 条件の参照元 → target */
export function formatJoinTableLink(join: JoinEdge, tables: TableRef[]): string {
  const targetName = tables.find((t) => t.id === join.targetId)?.displayName ?? join.targetId;
  const sourceNames = resolveJoinLayoutSources(join, tables).map(
    (id) => tables.find((t) => t.id === id)?.displayName ?? id,
  );
  if (sourceNames.length === 0) return targetName;
  return `${sourceNames.join(', ')} → ${targetName}`;
}

/** レイアウト上の親テーブル（ON 条件で実際につながる側 — 主エッジ用） */
export function resolveJoinLayoutAnchor(join: JoinEdge, tables: TableRef[]): string {
  const sources = resolveJoinLayoutSources(join, tables);
  if (sources.length > 0) return sources[sources.length - 1]!;
  return join.sourceId;
}

export function computeJoinLayoutParent(
  tables: TableRef[],
  joins: JoinEdge[],
): Map<string, string> {
  const rootId = tables[0]?.id;
  const parent = new Map<string, string>();
  if (!rootId) return parent;

  parent.set(rootId, rootId);
  for (const join of joins) {
    parent.set(join.targetId, resolveJoinLayoutAnchor(join, tables));
  }
  return parent;
}

/** 図上エッジの source — 論理接続を優先 */
export function resolveJoinDisplaySource(
  join: JoinEdge,
  layoutParent: Map<string, string>,
): string {
  return layoutParent.get(join.targetId) ?? join.sourceId;
}

/** ツリー状 JOIN 図のノード座標 */
export function computeJoinNodePositions(
  tables: TableRef[],
  joins: JoinEdge[],
): Map<string, { x: number; y: number }> {
  const positions = new Map<string, { x: number; y: number }>();
  if (tables.length === 0) return positions;

  const rootId = tables[0]!.id;
  const depth = new Map<string, number>();
  depth.set(rootId, 0);

  for (const join of joins) {
    const sources = resolveJoinLayoutSources(join, tables);
    const sourceDepths = sources.map((id) => depth.get(id) ?? 0);
    const targetDepth = Math.max(0, ...sourceDepths) + 1;
    depth.set(join.targetId, targetDepth);
  }

  const byDepth = new Map<number, string[]>();
  for (const table of tables) {
    const d = depth.get(table.id) ?? 0;
    const row = byDepth.get(d) ?? [];
    row.push(table.id);
    byDepth.set(d, row);
  }

  for (const ids of byDepth.values()) {
    ids.sort((a, b) => tableIndex(tables, a) - tableIndex(tables, b));
  }

  const maxDepth = Math.max(0, ...depth.values());
  for (let d = 0; d <= maxDepth; d += 1) {
    const ids = byDepth.get(d) ?? [];
    ids.forEach((id, index) => {
      positions.set(id, {
        x: LAYOUT_X0 + d * LAYOUT_H_GAP,
        y: LAYOUT_Y0 + (index - (ids.length - 1) / 2) * LAYOUT_V_GAP,
      });
    });
  }

  return positions;
}

export const JOIN_LAYOUT_METRICS = {
  hGap: LAYOUT_H_GAP,
  vGap: LAYOUT_V_GAP,
} as const;
