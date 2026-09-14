import type { ReactNode } from 'react';
import type { SourceSpan, UnionBranch } from '../lib/types';
import type { OnSourceSpanSelect } from '../lib/source-link';
import { JoinDiagram } from './JoinDiagram';

interface UnionJoinPanelProps {
  branches: UnionBranch[];
  resolveAliases: boolean;
  activeSourceSpan?: SourceSpan | null;
  onSourceSpanSelect?: OnSourceSpanSelect;
  isActive?: boolean;
}

interface UnionBranchShellProps {
  branches: UnionBranch[];
  title: string;
  description: string;
  singleBranch: (branch: UnionBranch) => ReactNode;
  renderBranch: (branch: UnionBranch, index: number) => ReactNode;
}

function UnionBranchShell({
  branches,
  title,
  description,
  singleBranch,
  renderBranch,
}: UnionBranchShellProps) {
  if (branches.length <= 1) {
    const branch = branches[0];
    if (!branch) return null;
    return singleBranch(branch);
  }

  return (
    <div className="union-panel">
      <div className="union-panel-header">
        <h3>
          {title} ({branches.length})
        </h3>
        <p>{description}</p>
      </div>
      {branches.map((branch, index) => (
        <div key={branch.id} className="union-branch">
          {index > 0 && branch.operator && (
            <div className="union-connector">{branch.operator}</div>
          )}
          {renderBranch(branch, index)}
        </div>
      ))}
    </div>
  );
}

function BranchSectionTitle({ index }: { index: number }) {
  return <h4 className="union-branch-section-title">ブランチ {index + 1}</h4>;
}

export function UnionJoinPanel({
  branches,
  resolveAliases,
  activeSourceSpan,
  onSourceSpanSelect,
  isActive = true,
}: UnionJoinPanelProps) {
  return (
    <UnionBranchShell
      branches={branches}
      title="UNION 全ブランチ"
      description="各 SELECT の FROM / JOIN を個別に表示しています"
      singleBranch={(branch) => (
        <JoinDiagram
          tables={branch.query.tables}
          joins={branch.query.joins}
          resolveAliases={resolveAliases}
          query={branch.query}
          activeSourceSpan={activeSourceSpan}
          onSourceSpanSelect={onSourceSpanSelect}
          isActive={isActive}
        />
      )}
      renderBranch={(branch, index) => (
        <div className="union-branch-section">
          <BranchSectionTitle index={index} />
          <JoinDiagram
            tables={branch.query.tables}
            joins={branch.query.joins}
            resolveAliases={resolveAliases}
            query={branch.query}
            activeSourceSpan={activeSourceSpan}
            onSourceSpanSelect={onSourceSpanSelect}
            isActive={isActive}
          />
        </div>
      )}
    />
  );
}
