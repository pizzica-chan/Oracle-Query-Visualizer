import { type MouseEvent, type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Background,
  Controls,
  Handle,
  MiniMap,
  Position,
  ReactFlow,
  type Edge,
  type Node,
  type NodeProps,
} from '@xyflow/react';
import '@xyflow/react/dist/base.css';
import { JoinFlowEdge } from './JoinFlowEdge';
import { JoinFocusContextProvider, useJoinFocus } from '../contexts/join-focus-context';
import { SourceLinkContext, useSourceLink } from '../contexts/source-link-context';
import { useJoinFlowState } from '../hooks/useJoinFlowState';
import { effectiveInnerAnalysisByJoinId } from '../lib/join-effective-inner';
import { formatJoinTableLink } from '../lib/join-graph-layout';
import {
  computeJoinFocusHighlight,
  joinFocusNodeClass,
  joinIdFromEdgeId,
  toggleJoinDiagramFocus,
  type JoinDiagramFocus,
} from '../lib/join-diagram-focus';
import { decideJoinDiagramFit, planJoinDiagramFit } from '../lib/join-diagram-fit';
import {
  JOIN_EDGE_COLORS,
  JOIN_MINIMAP_COMPACT_SIZE,
  JOIN_MINIMAP_SIZE,
  JOIN_NODE_HANDLE_OFFSETS,
  JOIN_NODE_SOURCE_HANDLES,
  JOIN_NODE_TARGET_HANDLES,
  MINIMAP_NODE_COLORS,
  minimapNodeColor,
  type JoinFlowNodeData,
  type JoinFlowEdgeData,
} from '../lib/join-flow-layout';
import { sourceSelectableProps, toggleSourceSpan, type OnSourceSpanSelect } from '../lib/source-link';
import type { JoinEdge, ParsedQuery, SourceSpan, TableRef } from '../lib/types';

/** fitView の実測待ちを諦めるまでのフレーム数（約 1 秒） */
const FIT_MAX_ATTEMPTS = 60;

/** JoinDiagram が使う ReactFlow インスタンスの部分型 */
interface JoinDiagramFlowInstance {
  fitView: (options?: { padding?: number }) => Promise<boolean>;
  getNodes: () => { measured?: { width?: number; height?: number } }[];
}

interface JoinDiagramProps {
  tables: TableRef[];
  joins: JoinEdge[];
  resolveAliases: boolean;
  compact?: boolean;
  query?: ParsedQuery;
  activeSourceSpan?: SourceSpan | null;
  onSourceSpanSelect?: OnSourceSpanSelect;
  /** false のとき非表示だがマウントは維持（タブ切替で配置を保持） */
  isActive?: boolean;
}

const JOIN_COLORS = JOIN_EDGE_COLORS;

function TableNode({ id, data: raw }: NodeProps) {
  const data = raw as JoinFlowNodeData;
  const { activeSourceSpan, onSourceSpanSelect } = useSourceLink();
  const { highlight, selectNode } = useJoinFocus();
  const focusClass = joinFocusNodeClass(id, highlight);
  const baseProps = onSourceSpanSelect
    ? sourceSelectableProps(
        data.sourceSpan,
        activeSourceSpan,
        onSourceSpanSelect,
        `table-node nopan${focusClass ? ` ${focusClass}` : ''}`,
      )
    : { className: `table-node${focusClass ? ` ${focusClass}` : ''}` };
  const selectable = {
    ...baseProps,
    onClick: (event: MouseEvent) => {
      selectNode(id);
      (baseProps as { onClick?: (event: MouseEvent) => void }).onClick?.(event);
    },
  };

  return (
    <div {...selectable}>
      {JOIN_NODE_TARGET_HANDLES.map((id, index) => (
        <Handle
          key={id}
          id={id}
          type="target"
          position={Position.Left}
          className="table-handle table-handle--distributed"
          style={{ top: JOIN_NODE_HANDLE_OFFSETS[index] }}
        />
      ))}
      <div className="table-node-header">{data.isDerived ? 'DERIVED' : 'TABLE'}</div>
      <div className="table-node-name">{data.table}</div>
      {data.schema && <div className="table-node-schema">{data.schema}</div>}
      {data.aliasNote && (
        <div className="table-node-alias">
          エイリアス: <span>{data.aliasNote}</span>
        </div>
      )}
      {!data.aliasNote && data.alias && (
        <div className="table-node-alias">
          AS <span>{data.alias}</span>
        </div>
      )}
      {JOIN_NODE_SOURCE_HANDLES.map((id, index) => (
        <Handle
          key={id}
          id={id}
          type="source"
          position={Position.Right}
          className="table-handle table-handle--distributed"
          style={{ top: JOIN_NODE_HANDLE_OFFSETS[index] }}
        />
      ))}
    </div>
  );
}

