import { type MouseEvent } from 'react';
import { BaseEdge, EdgeLabelRenderer, getBezierPath, type EdgeProps } from '@xyflow/react';
import { useJoinFocus } from '../contexts/join-focus-context';
import { useSourceLink } from '../contexts/source-link-context';
import { sourceSelectableProps } from '../lib/source-link';
import { joinFocusEdgeClass } from '../lib/join-diagram-focus';
import { spansEqual } from '../lib/source-span';
import {
  truncateJoinCondition,
  computeJoinEdgeLabelOffset,
  type JoinFlowEdgeData,
} from '../lib/join-flow-layout';

export function JoinFlowEdge({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  style,
  markerEnd,
  data,
  interactionWidth = 20,
}: EdgeProps) {
  const { activeSourceSpan, onSourceSpanSelect } = useSourceLink();
  const { highlight, selectEdge } = useJoinFocus();
  const edgeData = (data ?? {}) as JoinFlowEdgeData;
  const [edgePath, labelX, labelY] = getBezierPath({
    sourceX,
    sourceY,
    sourcePosition,
    targetX,
    targetY,
    targetPosition,
    curvature: edgeData.pathCurvature ?? 0.28,
  });

  const color = (style?.stroke as string | undefined) ?? '#64748b';
  const typeLines = [edgeData.joinType ?? 'JOIN'];
  if (edgeData.effectiveInner) typeLines.push('≈INNER');
  const condition = edgeData.condition?.trim() ?? '';
  const showCondition =
    edgeData.showGraphJoinCondition !== false &&
    !edgeData.compact &&
    !edgeData.isFanInConnector &&
    condition.length > 0;
  const showTypeLabel = !edgeData.isFanInConnector;
  const labelOffset = computeJoinEdgeLabelOffset(
    sourceX,
    sourceY,
    targetX,
    targetY,
    44,
    edgeData.labelOffsetFlip ?? 1,
  );
  const labelPosX = labelX + labelOffset.x;
  const labelPosY = labelY + labelOffset.y;
  const interactive = Boolean(onSourceSpanSelect && edgeData.sourceSpan);
  const isSourceLinked = interactive && spansEqual(activeSourceSpan, edgeData.sourceSpan);
  const focusClass = joinFocusEdgeClass(id, highlight);
  const pathClassName = [
    isSourceLinked ? 'join-edge-path--source-linked' : '',
    focusClass,
  ]
    .filter(Boolean)
    .join(' ');
  const typeLabelClass = `join-edge-type-label${
    edgeData.effectiveInner ? ' join-edge-type-label--effective-inner' : ''
  }${focusClass ? ` ${focusClass}` : ''}`;
  const labelColorStyle = { borderColor: color, color };
  const wrapEdgeLabelClick = (props: Record<string, unknown>) => ({
    ...props,
    onClick: (event: MouseEvent) => {
      selectEdge(id);
      (props.onClick as ((event: MouseEvent) => void) | undefined)?.(event);
    },
  });
  const typeLabelProps = interactive
    ? wrapEdgeLabelClick(
        sourceSelectableProps(
          edgeData.sourceSpan,
          activeSourceSpan,
          onSourceSpanSelect!,
          `${typeLabelClass} nopan`,
        ),
      )
    : { className: typeLabelClass, onClick: () => selectEdge(id) };
  const conditionLabelProps = interactive
    ? wrapEdgeLabelClick(
        sourceSelectableProps(
          edgeData.sourceSpan,
          activeSourceSpan,
          onSourceSpanSelect!,
          `join-edge-condition-label nopan${focusClass ? ` ${focusClass}` : ''}`,
        ),
      )
    : {
        className: `join-edge-condition-label${focusClass ? ` ${focusClass}` : ''}`,
        onClick: () => selectEdge(id),
      };

  return (
    <>
      <BaseEdge
        id={id}
        path={edgePath}
        markerEnd={markerEnd}
        style={style}
        interactionWidth={interactive ? interactionWidth : 0}
        className={pathClassName || undefined}
      />
      <EdgeLabelRenderer>
        {showTypeLabel && (
        <div
          className={`join-edge-labels nodrag nopan${interactive ? ' join-edge-labels--interactive' : ''}`}
          style={{
            position: 'absolute',
            transform: `translate(-50%, -50%) translate(${labelPosX}px,${labelPosY}px)`,
          }}
        >
          <div {...typeLabelProps} style={labelColorStyle}>
            {typeLines.map((line) => (
              <span key={line} className="join-edge-type-line">
                {line}
              </span>
            ))}
          </div>
          {showCondition && (
            <div {...conditionLabelProps}>{truncateJoinCondition(condition)}</div>
          )}
        </div>
        )}
      </EdgeLabelRenderer>
    </>
  );
}
