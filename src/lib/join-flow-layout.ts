import type { Edge, Node } from '@xyflow/react';
import { MarkerType } from '@xyflow/react';
import { effectiveInnerAnalysisByJoinId } from './join-effective-inner';
import { formatJoinDisplayType } from './parser';
import type { JoinEdge, JoinType, ParsedQuery, SourceSpan, TableRef } from './types';
import { formatTableLabel } from './alias-resolver';
import {
  computeJoinNodePositions,
  resolveJoinLayoutSources,
} from './join-graph-layout';

/** React Flow ミニマップ用 — 背景と区別できる控えめな色 */
export const MINIMAP_NODE_COLORS = {
  table: '#6b9fd4',
  derived: '#d4b06a',
  stroke: '#626c7e',
} as const;

/** JOIN 図ミニマップの表示サイズ（React Flow 既定 200×150 より小さめ） */
export const JOIN_MINIMAP_SIZE = { width: 120, height: 72 } as const;
export const JOIN_MINIMAP_COMPACT_SIZE = { width: 56, height: 36 } as const;

/** ノード上下に分散した接続ハンドル（混線低減） */
export const JOIN_NODE_SOURCE_HANDLES = ['source-top', 'source-mid', 'source-bot'] as const;
export const JOIN_NODE_TARGET_HANDLES = ['target-top', 'target-mid', 'target-bot'] as const;
export const JOIN_NODE_HANDLE_OFFSETS = ['22%', '50%', '78%'] as const;

const DEFAULT_PATH_CURVATURE = 0.28;

export const JOIN_EDGE_COLORS: Record<JoinType, string> = {
  'INNER JOIN': '#6b9fd4',
  'LEFT JOIN': '#7db88a',
  'RIGHT JOIN': '#d4b06a',
  'FULL JOIN': '#a89fd4',
  'CROSS JOIN': '#d47a7a',
  JOIN: '#6b9fd4',
};

const JOIN_COLORS = JOIN_EDGE_COLORS;

export interface JoinFlowEdgeData extends Record<string, unknown> {
  condition: string;
  joinType: string;
  effectiveInner?: boolean;
  compact?: boolean;
  /** エッジラベルの垂直オフセット方向（1 または -1） */
  labelOffsetFlip?: 1 | -1;
  /** ON 条件の SQL 位置 */
  sourceSpan?: SourceSpan;
  /** ファンインの補助エッジ（ラベルなし） */
  isFanInConnector?: boolean;
  /** ベジェ曲線の曲率 — 混線回避用 */
  pathCurvature?: number;
  /** グラフ上の ON 条件ラベルを表示する */
  showGraphJoinCondition?: boolean;
}

export const EFFECTIVE_INNER_EDGE_STYLE = {
  strokeDasharray: '7 4',
} as const;

export function isEffectiveInnerJoin(
  joinId: string,
  effectiveInnerByJoinId: Map<string, { joinId: string }>,
): boolean {
  return effectiveInnerByJoinId.has(joinId);
}

const JOIN_EDGE_CONDITION_MAX_LEN = 56;

export function truncateJoinCondition(condition: string, maxLength = JOIN_EDGE_CONDITION_MAX_LEN): string {
  const trimmed = condition.trim();
  if (trimmed.length <= maxLength) return trimmed;
  return `${trimmed.slice(0, maxLength - 1)}…`;
}

/** エッジ中点ラベルをノードと重なりにくいよう、エッジに垂直方向へずらす */
export function computeJoinEdgeLabelOffset(
  sourceX: number,
  sourceY: number,
  targetX: number,
  targetY: number,
  distance = 44,
  flip: 1 | -1 = 1,
): { x: number; y: number } {
  const dx = targetX - sourceX;
  const dy = targetY - sourceY;
  const len = Math.hypot(dx, dy);
  if (len < 1) return { x: 0, y: -distance * flip };
  return {
    x: (dy / len) * distance * flip,
    y: (-dx / len) * distance * flip,
  };
}

