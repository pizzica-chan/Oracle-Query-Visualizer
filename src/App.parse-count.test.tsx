// @vitest-environment happy-dom
/**
 * 同じ SQL を解析し直さないことを、解析の関数を呼んだ回数で確かめる。
 * 解析の関数を差し替えるため、ほかの App のテストとは別のファイルにしている
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import App from './App';
import { STORAGE_KEY } from './lib/app-persistence';
import { parseOracleQuery } from './lib/parser';

vi.mock('./lib/parser', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./lib/parser')>();
  return { ...actual, parseOracleQuery: vi.fn(actual.parseOracleQuery) };
});

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** 入力から解析までの待ち時間（App の setTimeout）より長く進める */
const AFTER_DEBOUNCE_MS = 1000;

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.useFakeTimers();
  vi.mocked(parseOracleQuery).mockClear();
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

describe('App — 同じ SQL を解析し直さない', () => {
  it('起動時に復元した SQL は 1 回だけ解析する', () => {
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ sql: 'SELECT u.id FROM users u', resolveAliases: false }),
    );
    act(() => root.render(<App />));
    act(() => {
      vi.advanceTimersByTime(AFTER_DEBOUNCE_MS);
    });
    expect(parseOracleQuery).toHaveBeenCalledTimes(1);
  });

  it('Ctrl+Enter で解析したあと、入力の待ち時間が過ぎても解析し直さない', () => {
    act(() => root.render(<App />));
    const textarea = host.querySelector('textarea')!;
    act(() => typeInto(textarea, 'SELECT u.id FROM users u'));
    act(() => {
      textarea.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true, cancelable: true }),
      );
    });
    expect(parseOracleQuery).toHaveBeenCalledTimes(1);
    act(() => {
      vi.advanceTimersByTime(AFTER_DEBOUNCE_MS);
    });
    expect(parseOracleQuery).toHaveBeenCalledTimes(1);
  });

  it('SQL を変えたら解析し直す', () => {
    act(() => root.render(<App />));
    const textarea = host.querySelector('textarea')!;
    act(() => typeInto(textarea, 'SELECT u.id FROM users u'));
    act(() => {
      vi.advanceTimersByTime(AFTER_DEBOUNCE_MS);
    });
    act(() => typeInto(textarea, 'SELECT u.name FROM users u'));
    act(() => {
      vi.advanceTimersByTime(AFTER_DEBOUNCE_MS);
    });
    expect(parseOracleQuery).toHaveBeenCalledTimes(2);
    expect(host.querySelector('.tab-bar')).not.toBeNull();
  });
});
