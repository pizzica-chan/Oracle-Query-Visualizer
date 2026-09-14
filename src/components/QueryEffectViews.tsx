import type { ConditionEffectNode, EffectLine, QueryEffectMode, QueryEffectSection } from '../lib/query-effect';
import { buildQueryEffect } from '../lib/query-effect';
import type { ParsedQuery, SourceSpan } from '../lib/types';
import type { OnSourceSpanSelect } from '../lib/source-link';
import { sourceSelectableProps } from '../lib/source-link';
import { EffectHighlightedText } from './EffectHighlightedText';

export interface QueryEffectSourceLinkProps {
  activeSourceSpan?: SourceSpan | null;
  onSourceSpanSelect?: OnSourceSpanSelect;
  resolveAliases?: boolean;
}

function lineProps(
  line: EffectLine,
  activeSourceSpan: SourceSpan | null | undefined,
  onSourceSpanSelect: OnSourceSpanSelect | undefined,
  className: string,
) {
  return onSourceSpanSelect
    ? sourceSelectableProps(line.sourceSpan, activeSourceSpan, onSourceSpanSelect, className)
    : { className };
}

function renderMonoSqlLines(
  lines: EffectLine[],
  query: ParsedQuery,
  activeSourceSpan: SourceSpan | null | undefined,
  onSourceSpanSelect: OnSourceSpanSelect | undefined,
) {
  return (
    <div className="query-effect-sql-lines">
      {lines.map((line, index) => {
        const label = line.aggregateLabel ? ' query-effect-sql-line--label' : '';
        const indent = line.aggregateIndent ? ' query-effect-sql-line--indent' : '';
        const linkClass = line.sourceSpan ? ' query-effect-sql-line--link' : '';
        return (
          <div
            key={index}
            className={`query-effect-sql-line${label}${indent}${linkClass}`}
            {...lineProps(
              line,
              activeSourceSpan,
              onSourceSpanSelect,
              line.sourceSpan ? 'query-effect-sql-line--link' : '',
            )}
          >
            <EffectHighlightedText text={line.text} query={query} />
          </div>
        );
      })}
    </div>
  );
}

export function ConditionEffectTree({
  node,
  query,
  sourceLink,
}: {
  node: ConditionEffectNode;
  query: ParsedQuery;
  sourceLink: QueryEffectSourceLinkProps;
}) {
  const { activeSourceSpan, onSourceSpanSelect } = sourceLink;

  if (node.type === 'join') {
    const headerProps = onSourceSpanSelect
      ? sourceSelectableProps(
          node.sourceSpan,
          activeSourceSpan,
          onSourceSpanSelect,
          'effect-join-filter-header effect-join-filter-header--link',
        )
      : { className: 'effect-join-filter-header' };

    return (
      <div className="effect-join-filter">
        <div {...headerProps}>
          <EffectHighlightedText text={node.label ?? ''} query={query} />
        </div>
        <div className="effect-join-filter-body">
          {node.children?.map((child) => (
            <ConditionEffectTree key={child.id} node={child} query={query} sourceLink={sourceLink} />
          ))}
        </div>
      </div>
    );
  }

  if (node.type === 'leaf') {
    const leafProps = onSourceSpanSelect
      ? sourceSelectableProps(
          node.sourceSpan,
          activeSourceSpan,
          onSourceSpanSelect,
          'effect-condition-leaf effect-condition-leaf--link',
        )
      : { className: 'effect-condition-leaf' };

    return (
      <div {...leafProps}>
        <EffectHighlightedText text={node.text ?? ''} query={query} />
      </div>
    );
  }

  return (
    <div className={`effect-condition-group effect-condition-group--${node.type}`}>
      <div className="effect-condition-group-label">{node.label}</div>
      <div className="effect-condition-group-body">
        {node.children?.map((child, index) => (
          <div key={child.id} className="effect-condition-group-item">
            {index > 0 && node.type !== 'not' && (
              <div className={`effect-condition-op effect-condition-op--${node.type}`}>
                {node.type.toUpperCase()}
              </div>
            )}
            <ConditionEffectTree node={child} query={query} sourceLink={sourceLink} />
          </div>
        ))}
      </div>
    </div>
  );
}

