import { describe, expect, it } from 'vitest';
import {
  computeJoinFocusHighlight,
  joinIdFromEdgeId,
  toggleJoinDiagramFocus,
} from './join-diagram-focus';

const edges = [
  { id: 'join-1', source: 'tbl-1', target: 'tbl-2' },
  { id: 'join-2', source: 'tbl-2', target: 'tbl-3' },
  { id: 'join-3@tbl-1', source: 'tbl-1', target: 'tbl-4' },
  { id: 'join-3@tbl-2', source: 'tbl-2', target: 'tbl-4' },
  { id: 'join-3', source: 'tbl-3', target: 'tbl-4' },
];

describe('join-diagram-focus', () => {
  it('joinIdFromEdgeId はファンイン補助線の @ 以降を除去する', () => {
    expect(joinIdFromEdgeId('join-3')).toBe('join-3');
    expect(joinIdFromEdgeId('join-3@tbl-1')).toBe('join-3');
  });

  it('テーブル選択時はボックスを primary、接続エッジを related にする', () => {
    const highlight = computeJoinFocusHighlight({ type: 'node', nodeId: 'tbl-2' }, edges);
    expect([...highlight.primaryNodeIds]).toEqual(['tbl-2']);
    expect([...highlight.relatedNodeIds]).toEqual([]);
    expect([...highlight.primaryEdgeIds]).toEqual([]);
    expect([...highlight.relatedEdgeIds].sort()).toEqual(['join-1', 'join-2', 'join-3@tbl-2'].sort());
  });

  it('JOIN エッジ選択時はエッジを primary、関連テーブルと同 JOIN の他エッジを related にする', () => {
    const highlight = computeJoinFocusHighlight(
      { type: 'edge', edgeId: 'join-3@tbl-1', joinId: 'join-3' },
      edges,
    );
    expect([...highlight.primaryNodeIds]).toEqual([]);
    expect([...highlight.relatedNodeIds].sort()).toEqual(['tbl-1', 'tbl-2', 'tbl-3', 'tbl-4'].sort());
    expect([...highlight.primaryEdgeIds]).toEqual(['join-3@tbl-1']);
    expect([...highlight.relatedEdgeIds].sort()).toEqual(['join-3', 'join-3@tbl-2'].sort());
  });

  it('toggleJoinDiagramFocus は同一要素の再クリックで解除する', () => {
    const focus = { type: 'node' as const, nodeId: 'tbl-1' };
    expect(toggleJoinDiagramFocus(focus, focus)).toBeNull();
    expect(
      toggleJoinDiagramFocus(focus, { type: 'edge', edgeId: 'join-1', joinId: 'join-1' }),
    ).toEqual({ type: 'edge', edgeId: 'join-1', joinId: 'join-1' });
  });
});
