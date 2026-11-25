import { memo, useId } from 'react';
import { hasUnion, type SubqueryRef } from '../lib/query-utils';
import type { OnSourceSpanSelect } from '../lib/source-link';
import { handleTabListKeyDown } from '../lib/tab-keys';
import type { ParsedQuery, SourceSpan } from '../lib/types';
import { IconJoin, IconNarrative, IconNested, IconStructure } from './Icons';
import { JoinDiagram } from './JoinDiagram';
import { QueryEffectBanner } from './QueryEffectPanel';
import { SubqueryDetail } from './SubqueryDetail';
import { UnionJoinPanel } from './UnionPanel';

export type TabId = 'structure' | 'narrative' | 'joins' | 'nested';

const TAB_ICONS: Record<TabId, typeof IconStructure> = {
  structure: IconStructure,
  narrative: IconNarrative,
  joins: IconJoin,
  nested: IconNested,
};

interface AnalysisResultProps {
  query: ParsedQuery;
  tabs: readonly { id: TabId; label: string }[];
  activeTab: TabId;
  onTabChange: (tab: TabId) => void;
  subqueries: readonly SubqueryRef[];
  resolveAliases: boolean;
  onResolveAliasesChange: (value: boolean) => void;
  activeSourceSpan: SourceSpan | null;
  onSourceSpanSelect: OnSourceSpanSelect;
}

/**
 * 単一解析の結果（タブのバーと各タブの中身）。
 * memo で包み、SQL の入力中（解析結果が変わらないあいだ）は描き直さない。
 * 大きな SQL では DOM の要素が 20 万を超え、1 文字の入力ごとに描き直すと 2 秒ほど入力が止まる。
 * そのため props には、入力中に変わらない値（useMemo・useState の setter・useCallback）だけを渡す
 */
export const AnalysisResult = memo(function AnalysisResult({
  query,
  tabs,
  activeTab,
  onTabChange,
  subqueries,
  resolveAliases,
  onResolveAliasesChange,
  activeSourceSpan,
  onSourceSpanSelect,
}: AnalysisResultProps) {
  const sourceLinkProps = { activeSourceSpan, onSourceSpanSelect };
  const showNested = tabs.some((tab) => tab.id === 'nested');
  const idPrefix = useId();
  const tabIds = tabs.map((tab) => tab.id);
  const panelId = `${idPrefix}-panel`;

  return (
    <>
      <div className="tab-bar">
        {/* タブのパターン（WAI-ARIA）。選んでいるタブだけを Tab キーで止まる位置にし、タブの間は ← → で移る */}
        <div
          className="tab-list"
          role="tablist"
          aria-label="解析結果の表示"
          onKeyDown={(event) => handleTabListKeyDown(event, tabIds, activeTab, onTabChange)}
        >
          {tabs.map((tab) => {
            const TabIcon = TAB_ICONS[tab.id];
            const selected = activeTab === tab.id;
            return (
              <button
                key={tab.id}
                type="button"
                role="tab"
                id={`${idPrefix}-tab-${tab.id}`}
                data-tab-id={tab.id}
                aria-selected={selected}
                aria-controls={panelId}
                tabIndex={selected ? 0 : -1}
                className={`tab${selected ? ' tab--active' : ''}`}
                onClick={() => onTabChange(tab.id)}
              >
                <TabIcon size={15} />
                {tab.label}
                {tab.id === 'nested' && <span className="tab-count">{subqueries.length}</span>}
              </button>
            );
          })}
        </div>
        <label
          className="option-toggle tab-bar-options"
          title="オフのときも、別名にマウスを載せると実テーブル名が表示されます"
        >
          <input
            type="checkbox"
            checked={resolveAliases}
            onChange={(e) => onResolveAliasesChange(e.target.checked)}
          />
          <span>別名を実テーブル名で表示</span>
        </label>
      </div>

      <div className="tab-content" role="tabpanel" id={panelId} aria-labelledby={`${idPrefix}-tab-${activeTab}`}>
        {activeTab === 'structure' && (
          <QueryEffectBanner query={query} variant="structure" resolveAliases={resolveAliases} {...sourceLinkProps} />
        )}
        {activeTab === 'narrative' && (
          <QueryEffectBanner query={query} variant="narrative" resolveAliases={resolveAliases} />
        )}
        <div className={`tab-pane${activeTab === 'joins' ? '' : ' tab-pane--hidden'}`} aria-hidden={activeTab !== 'joins'}>
          {hasUnion(query) && query.unionBranches ? (
            <UnionJoinPanel
              branches={query.unionBranches}
              resolveAliases={resolveAliases}
              isActive={activeTab === 'joins'}
              {...sourceLinkProps}
            />
          ) : (
            <JoinDiagram
              tables={query.tables}
              joins={query.joins}
              resolveAliases={resolveAliases}
              query={query}
              isActive={activeTab === 'joins'}
              {...sourceLinkProps}
            />
          )}
        </div>
        {activeTab === 'nested' && showNested && (
          <div className="nested-tab">
            <section className="nested-section">
              <h3>サブクエリ ({subqueries.length})</h3>
              <p className="nested-section-desc">WHERE / EXISTS / IN / FROM 句内のサブクエリを個別に解析しています</p>
              <div className="nested-subquery-list">
                {subqueries.map(({ query: subquery, title }, index) => (
                  <SubqueryDetail
                    key={`${subquery.tables.map((t) => t.id).join('-')}-${title}-${index}`}
                    query={subquery}
                    title={title}
                    resolveAliases={resolveAliases}
                    {...sourceLinkProps}
                  />
                ))}
              </div>
            </section>
          </div>
        )}
      </div>
    </>
  );
});
