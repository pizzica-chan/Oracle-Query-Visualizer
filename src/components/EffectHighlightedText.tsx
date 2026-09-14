import type { EffectTextSegment } from '../lib/effect-text-highlight';
import { segmentEffectText } from '../lib/effect-text-highlight';
import type { ParsedQuery } from '../lib/types';

interface EffectHighlightedTextProps {
  text: string;
  query?: ParsedQuery;
  className?: string;
}

function renderSegment(segment: EffectTextSegment, index: number) {
  if (!segment.kind) {
    return <span key={index}>{segment.text}</span>;
  }
  return (
    <span key={index} className={`effect-hl effect-hl--${segment.kind}`}>
      {segment.text}
    </span>
  );
}

export function EffectHighlightedText({ text, query, className }: EffectHighlightedTextProps) {
  const segments = segmentEffectText(text, query);
  return (
    <span className={className ? `effect-highlighted-text ${className}` : 'effect-highlighted-text'}>
      {segments.map(renderSegment)}
    </span>
  );
}
