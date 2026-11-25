// @vitest-environment happy-dom
/**
 * SQL の入力中（解析結果が変わらないあいだ）は、右側の解析結果を描き直さないことを、部品が描かれた回数で確かめる。
 * 大きな SQL では右側の DOM が 20 万要素を超え、1 文字ごとに描き直すと入力が 2 秒ほど止まる。
 * 部品を差し替えるため、ほかの App のテストとは別のファイルにしている
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import App from './App';

const renders = vi.hoisted(() => ({ count: 0 }));

vi.mock('./components/QueryEffectPanel', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./components/QueryEffectPanel')>();
  return {
    ...actual,
    QueryEffectBanner: (props: Parameters<typeof actual.QueryEffectBanner>[0]) => {
      renders.count += 1;
      return actual.QueryEffectBanner(props);
    },
  };
});

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** 入力から解析までの待ち時間（App の setTimeout）より長く進める */
const AFTER_DEBOUNCE_MS = 1000;

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.useFakeTimers();
  renders.count = 0;
  window.localStorage.clear();
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.useRealTimers();
});

function typeInto(textarea: HTMLTextAreaElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
  setter.call(textarea, value);
  textarea.dispatchEvent(new Event('input', { bubbles: true }));
}

describe('App — 入力中は右側の解析結果を描き直さない', () => {
  it('解析が終わるまでの入力では描き直さず、解析し直したら描き直す', () => {
    act(() => root.render(<App />));
    const textarea = host.querySelector('textarea')!;
    act(() => typeInto(textarea, 'SELECT u.id FROM users u'));
    act(() => {
      vi.advanceTimersByTime(AFTER_DEBOUNCE_MS);
    });
    expect(host.querySelector('.tab-bar')).not.toBeNull();
    const afterParse = renders.count;
    expect(afterParse).toBeGreaterThan(0);

    // 解析の待ち時間より短い間隔で打ち続ける
    for (const sql of ['SELECT u.id FROM users u ', 'SELECT u.id FROM users u W', 'SELECT u.id FROM users u WH']) {
      act(() => typeInto(textarea, sql));
      act(() => {
        vi.advanceTimersByTime(100);
      });
    }
    expect(renders.count).toBe(afterParse);

    act(() => typeInto(textarea, 'SELECT u.name FROM users u'));
    act(() => {
      vi.advanceTimersByTime(AFTER_DEBOUNCE_MS);
    });
    expect(renders.count).toBeGreaterThan(afterParse);
  });
});