export function QueryEffectSectionView({
  section,
  query,
  sourceLink,
  mode = 'sql',
}: {
  section: QueryEffectSection;
  query: ParsedQuery;
  sourceLink: QueryEffectSourceLinkProps;
  mode?: QueryEffectMode;
}) {
  const { activeSourceSpan, onSourceSpanSelect } = sourceLink;
  const enableSourceLink = Boolean(onSourceSpanSelect);

  return (
    <div className={`query-effect-section query-effect-section--${section.kind}`}>
      {section.title && <h4 className="query-effect-section-title">{section.title}</h4>}
      {section.presenceGroups && section.presenceGroups.length > 0 && (
        <div className="query-effect-presence">
          {section.presenceGroups.map((group, index) => (
            <div
              key={`${group.kind}-${index}`}
              className={`query-effect-presence-group query-effect-presence-group--${group.kind}`}
            >
              <div className="query-effect-presence-label">{group.label}</div>
              <ul className="query-effect-presence-entries">
                {group.entries.length === 0 ? (
                  <li className="query-effect-presence-entry query-effect-presence-entry--empty">
                    なし
                  </li>
                ) : (
                  group.entries.map((entry, entryIndex) => (
                    <li key={entryIndex} className="query-effect-presence-entry">
                      <div
                        className="query-effect-presence-table"
                        {...(enableSourceLink
                          ? lineProps(
                              { text: entry.tableLabel, sourceSpan: entry.tableSourceSpan },
                              activeSourceSpan,
                              onSourceSpanSelect,
                              'query-effect-presence-table--link',
                            )
                          : { className: 'query-effect-presence-table' })}
                      >
                        <EffectHighlightedText text={entry.tableLabel} query={query} />
                      </div>
                      {entry.join && (
                        <div className="query-effect-presence-join">
                          <div className="query-effect-presence-join-type">
                            <EffectHighlightedText text={entry.join.type} query={query} />
                          </div>
                          <div className="query-effect-presence-join-on">
                            <ConditionEffectTree
                              node={entry.join.condition}
                              query={query}
                              sourceLink={sourceLink}
                            />
                          </div>
                        </div>
                      )}
                    </li>
                  ))
                )}
              </ul>
            </div>
          ))}
        </div>
      )}
      {section.lines && section.lines.length > 0 && (
        mode === 'sql' && (section.kind === 'aggregate' || section.kind === 'info') ? (
          renderMonoSqlLines(
            section.lines,
            query,
            enableSourceLink ? activeSourceSpan : null,
            enableSourceLink ? onSourceSpanSelect : undefined,
          )
        ) : (
          <ul className="query-effect-lines">
            {section.lines.map((line, index) => (
              <li
                key={index}
                className="query-effect-line"
                {...(enableSourceLink
                  ? lineProps(line, activeSourceSpan, onSourceSpanSelect, 'query-effect-line--link')
                  : { className: 'query-effect-line' })}
              >
                <EffectHighlightedText text={line.text} query={query} />
              </li>
            ))}
          </ul>
        )
      )}
      {section.filterParts && section.filterParts.length > 0 && (
        <div className="query-effect-filter-parts">
          {section.filterParts.map((part, index) => (
            <div key={`${part.label}-${index}`} className="query-effect-filter-part">
              <div className="query-effect-filter-part-label">{part.label}</div>
              <ConditionEffectTree node={part.root} query={query} sourceLink={sourceLink} />
            </div>
          ))}
        </div>
      )}
      {section.conditionRoot && (
        <ConditionEffectTree node={section.conditionRoot} query={query} sourceLink={sourceLink} />
      )}
    </div>
  );
}

/** SQL構造タブと同じ JOIN / WHERE / HAVING 条件表示 */
export function QueryEffectConditions({
  query,
  sourceLink,
  showScope = true,
}: {
  query: ParsedQuery;
  sourceLink: QueryEffectSourceLinkProps;
  showScope?: boolean;
}) {
  const effect = buildQueryEffect(query);
  const sections = effect.sections.filter((s) => {
    if (s.kind === 'scope') return showScope;
    if (s.kind === 'filter' && s.title === '行の絞り込み') return true;
    if (s.kind === 'filter' && s.title?.includes('HAVING')) return true;
    return false;
  });

  if (sections.length === 0) return null;

  return (
    <div className="query-effect-sections">
      {sections.map((section, index) => (
        <QueryEffectSectionView
          key={`${section.kind}-${section.title ?? index}`}
          section={section}
          query={query}
          sourceLink={sourceLink}
        />
      ))}
    </div>
  );
}