/** 図上の JOIN 種別ラベル（ON 条件は別ボックス — JoinFlowEdge） */
export function formatJoinEdgeLabel(join: JoinEdge, effectiveInner: boolean): string {
  const lines: string[] = [formatJoinDisplayType(join)];
  if (effectiveInner) lines.push('≈INNER');
  return lines.join('\n');
}

export interface JoinFlowNodeData extends Record<string, unknown> {
  label: string;
  table: string;
  schema?: string;
  alias?: string;
  aliasNote?: string;
  isDerived?: boolean;
  sourceSpan?: SourceSpan;
}

function tableLayoutSignature(t: TableRef): string {
  return [t.id, t.table, t.schema ?? '', t.alias ?? '', t.isDerived ? '1' : '0'].join('\0');
}

function joinLayoutSignature(j: JoinEdge): string {
  return [j.id, j.type, j.sourceId, j.targetId, j.condition, j.isNatural ? '1' : '0'].join('\0');
}

/** JOIN 図のレイアウト変更検知用 — useEffect の依存はこれだけに限定する */
export function computeJoinLayoutKey(
  tables: TableRef[],
  joins: JoinEdge[],
  resolveAliases: boolean,
  query?: ParsedQuery,
  compact = false,
): string {
  const effectiveInnerKey = query
    ? [...effectiveInnerAnalysisByJoinId(query).keys()].sort().join(',')
    : '';
  const tablesKey = tables.map(tableLayoutSignature).join('|');
  const joinsKey = joins.map(joinLayoutSignature).join('|');
  return `${tablesKey}:${joinsKey}:${resolveAliases}:${effectiveInnerKey}:${compact}`;
}

export function minimapNodeColor(node: Node): string {
  const data = node.data as JoinFlowNodeData;
  return data.isDerived ? MINIMAP_NODE_COLORS.derived : MINIMAP_NODE_COLORS.table;
}

function nodeCenterY(node: Node | undefined): number {
  if (!node) return 0;
  return node.position.y + (node.height ?? 88) / 2;
}

function pickHandleSlot(index: number, count: number, slotCount: number): number {
  if (count <= 1) return Math.floor(slotCount / 2);
  return Math.round((index / (count - 1)) * (slotCount - 1));
}

/** 同一ノードに集中するエッジを上下ハンドルへ分散 */
export function assignJoinEdgeHandles(edges: Edge[], nodes: Node[]): Edge[] {
  const nodeById = new Map(nodes.map((n) => [n.id, n]));
  const centerY = (nodeId: string) => nodeCenterY(nodeById.get(nodeId));

  const byTarget = new Map<string, Edge[]>();
  const bySource = new Map<string, Edge[]>();
  for (const edge of edges) {
    const tg = byTarget.get(edge.target) ?? [];
    tg.push(edge);
    byTarget.set(edge.target, tg);
    const sg = bySource.get(edge.source) ?? [];
    sg.push(edge);
    bySource.set(edge.source, sg);
  }

  for (const group of byTarget.values()) {
    group.sort((a, b) => centerY(a.source) - centerY(b.source));
  }
  for (const group of bySource.values()) {
    group.sort((a, b) => centerY(a.target) - centerY(b.target));
  }

  return edges.map((edge) => {
    const targetGroup = byTarget.get(edge.target) ?? [edge];
    const sourceGroup = bySource.get(edge.source) ?? [edge];
    const targetIndex = targetGroup.findIndex((e) => e.id === edge.id);
    const sourceIndex = sourceGroup.findIndex((e) => e.id === edge.id);
    const targetSlot = pickHandleSlot(
      targetIndex,
      targetGroup.length,
      JOIN_NODE_TARGET_HANDLES.length,
    );
    const sourceSlot = pickHandleSlot(
      sourceIndex,
      sourceGroup.length,
      JOIN_NODE_SOURCE_HANDLES.length,
    );
    const targetSpread = targetIndex - (targetGroup.length - 1) / 2;
    const sourceSpread = sourceIndex - (sourceGroup.length - 1) / 2;

    return {
      ...edge,
      targetHandle: JOIN_NODE_TARGET_HANDLES[targetSlot],
      sourceHandle: JOIN_NODE_SOURCE_HANDLES[sourceSlot],
      data: {
        ...edge.data,
        pathCurvature:
          DEFAULT_PATH_CURVATURE +
          Math.abs(targetSpread) * 0.05 +
          Math.abs(sourceSpread) * 0.04,
      },
    };
  });
}

