import { useEffect, useRef, type RefObject } from 'react';
import { pickInnermostSpanIndex } from '../lib/source-link';
import type { SourceSpan } from '../lib/types';

const CARET_CLASS = 'source-selectable--caret';

/**
 * カーソル位置 caretOffset に対応する要素へ印のクラスを付け、それ以外から外す。付けた要素を返す。
 * すでに正しい状態なら DOM を変えない（MutationObserver から呼んでも、変更の連鎖が起きないように）
 */
function applyCaretClass(container: HTMLElement, caretOffset: number | null): HTMLElement | null {
  let target: HTMLElement | null = null;
  if (caretOffset !== null) {
    // 非表示のタブ（JOIN 図はマウントしたまま隠している）の要素は対象にしない
    const elements = Array.from(container.querySelectorAll<HTMLElement>('[data-span-start]')).filter(
      (el) => !el.closest('.tab-pane--hidden'),
    );
    const spans: SourceSpan[] = elements.map((el) => ({
      start: Number(el.dataset.spanStart),
      end: Number(el.dataset.spanEnd),
    }));
    const index = pickInnermostSpanIndex(spans, caretOffset);
    target = index >= 0 ? elements[index]! : null;
  }
  container.querySelectorAll(`.${CARET_CLASS}`).forEach((el) => {
    if (el !== target) el.classList.remove(CARET_CLASS);
  });
  if (target && !target.classList.contains(CARET_CLASS)) target.classList.add(CARET_CLASS);
  return target;
}

/**
 * エディタのカーソル位置に対応する要素を、右側の表示の中で枠で囲む（右をクリックすると左の SQL を強調表示する連動の逆向き）。
 *
 * 対応付けは sourceSelectableProps が付ける data-span-start / data-span-end を DOM から読む。
 * 表示側のコンポーネントは多く、カーソル位置を props で配って回ると変更が広がるため、DOM で探す。
 * 印のクラスは React の className の更新で消えるので、App の描画のたびに付け直すほか、
 * JOIN 図のノードのように子のコンポーネントだけが描き直したときも MutationObserver で付け直す
 */
export function useCaretSourceLink(
  containerRef: RefObject<HTMLElement | null>,
  caretOffset: number | null,
): void {
  const lastScrolledOffset = useRef<number | null>(null);
  const caretRef = useRef(caretOffset);
  caretRef.current = caretOffset;

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const target = applyCaretClass(container, caretOffset);
    if (caretOffset === null) {
      lastScrolledOffset.current = null;
      return;
    }
    // スクロールはカーソルが動いたときだけ。描画のたびに動かすと、右側を読んでいる最中にスクロール位置が勝手に変わる。
    // JOIN 図の中は React Flow が位置を管理しているので、scrollIntoView で動かさない
    if (target && lastScrolledOffset.current !== caretOffset && !target.closest('.react-flow')) {
      target.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
    }
    lastScrolledOffset.current = caretOffset;
  });

  // 監視する要素は、モードの切り替えで出力のパネルが作り直されると変わる。描画のたびに確かめて付け替える
  const observed = useRef<{ element: HTMLElement; observer: MutationObserver } | null>(null);
  useEffect(() => {
    const container = containerRef.current;
    if (observed.current?.element === container) return;
    observed.current?.observer.disconnect();
    observed.current = null;
    if (!container || typeof MutationObserver === 'undefined') return;
    const observer = new MutationObserver(() => applyCaretClass(container, caretRef.current));
    observer.observe(container, { subtree: true, childList: true, attributes: true, attributeFilter: ['class'] });
    observed.current = { element: container, observer };
  });
  useEffect(
    () => () => {
      observed.current?.observer.disconnect();
      observed.current = null;
    },
    [],
  );
}
