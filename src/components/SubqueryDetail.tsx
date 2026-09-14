import { JoinDiagram } from './JoinDiagram';
import { QueryEffectConditions } from './QueryEffectViews';
import type { ParsedQuery, SourceSpan } from '../lib/types';
import type { OnSourceSpanSelect } from '../lib/source-link';
import { sourceSelectableProps } from '../lib/source-link';
import { buildQueryEffect } from '../lib/query-effect';

interface SubqueryDetailProps {
  query: ParsedQuery;
  title: string;
  resolveAliases: boolean;
  compact?: boolean;
  activeSourceSpan?: SourceSpan | null;
  onSourceSpanSelect?: OnSourceSpanSelect;
  /** ブランチ全体など query.sourceSpan より優先する範囲 */
  containerSourceSpan?: SourceSpan;
}

export function SubqueryDetail({
  query,
  title,
  resolveAliases,
  compact = false,
  activeSourceSpan = null,
  onSourceSpanSelect,
  containerSourceSpan,
}: SubqueryDetailProps) {
  const effect = buildQueryEffect(query);
  const hasConditions = effect.sections.some(
    (s) =>
      s.kind === 'scope' ||
      (s.kind === 'filter' && s.title === '行の絞り込み') ||
      (s.kind === 'filter' && s.title?.includes('HAVING')),
  );
  const sourceLink = { activeSourceSpan, onSourceSpanSelect, resolveAliases };
  const boxSpan = containerSourceSpan ?? query.sourceSpan;
  const boxProps = onSourceSpanSelect
    ? sourceSelectableProps(
        boxSpan,
        activeSourceSpan,
        onSourceSpanSelect,
        `subquery-detail${compact ? ' subquery-detail--compact' : ''} subquery-detail--link`,
      )
    : { className: `subquery-detail${compact ? ' subquery-detail--compact' : ''}` };

  return (
    <div {...boxProps}>
      <div className="subquery-detail-header">
        <h4>{title}</h4>
        <span className="subquery-detail-meta">
          {query.tables.length} テーブル · {query.joins.length} JOIN
          {query.where ? ' · WHEREあり' : ''}
        </span>
      </div>

      {query.tables.length > 0 && (
        <div className="subquery-detail-section">
          <h5 className="subquery-detail-section-title">JOIN 図</h5>
          <JoinDiagram
            tables={query.tables}
            joins={query.joins}
            resolveAliases={resolveAliases}
            compact
            query={query}
            activeSourceSpan={activeSourceSpan}
            onSourceSpanSelect={onSourceSpanSelect}
            isActive
          />
        </div>
      )}

      {hasConditions && (
        <div className="subquery-detail-section subquery-detail-section--conditions">
          {!compact && (
            <p className="subquery-detail-section-desc">JOIN / WHERE / HAVING 条件</p>
          )}
          <QueryEffectConditions query={query} sourceLink={sourceLink} />
        </div>
      )}
    </div>
  );
}