/** JOIN 図のノード・エッジを生成（純粋関数 — コンポーネント外でテスト可能） */
export function buildJoinFlowLayout(
  tables: TableRef[],
  joins: JoinEdge[],
  resolveAliases: boolean,
  query?: ParsedQuery,
  compact = false,
): { nodes: Node[]; edges: Edge[] } {
  const effectiveInnerByJoinId = query ? effectiveInnerAnalysisByJoinId(query) : new Map();
  const nodePositions = computeJoinNodePositions(tables, joins);

  const nodes: Node[] = tables.map((t) => {
    const label = formatTableLabel(t, resolveAliases);
    const hasExtraLine = Boolean(t.schema || t.alias || label.aliasNote);
    const position = nodePositions.get(t.id) ?? { x: 0, y: 72 };
    return {
      id: t.id,
      type: 'tableNode',
      position,
      // ミニマップ表示に必須（onNodesChange による計測前のフォールバック）
      width: 176,
      height: hasExtraLine ? 108 : 88,
      data: {
        label: label.primary,
        table: t.table,
        schema: t.schema,
        alias: t.alias,
        aliasNote: label.aliasNote,
        isDerived: t.isDerived,
        sourceSpan: t.sourceSpan,
      },
    };
  });

  const edges: Edge[] = [];
  joins.forEach((j, joinIndex) => {
    const effectiveInner = isEffectiveInnerJoin(j.id, effectiveInnerByJoinId);
    const baseColor = JOIN_COLORS[j.type] ?? '#64748b';
    const color = effectiveInner ? (JOIN_COLORS['INNER JOIN'] ?? baseColor) : baseColor;
    const sources = resolveJoinLayoutSources(j, tables);
    const anchorId = sources[sources.length - 1] ?? j.sourceId;

    for (const sourceId of sources) {
      const isPrimary = sourceId === anchorId;
      edges.push({
        id: isPrimary ? j.id : `${j.id}@${sourceId}`,
        type: 'joinEdge',
        source: sourceId,
        target: j.targetId,
        animated: isPrimary && effectiveInner,
        style: {
          stroke: color,
          strokeWidth: isPrimary ? (effectiveInner ? 2.5 : 2) : 1.5,
          opacity: isPrimary ? 1 : 0.75,
          ...(isPrimary && effectiveInner ? EFFECTIVE_INNER_EDGE_STYLE : {}),
        },
        markerEnd: { type: MarkerType.ArrowClosed, color },
        interactionWidth: 24,
        data: {
          condition: j.condition,
          joinType: formatJoinDisplayType(j),
          effectiveInner: isPrimary ? effectiveInner : false,
          compact,
          labelOffsetFlip: joinIndex % 2 === 0 ? 1 : -1,
          sourceSpan: j.sourceSpan,
          isFanInConnector: !isPrimary,
        } satisfies JoinFlowEdgeData,
      });
    }
  });

  return { nodes, edges: assignJoinEdgeHandles(edges, nodes) };
}

/** ミニマップ表示の前提条件（回帰テスト用） */
export function assertJoinFlowLayoutReady(nodes: Node[]): void {
  if (nodes.length === 0) return;
  for (const node of nodes) {
    if (!node.width || !node.height) {
      throw new Error(`node ${node.id} missing width/height for minimap`);
    }
    if (node.width <= 0 || node.height <= 0) {
      throw new Error(`node ${node.id} has invalid dimensions`);
    }
  }
}
