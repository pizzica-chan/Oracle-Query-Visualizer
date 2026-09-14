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
