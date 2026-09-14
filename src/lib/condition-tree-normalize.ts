import type { ConditionNode } from './types';

type GroupType = 'and' | 'or';

function flattenSameType(type: GroupType, children: ConditionNode[]): ConditionNode[] {
  return children.flatMap((child) => {
    if (child.type === type && child.children?.length) {
      return child.children;
    }
    return [child];
  });
}

/** 連続する AND/OR の入れ子を1段にまとめ、子1つのグループは外す（NOT の内側は維持） */
export function normalizeConditionTree(node: ConditionNode): ConditionNode {
  const withChildren: ConditionNode = node.children?.length
    ? { ...node, children: node.children.map(normalizeConditionTree) }
    : node;

  if (withChildren.type !== 'and' && withChildren.type !== 'or') {
    return withChildren;
  }

  const flattened = flattenSameType(withChildren.type, withChildren.children ?? []);
  if (flattened.length === 1) {
    return flattened[0]!;
  }

  return { ...withChildren, children: flattened };
}

export function collectConditionLeaves(node: ConditionNode | undefined): ConditionNode[] {
  if (!node) return [];
  if (node.type !== 'and' && node.type !== 'or' && node.type !== 'not') {
    return [node];
  }
  if (node.type === 'not') {
    return collectConditionLeaves(node.children?.[0]);
  }
  return (node.children ?? []).flatMap(collectConditionLeaves);
}

export function countConditionNodes(
  node: ConditionNode | undefined,
  type: ConditionNode['type'],
): number {
  if (!node) return 0;
  return (
    (node.type === type ? 1 : 0) +
    (node.children ?? []).reduce((n, c) => n + countConditionNodes(c, type), 0)
  );
}
