import { useCallback, useEffect, useMemo } from 'react';
import { useEdgesState, useNodesState, type Edge, type Node } from '@xyflow/react';
import { buildJoinFlowLayout, computeJoinLayoutKey } from '../lib/join-flow-layout';
import type { ParsedQuery } from '../lib/types';

export interface UseJoinFlowStateResult {
  layoutKey: string;
  flowNodes: Node[];
  flowEdges: Edge[];
  onNodesChange: ReturnType<typeof useNodesState>[2];
  onEdgesChange: ReturnType<typeof useEdgesState>[2];
  resetLayout: () => void;
}

/**
 * React Flow 用の nodes/edges 状態。
 *
 * 再発防止:
 * - buildJoinFlowLayout の結果は useMemo + layoutKey で安定化すること
 * - useEffect の同期は layoutKey 変更時のみ（nodes/edges 参照を effect 依存に単独で置かない）
 * - useNodesState + onNodesChange が無いとミニマップが空になる
 * - フックは条件分岐前に呼ぶこと（JoinDiagramFlow に分離）
 */
export function useJoinFlowState(
  tables: Parameters<typeof buildJoinFlowLayout>[0],
  joins: Parameters<typeof buildJoinFlowLayout>[1],
  resolveAliases: boolean,
  query?: ParsedQuery,
  compact = false,
): UseJoinFlowStateResult {
  const layoutKey = useMemo(
    () => computeJoinLayoutKey(tables, joins, resolveAliases, query, compact),
    [tables, joins, resolveAliases, query, compact],
  );

  const { nodes, edges } = useMemo(
    () => buildJoinFlowLayout(tables, joins, resolveAliases, query, compact),
    [layoutKey, tables, joins, resolveAliases, query, compact],
  );

  const [flowNodes, setFlowNodes, onNodesChange] = useNodesState(nodes);
  const [flowEdges, setFlowEdges, onEdgesChange] = useEdgesState(edges);

  useEffect(() => {
    setFlowNodes(nodes);
    setFlowEdges(edges);
    // layoutKey のみを依存にする — nodes/edges 配列参照は毎レンダー変わり得て無限ループの原因になる
    // eslint-disable-next-line react-hooks/exhaustive-deps -- nodes/edges は layoutKey と同期した useMemo 結果
  }, [layoutKey, setFlowNodes, setFlowEdges]);

  const resetLayout = useCallback(() => {
    setFlowNodes(nodes);
    setFlowEdges(edges);
  }, [nodes, edges, setFlowNodes, setFlowEdges]);

  return { layoutKey, flowNodes, flowEdges, onNodesChange, onEdgesChange, resetLayout };
}
