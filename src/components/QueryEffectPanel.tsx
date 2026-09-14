import type { QueryEffectMode, QueryEffectSection } from '../lib/query-effect';
import { buildQueryEffect, buildUnionQueryEffect } from '../lib/query-effect';
import type { ParsedQuery } from '../lib/types';
import { EffectHighlightedText } from './EffectHighlightedText';
import {
  QueryEffectSectionView,
  type QueryEffectSourceLinkProps,
} from './QueryEffectViews';

export type QueryEffectVariant = 'structure' | 'narrative';

const VARIANT_CONFIG: Record<
  QueryEffectVariant,
  {
    mode: QueryEffectMode;
    bannerTitle: string;
    unionDesc: string;
    showSummary: boolean;
    enableSourceLink: boolean;
  }
> = {
  structure: {
    mode: 'sql',
    bannerTitle: 'SQL構造',
    unionDesc: 'UNION 各ブランチの句構造（クリックで左の SQL と連動）',
    showSummary: false,
    enableSourceLink: true,
  },
  narrative: {
    mode: 'japanese',
    bannerTitle: '作用説明',
    unionDesc: 'UNION の各 SELECT が返す行の条件です（ブランチごとに独立）',
    showSummary: true,
    enableSourceLink: false,
  },
};

interface SourceLinkProps extends QueryEffectSourceLinkProps {}

function EffectSection({
  section,
  query,
  sourceLink,
  mode,
}: {
  section: QueryEffectSection;
  query: ParsedQuery;
  sourceLink: SourceLinkProps;
  mode: QueryEffectMode;
}) {
  return (
    <QueryEffectSectionView section={section} query={query} sourceLink={sourceLink} mode={mode} />
  );
}

interface QueryEffectPanelProps extends SourceLinkProps {
  query: ParsedQuery;
  branchIndex?: number;
  variant: QueryEffectVariant;
}

export function QueryEffectPanel({
  query,
  branchIndex,
  variant,
  activeSourceSpan = null,
  onSourceSpanSelect,
  resolveAliases = false,
}: QueryEffectPanelProps) {
  const config = VARIANT_CONFIG[variant];
  const effect = buildQueryEffect(query, config.mode);
  const sourceLink = config.enableSourceLink
    ? { activeSourceSpan, onSourceSpanSelect, resolveAliases }
    : { resolveAliases };

  return (
    <section className={`query-effect query-effect--${effect.action}`}>
      <div className="query-effect-header">
        <span className={`query-effect-badge query-effect-badge--${effect.action}`}>
          {effect.actionLabel}
        </span>
        {branchIndex !== undefined && (
          <span className="query-effect-branch">ブランチ {branchIndex + 1}</span>
        )}
        {config.showSummary && (
          <p className="query-effect-summary">
            <EffectHighlightedText text={effect.summary} query={query} />
          </p>
        )}
      </div>
      {effect.sections.length > 0 && (
        <div className="query-effect-sections">
          {effect.sections.map((section, index) => (
            <EffectSection
              key={`${section.kind}-${index}`}
              section={section}
              query={query}
              sourceLink={sourceLink}
              mode={config.mode}
            />
          ))}
        </div>
      )}
    </section>
  );
}

interface QueryEffectBannerProps extends SourceLinkProps {
  query: ParsedQuery;
  variant: QueryEffectVariant;
}

export function QueryEffectBanner({
  query,
  variant,
  activeSourceSpan = null,
  onSourceSpanSelect,
  resolveAliases = false,
}: QueryEffectBannerProps) {
  const config = VARIANT_CONFIG[variant];
  const unionEffect = buildUnionQueryEffect(query, config.mode);
  const sourceLinkProps = config.enableSourceLink
    ? { activeSourceSpan, onSourceSpanSelect, resolveAliases }
    : { resolveAliases };

  if (unionEffect && query.unionBranches) {
    return (
      <div className="query-effect-banner">
        <div className="query-effect-banner-header">
          <h2 className="query-effect-banner-title">{config.bannerTitle}</h2>
          <p className="query-effect-banner-desc">{config.unionDesc}</p>
        </div>
        {unionEffect.unionNotes.length > 0 && (
          <ul className="query-effect-lines query-effect-union-notes">
            {unionEffect.unionNotes.map((line, index) => (
              <li key={index} className="query-effect-line">
                <EffectHighlightedText text={line} query={query} />
              </li>
            ))}
          </ul>
        )}
        {unionEffect.branches.map((branch, index) => (
          <div key={`branch-${index}`} className="query-effect-banner-branch">
            {index > 0 && branch.operator && (
              <div className="union-connector">{branch.operator}</div>
            )}
            <QueryEffectPanel
              query={query.unionBranches![index]!.query}
              branchIndex={index}
              variant={variant}
              {...sourceLinkProps}
            />
          </div>
        ))}
      </div>
    );
  }

  return (
    <div className="query-effect-banner">
      <div className="query-effect-banner-header">
        <h2 className="query-effect-banner-title">{config.bannerTitle}</h2>
        {variant === 'structure' && (
          <p className="query-effect-banner-desc">句ごとの構造（クリックで左の SQL と連動）</p>
        )}
      </div>
      <QueryEffectPanel query={query} variant={variant} {...sourceLinkProps} />
    </div>
  );
}