const nodeTypes = { tableNode: TableNode };
const edgeTypes = { joinEdge: JoinFlowEdge };

interface JoinDiagramFlowProps {
  tables: TableRef[];
  joins: JoinEdge[];
  resolveAliases: boolean;
  compact: boolean;
  query?: ParsedQuery;
  activeSourceSpan?: SourceSpan | null;
  onSourceSpanSelect?: OnSourceSpanSelect;
  isActive: boolean;
}

function JoinDiagramFlow({
  tables,
  joins,
  resolveAliases,
  compact,
  query,
  activeSourceSpan = null,
  onSourceSpanSelect,
  isActive = true,
}: JoinDiagramFlowProps) {
  const effectiveInnerByJoin = query ? effectiveInnerAnalysisByJoinId(query) : new Map();
  const hasEffectiveInner = effectiveInnerByJoin.size > 0;
  const [showGraphJoinConditions, setShowGraphJoinConditions] = useState(true);
  const [joinFocus, setJoinFocus] = useState<JoinDiagramFocus | null>(null);

  const { flowNodes, flowEdges, onNodesChange, onEdgesChange, layoutKey, resetLayout } =
    useJoinFlowState(tables, joins, resolveAliases, query, compact);

  useEffect(() => {
    setJoinFocus(null);
  }, [layoutKey]);

  const reactFlowRef = useRef<JoinDiagramFlowInstance | null>(null);
  const flowWrapRef = useRef<HTMLDivElement>(null);
  const fitStateRef = useRef({ lastFitLayoutKey: null as string | null, needsFitOnShow: true });
  /** 進行中の実測待ちループを識別する。値が変わったループは打ち切る */
  const fitRunRef = useRef(0);

  // アンマウント後もリトライが回り続けないよう、世代を進めて打ち切る
  useEffect(() => () => {
    fitRunRef.current += 1;
  }, []);

  /**
   * display:none が解除された直後はコンテナも measured も 0 のままで、
   * その状態で fitView するとグラフ中心が画面左上に来る viewport が確定してしまう。
   * fitView の戻り値は常に true で成否判定に使えないため、呼ぶ前に実測が揃うのを待つ。
   */
  const fitDiagramView = useCallback(() => {
    const run = fitRunRef.current + 1;
    fitRunRef.current = run;

    const attemptFit = (attempt: number) => {
      requestAnimationFrame(() => {
        // 新しい fit 要求やアンマウントで置き換わっていたら何もしない
        if (run !== fitRunRef.current) return;
        const instance = reactFlowRef.current;
        const wrap = flowWrapRef.current;
        const nodes = instance?.getNodes() ?? [];
        const decision = decideJoinDiagramFit(
          {
            hasInstance: Boolean(instance),
            containerWidth: wrap?.clientWidth ?? 0,
            containerHeight: wrap?.clientHeight ?? 0,
            nodeCount: nodes.length,
            measuredNodeCount: nodes.filter((n) => n.measured?.width && n.measured?.height).length,
          },
          attempt,
          FIT_MAX_ATTEMPTS,
        );

        if (decision === 'retry') {
          attemptFit(attempt + 1);
          return;
        }
        if (decision === 'fit' && instance) void instance.fitView({ padding: 0.3 });
      });
    };
    attemptFit(0);
  }, []);

  useEffect(() => {
    const plan = planJoinDiagramFit(isActive, layoutKey, fitStateRef.current);
    fitStateRef.current = {
      lastFitLayoutKey: plan.lastFitLayoutKey,
      needsFitOnShow: plan.needsFitOnShow,
    };
    if (plan.shouldFit) fitDiagramView();
  }, [layoutKey, isActive, fitDiagramView]);

  const handleInit = useCallback((instance: JoinDiagramFlowInstance) => {
    reactFlowRef.current = instance;
  }, []);

  const handleResetLayout = useCallback(() => {
    resetLayout();
    fitDiagramView();
  }, [resetLayout, fitDiagramView]);

  const displayEdges = useMemo(
    () =>
      flowEdges.map((edge) => ({
        ...edge,
        data: {
          ...edge.data,
          showGraphJoinCondition: compact ? false : showGraphJoinConditions,
        },
      })),
    [flowEdges, compact, showGraphJoinConditions],
  );

  const joinFocusHighlight = useMemo(
    () =>
      computeJoinFocusHighlight(
        joinFocus,
        displayEdges.map((edge) => ({ id: edge.id, source: edge.source, target: edge.target })),
      ),
    [joinFocus, displayEdges],
  );

  const handleNodeClick = useCallback(
    (_event: MouseEvent, node: Node) => {
      if (onSourceSpanSelect) return;
      setJoinFocus((current) =>
        toggleJoinDiagramFocus(current, { type: 'node', nodeId: node.id }),
      );
    },
    [onSourceSpanSelect],
  );

  const selectNode = useCallback((nodeId: string) => {
    setJoinFocus((current) => toggleJoinDiagramFocus(current, { type: 'node', nodeId }));
  }, []);

  const selectEdge = useCallback((edgeId: string) => {
    setJoinFocus((current) =>
      toggleJoinDiagramFocus(current, {
        type: 'edge',
        edgeId,
        joinId: joinIdFromEdgeId(edgeId),
      }),
    );
  }, []);

  const handleEdgeClick = useCallback(
    (_event: MouseEvent, edge: Edge) => {
      selectEdge(edge.id);
      if (!onSourceSpanSelect) return;
      const span = (edge.data as JoinFlowEdgeData | undefined)?.sourceSpan;
      toggleSourceSpan(span, activeSourceSpan, onSourceSpanSelect);
    },
    [activeSourceSpan, onSourceSpanSelect, selectEdge],
  );

  const handlePaneClick = useCallback(() => {
    setJoinFocus(null);
  }, []);

  return (
    <div
      className={`join-diagram${compact ? ' join-diagram--compact' : ' join-diagram--draggable'}${joinFocus ? ' join-diagram--has-focus' : ''}`}
    >
      <SourceLinkContextProvider
        activeSourceSpan={activeSourceSpan}
        onSourceSpanSelect={onSourceSpanSelect}
      >
        <JoinFocusContextProvider
          highlight={joinFocusHighlight}
          hasFocus={joinFocus !== null}
          selectNode={selectNode}
          selectEdge={selectEdge}
        >
        <div className="join-diagram-flow-wrap" ref={flowWrapRef}>
          {!compact && joins.length > 0 && (
            <div className="join-diagram-toolbar">
              <button
                type="button"
                className="btn btn--ghost join-diagram-toolbar-btn"
                onClick={handleResetLayout}
              >
                配置をリセット
              </button>
              <label className="option-toggle join-diagram-toolbar-toggle">
                <input
                  type="checkbox"
                  checked={showGraphJoinConditions}
                  onChange={(event) => setShowGraphJoinConditions(event.target.checked)}
                />
                <span>グラフ上の ON 条件</span>
              </label>
            </div>
          )}
          <ReactFlow
          nodes={flowNodes}
          edges={displayEdges as Edge[]}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onInit={handleInit}
          onNodeClick={handleNodeClick}
          onEdgeClick={handleEdgeClick}
          onPaneClick={handlePaneClick}
          nodeTypes={nodeTypes}
          edgeTypes={edgeTypes}
          minZoom={0.4}
          maxZoom={1.5}
          proOptions={{ hideAttribution: true }}
          nodesDraggable={!compact}
          nodesConnectable={false}
          elementsSelectable={false}
          nodeClickDistance={6}
        >
          <Background color="#3a4049" gap={20} />
          <Controls showInteractive={false} />
          {compact ? (
            <MiniMap
              nodeColor={minimapNodeColor}
              nodeStrokeColor={MINIMAP_NODE_COLORS.stroke}
              nodeBorderRadius={2}
              maskColor="rgba(26, 29, 35, 0.65)"
              style={{
                background: '#282c34',
                width: JOIN_MINIMAP_COMPACT_SIZE.width,
                height: JOIN_MINIMAP_COMPACT_SIZE.height,
              }}
              className="join-minimap join-minimap--compact"
              zoomable={false}
              pannable={false}
            />
          ) : (
            <MiniMap
              nodeColor={minimapNodeColor}
              nodeStrokeColor={MINIMAP_NODE_COLORS.stroke}
              nodeBorderRadius={2}
              maskColor="rgba(26, 29, 35, 0.65)"
              style={{
                background: '#282c34',
                width: JOIN_MINIMAP_SIZE.width,
                height: JOIN_MINIMAP_SIZE.height,
              }}
              className="join-minimap"
            />
          )}
        </ReactFlow>
        </div>
        </JoinFocusContextProvider>
      </SourceLinkContextProvider>

      {hasEffectiveInner && !compact && (
        <div className="join-diagram-legend" aria-label="JOIN 図の凡例">
          <span className="join-legend-line join-legend-line--effective-inner" aria-hidden />
          <span className="join-legend-text">
            破線の青 = 実質 INNER JOIN 相当（LEFT/RIGHT JOIN が後続条件で無効化）
          </span>
        </div>
      )}

      {joins.length > 0 && !compact && (
        <div className="join-conditions-panel">
          <h3>JOIN 条件</h3>
          <ul>
            {joins.map((j) => {
              const effectiveInner = effectiveInnerByJoin.has(j.id);
              const edgeColor = effectiveInner
                ? JOIN_COLORS['INNER JOIN']
                : JOIN_COLORS[j.type];
              const conditionProps = onSourceSpanSelect
                ? sourceSelectableProps(
                    j.sourceSpan,
                    activeSourceSpan,
                    onSourceSpanSelect,
                    'join-condition',
                  )
                : { className: 'join-condition' };
              return (
                <li key={j.id}>
                  <span
                    className={`join-type-badge${effectiveInner ? ' join-type-badge--effective-inner' : ''}`}
                    style={{ borderColor: edgeColor, color: edgeColor }}
                  >
                    {effectiveInner ? `${j.type} ≈INNER` : j.type}
                  </span>
                  {effectiveInner && (
                    <span className="join-effective-inner-tag">実質 INNER JOIN</span>
                  )}
                  <span className="join-tables">{formatJoinTableLink(j, tables)}</span>
                  <code {...conditionProps}>{j.condition}</code>
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </div>
  );
}

function SourceLinkContextProvider({
  activeSourceSpan,
  onSourceSpanSelect,
  children,
}: {
  activeSourceSpan: SourceSpan | null;
  onSourceSpanSelect?: OnSourceSpanSelect;
  children: ReactNode;
}) {
  return (
    <SourceLinkContext.Provider value={{ activeSourceSpan, onSourceSpanSelect }}>
      {children}
    </SourceLinkContext.Provider>
  );
}

export function JoinDiagram({
  tables,
  joins,
  resolveAliases,
  compact = false,
  query,
  activeSourceSpan = null,
  onSourceSpanSelect,
  isActive = true,
}: JoinDiagramProps) {
  if (tables.length === 0) {
    return (
      <div className="empty-state">
        <p>FROM句にテーブルが見つかりません</p>
      </div>
    );
  }

  return (
    <JoinDiagramFlow
      tables={tables}
      joins={joins}
      resolveAliases={resolveAliases}
      compact={compact}
      query={query}
      activeSourceSpan={activeSourceSpan}
      onSourceSpanSelect={onSourceSpanSelect}
      isActive={isActive}
    />
  );
}
