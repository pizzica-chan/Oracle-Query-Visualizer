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

  // 配置のキーが同じでも、SQL を編集すると要素の範囲（sourceSpan）などの中身は変わる。
  // 配置（利用者がドラッグした位置を含む）は残し、中身だけを新しい解析結果に差し替える。
  // 差し替えないと、列を足しただけの編集のあとで、ノードや線のクリックとカーソル連動が SQL の古い位置を指す
  useEffect(() => {
    const freshNodes = new Map(nodes.map((node) => [node.id, node]));
    const freshEdges = new Map(edges.map((edge) => [edge.id, edge]));
    setFlowNodes((current) =>
      current.map((node) => {
        const fresh = freshNodes.get(node.id);
        return fresh && fresh.data !== node.data ? { ...node, data: fresh.data } : node;
      }),
    );
    setFlowEdges((current) =>
      current.map((edge) => {
        const fresh = freshEdges.get(edge.id);
        return fresh && fresh.data !== edge.data ? { ...edge, data: fresh.data } : edge;
      }),
    );
  }, [nodes, edges, setFlowNodes, setFlowEdges]);

  const resetLayout = useCallback(() => {
    setFlowNodes(nodes);
    setFlowEdges(edges);
  }, [nodes, edges, setFlowNodes, setFlowEdges]);

  return { layoutKey, flowNodes, flowEdges, onNodesChange, onEdgesChange, resetLayout };
}
