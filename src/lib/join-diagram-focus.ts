export type JoinDiagramFocus =
  | { type: 'node'; nodeId: string }
  | { type: 'edge'; edgeId: string; joinId: string };

export interface JoinFocusEdge {
  id: string;
  source: string;
  target: string;
}

export interface JoinFocusHighlight {
  primaryNodeIds: ReadonlySet<string>;
  relatedNodeIds: ReadonlySet<string>;
  primaryEdgeIds: ReadonlySet<string>;
  relatedEdgeIds: ReadonlySet<string>;
}

const EMPTY_HIGHLIGHT: JoinFocusHighlight = {
  primaryNodeIds: new Set(),
  relatedNodeIds: new Set(),
  primaryEdgeIds: new Set(),
  relatedEdgeIds: new Set(),
};

export function joinIdFromEdgeId(edgeId: string): string {
  const at = edgeId.indexOf('@');
  return at === -1 ? edgeId : edgeId.slice(0, at);
}

export function toggleJoinDiagramFocus(
  current: JoinDiagramFocus | null,
  next: JoinDiagramFocus,
): JoinDiagramFocus | null {
  if (!current) return next;
  if (current.type === 'node' && next.type === 'node' && current.nodeId === next.nodeId) {
    return null;
  }
  if (current.type === 'edge' && next.type === 'edge' && current.edgeId === next.edgeId) {
    return null;
  }
  return next;
}

export function computeJoinFocusHighlight(
  focus: JoinDiagramFocus | null,
  edges: JoinFocusEdge[],
): JoinFocusHighlight {
  if (!focus) return EMPTY_HIGHLIGHT;

  if (focus.type === 'node') {
    const relatedEdgeIds = edges
      .filter((edge) => edge.source === focus.nodeId || edge.target === focus.nodeId)
      .map((edge) => edge.id);
    return {
      primaryNodeIds: new Set([focus.nodeId]),
      relatedNodeIds: new Set(),
      primaryEdgeIds: new Set(),
      relatedEdgeIds: new Set(relatedEdgeIds),
    };
  }

  const joinEdges = edges.filter(
    (edge) => edge.id === focus.joinId || edge.id.startsWith(`${focus.joinId}@`),
  );
  const relatedNodeIds = new Set<string>();
  for (const edge of joinEdges) {
    relatedNodeIds.add(edge.source);
    relatedNodeIds.add(edge.target);
  }
  const relatedEdgeIds = joinEdges.map((edge) => edge.id).filter((id) => id !== focus.edgeId);

  return {
    primaryNodeIds: new Set(),
    relatedNodeIds,
    primaryEdgeIds: new Set([focus.edgeId]),
    relatedEdgeIds: new Set(relatedEdgeIds),
  };
}

export function joinFocusNodeClass(nodeId: string, highlight: JoinFocusHighlight): string {
  if (highlight.primaryNodeIds.has(nodeId)) return 'join-focus--primary';
  if (highlight.relatedNodeIds.has(nodeId)) return 'join-focus--related';
  return '';
}

export function joinFocusEdgeClass(edgeId: string, highlight: JoinFocusHighlight): string {
  if (highlight.primaryEdgeIds.has(edgeId)) return 'join-focus--primary';
  if (highlight.relatedEdgeIds.has(edgeId)) return 'join-focus--related';
  return '';
}
