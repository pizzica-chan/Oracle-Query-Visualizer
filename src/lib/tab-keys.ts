import type { KeyboardEvent } from 'react';

/**
 * タブの並び（role="tablist"）の矢印キー操作。WAI-ARIA Authoring Practices の Tabs パターンに合わせ、
 * ← → で前後のタブ、Home / End で最初と最後のタブを選び、そのタブにフォーカスを移す（端では反対の端へ回る）。
 * 選ぶとすぐ表示を切り替える（自動切り替え）。タブのボタンには data-tab-id を付けておく
 */
export function handleTabListKeyDown<T extends string>(
  event: KeyboardEvent<HTMLElement>,
  ids: readonly T[],
  activeId: T,
  select: (id: T) => void,
): void {
  if (event.altKey || event.ctrlKey || event.metaKey) return;
  const index = ids.indexOf(activeId);
  let next: number;
  switch (event.key) {
    case 'ArrowRight':
      next = (index + 1) % ids.length;
      break;
    case 'ArrowLeft':
      next = (index - 1 + ids.length) % ids.length;
      break;
    case 'Home':
      next = 0;
      break;
    case 'End':
      next = ids.length - 1;
      break;
    default:
      return;
  }
  event.preventDefault();
  const id = ids[next]!;
  select(id);
  event.currentTarget.querySelector<HTMLElement>(`[data-tab-id="${id}"]`)?.focus();
}
