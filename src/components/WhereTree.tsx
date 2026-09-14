import type { ConditionNode, SourceSpan } from '../lib/types';
import { sourceSelectableProps, type OnSourceSpanSelect } from '../lib/source-link';
import { SubqueryDetail } from './SubqueryDetail';

interface WhereTreeProps {
  root?: ConditionNode;
  title?: string;
  nested?: boolean;
  resolveAliases?: boolean;
  activeSourceSpan?: SourceSpan | null;
  onSourceSpanSelect?: OnSourceSpanSelect;
}

const TYPE_LABELS: Record<string, string> = {
  and: 'AND（すべて満たす）',
  or: 'OR（いずれか満たす）',
  not: 'NOT（否定）',
  comparison: '比較',
  in: 'IN',
  between: 'BETWEEN',
  like: 'LIKE',
  is_null: 'IS NULL',
  exists: 'EXISTS',
  subquery: 'サブクエリ',
  function: '関数',
  raw: '条件',
};

const TYPE_ICONS: Record<string, string> = {
  and: '∧',
  or: '∨',
  not: '¬',
  comparison: '=',
  in: '∈',
  between: '↔',
  like: '~',
  is_null: '∅',
  exists: '∃',
  subquery: '⊂',
  function: 'ƒ',
  raw: '•',
};

function ConditionCard({
  node,
  depth = 0,
  resolveAliases = false,
  activeSourceSpan = null,
  onSourceSpanSelect,
}: {
  node: ConditionNode;
  depth?: number;
  resolveAliases?: boolean;
  activeSourceSpan?: SourceSpan | null;
  onSourceSpanSelect?: OnSourceSpanSelect;
}) {
  const isGroup = node.type === 'and' || node.type === 'or' || node.type === 'not';
  const hasChildren = node.children && node.children.length > 0;

  if (isGroup && hasChildren) {
    const groupClass = `condition-group condition-group--${node.type}`;
    const groupProps = onSourceSpanSelect
      ? sourceSelectableProps(node.sourceSpan, activeSourceSpan, onSourceSpanSelect, groupClass)
      : { className: groupClass };

    return (
      <div
        {...groupProps}
        style={{ marginLeft: depth * 12 }}
      >
        <div className="condition-group-header">
          <span className="condition-icon">{TYPE_ICONS[node.type]}</span>
          <span className="condition-type-label">{TYPE_LABELS[node.type]}</span>
        </div>
        <div className="condition-group-body">
          {node.children!.map((child, i) => (
            <div key={child.id} className="condition-group-item">
              {i > 0 && node.type !== 'not' && (
                <div className={`condition-connector condition-connector--${node.type}`}>
                  {node.type.toUpperCase()}
                </div>
              )}
              <ConditionCard
                node={child}
                depth={depth + 1}
                resolveAliases={resolveAliases}
                activeSourceSpan={activeSourceSpan}
                onSourceSpanSelect={onSourceSpanSelect}
              />
            </div>
          ))}
        </div>
      </div>
    );
  }

  const leafClass = `condition-leaf condition-leaf--${node.type}`;
  const leafProps = onSourceSpanSelect
    ? sourceSelectableProps(node.sourceSpan, activeSourceSpan, onSourceSpanSelect, leafClass)
    : { className: leafClass };

  return (
    <div
      {...leafProps}
      style={{ marginLeft: depth * 12 }}
    >
      <span className="condition-icon">{TYPE_ICONS[node.type] ?? '•'}</span>
      <div className="condition-leaf-content">
        <span className="condition-leaf-type">{TYPE_LABELS[node.type] ?? node.type}</span>
        <code className="condition-leaf-label">{node.label}</code>
        {node.left && node.right && node.type === 'comparison' && (
          <div className="condition-breakdown">
            <span className="cond-part cond-part--left">{node.left}</span>
            <span className="cond-part cond-part--op">{node.operator}</span>
            <span className="cond-part cond-part--right">{node.right}</span>
          </div>
        )}
        {node.nestedQuery && (
          <div className="condition-nested">
            <SubqueryDetail
              query={node.nestedQuery}
              title="サブクエリ詳細"
              resolveAliases={resolveAliases}
              compact
              activeSourceSpan={activeSourceSpan}
              onSourceSpanSelect={onSourceSpanSelect}
            />
          </div>
        )}
      </div>
    </div>
  );
}

export function WhereTree({
  root,
  title = 'WHERE',
  nested = false,
  resolveAliases = false,
  activeSourceSpan = null,
  onSourceSpanSelect,
}: WhereTreeProps) {
  if (!root) {
    return (
      <div className="empty-state">
        <p>{title} 句はありません</p>
      </div>
    );
  }

  return (
    <div className={`where-tree${nested ? ' where-tree--nested' : ''}`}>
      {!nested && (
        <div className="where-tree-header">
          <h3>{title} 条件ツリー</h3>
          <p className="where-tree-desc">
            論理演算子ごとにグループ化。IN / EXISTS 内のサブクエリも展開します。
          </p>
        </div>
      )}
      {nested && (
        <div className="where-tree-header where-tree-header--compact">
          <h4>{title}</h4>
        </div>
      )}
      <ConditionCard
        node={root}
        resolveAliases={resolveAliases}
        activeSourceSpan={activeSourceSpan}
        onSourceSpanSelect={onSourceSpanSelect}
      />
    </div>
  );
}
