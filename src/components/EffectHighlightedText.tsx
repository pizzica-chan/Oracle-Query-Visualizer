import type { EffectTextSegment } from '../lib/effect-text-highlight';
import { aliasTooltipFor, segmentEffectText } from '../lib/effect-text-highlight';
import type { ParsedQuery } from '../lib/types';

interface EffectHighlightedTextProps {
  text: string;
  query?: ParsedQuery;
  className?: string;
}

function renderSegment(segment: EffectTextSegment, index: number, query?: ParsedQuery) {
  if (!segment.kind) {
    return <span key={index}>{segment.text}</span>;
  }
  // 別名にマウスを載せると実テーブル名が出る。別名の解決を切り替えなくても、どのテーブルか確かめられる
  const aliasTooltip = aliasTooltipFor(segment, query);
  return (
    <span
      key={index}
      className={`effect-hl effect-hl--${segment.kind}${aliasTooltip ? ' effect-hl--alias' : ''}`}
      title={aliasTooltip}
    >
      {segment.text}
    </span>
  );
}

export function EffectHighlightedText({ text, query, className }: EffectHighlightedTextProps) {
  const segments = segmentEffectText(text, query);
  return (
    <span className={className ? `effect-highlighted-text ${className}` : 'effect-highlighted-text'}>
      {segments.map((segment, index) => renderSegment(segment, index, query))}
    </span>
  );
}
