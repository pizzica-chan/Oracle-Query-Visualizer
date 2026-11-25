import type { KeyboardEvent, MouseEvent } from 'react';
import type { SourceSpan } from './types';
import { spansEqual } from './source-span';

export type OnSourceSpanSelect = (span: SourceSpan | undefined) => void;

export function toggleSourceSpan(
  span: SourceSpan | undefined,
  activeSpan: SourceSpan | null | undefined,
  onSelect: OnSourceSpanSelect,
): void {
  if (!span) return;
  onSelect(spansEqual(activeSpan, span) ? undefined : span);
}

/**
 * カーソル位置 offset を含む範囲のうち、いちばん短いもの（最も具体的な要素）の添字を返す。無ければ -1。
 * 入力中はカーソルが語の直後にあるので、範囲の終端ちょうども含める。同じ長さなら先に現れたものを選ぶ
 */
export function pickInnermostSpanIndex(spans: readonly SourceSpan[], offset: number): number {
  let best = -1;
  let bestLength = Infinity;
  spans.forEach((span, index) => {
    if (offset < span.start || offset > span.end) return;
    const length = span.end - span.start;
    if (length < bestLength) {
      best = index;
      bestLength = length;
    }
  });
  return best;
}

export function sourceSelectableProps(
  span: SourceSpan | undefined,
  activeSpan: SourceSpan | null | undefined,
  onSelect: OnSourceSpanSelect,
  className = '',
): Record<string, unknown> {
  if (!span) {
    return className ? { className } : {};
  }

  const handleActivate = () => toggleSourceSpan(span, activeSpan, onSelect);

  return {
    className: `${className}${className ? ' ' : ''}source-selectable${
      spansEqual(activeSpan, span) ? ' source-selectable--active' : ''
    }`.trim(),
    // エディタのカーソル位置から、対応する要素を探すのに使う（useCaretSourceLink）
    'data-span-start': span.start,
    'data-span-end': span.end,
    role: 'button',
    tabIndex: 0,
    onClick: (event: MouseEvent) => {
      event.stopPropagation();
      handleActivate();
    },
    onKeyDown: (event: KeyboardEvent) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        event.stopPropagation();
        handleActivate();
      }
    },
  };
}
