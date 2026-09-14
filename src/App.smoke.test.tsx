// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';
import App from './App';
import {
  DELETE_SAMPLE_SQL,
  HIERARCHICAL_SAMPLE_SQL,
  LEGACY_JOIN_SAMPLE_SQL,
  SAMPLE_SQL,
  UNION_SAMPLE_SQL,
  UPDATE_SAMPLE_SQL,
} from './lib/parser';

const containers: HTMLElement[] = [];

async function renderApp(): Promise<HTMLElement> {
  const container = document.createElement('div');
  document.body.appendChild(container);
  containers.push(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(<App />);
  });
  return container;
}

/** サンプル読込ボタンを押して解析完了まで待つ（入力デバウンスは 400ms） */
async function loadSample(container: HTMLElement, label: string): Promise<void> {
  const button = [...container.querySelectorAll('button')].find((b) => b.textContent === label);
  if (!button) throw new Error(`sample button not found: ${label}`);
  await act(async () => {
    button.click();
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 500));
  });
}

function clickTab(container: HTMLElement, label: string): void {
  const tab = [...container.querySelectorAll('.tab')].find((t) => t.textContent === label);
  if (!tab) throw new Error(`tab not found: ${label}`);
  act(() => {
    (tab as HTMLButtonElement).click();
  });
}

describe('App スモーク', () => {
  afterEach(() => {
    for (const container of containers.splice(0)) container.remove();
  });

  it('初期表示でサンプル読込ボタンを出す', async () => {
    const container = await renderApp();
    // エディタのツールバーと welcome 画面の両方に同じ一覧が出る
    const labels = new Set(
      [...container.querySelectorAll('.sample-load-btn')].map((b) => b.textContent),
    );
    expect([...labels]).toEqual(['SELECT', 'UNION', 'UPDATE', 'DELETE', '(+) 結合', 'CONNECT BY']);
  });

  it.each([
    ['SELECT', SAMPLE_SQL],
    ['UNION', UNION_SAMPLE_SQL],
    ['UPDATE', UPDATE_SAMPLE_SQL],
    ['DELETE', DELETE_SAMPLE_SQL],
    ['(+) 結合', LEGACY_JOIN_SAMPLE_SQL],
    ['CONNECT BY', HIERARCHICAL_SAMPLE_SQL],
  ])('%s サンプルを解析エラーなく表示する', async (label, sql) => {
    const container = await renderApp();
    await loadSample(container, label);

    const textarea = container.querySelector('textarea') as HTMLTextAreaElement;
    expect(textarea.value).toBe(sql);
    expect(container.querySelector('.parse-error')).toBeNull();
    expect(container.querySelector('.error-state')).toBeNull();
    expect(container.querySelector('.tab-bar')).not.toBeNull();
  });

  it('(+) サンプルで LEFT JOIN として説明する', async () => {
    const container = await renderApp();
    await loadSample(container, '(+) 結合');
    clickTab(container, '作用説明');

    expect(container.textContent).toContain('LEFT JOIN');
    expect(container.textContent).toContain('employees');
  });

  it('CONNECT BY サンプルで階層問い合わせの説明を出す', async () => {
    const container = await renderApp();
    await loadSample(container, 'CONNECT BY');
    clickTab(container, '作用説明');

    expect(container.textContent).toContain('階層の起点');
    expect(container.textContent).toContain('階層の親子関係');
  });

  it('SELECT サンプルでヒントと行制限句を説明に出す', async () => {
    const container = await renderApp();
    await loadSample(container, 'SELECT');
    clickTab(container, '作用説明');

    expect(container.textContent).toContain('ヒント');
    expect(container.textContent).toContain('最大 100 行');
  });

  it('解析できない SQL はエラーを表示する', async () => {
    const container = await renderApp();
    const textarea = container.querySelector('textarea') as HTMLTextAreaElement;

    await act(async () => {
      textarea.value = 'これはSQLではない';
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 500));
    });

    expect(container.querySelector('.parse-error')).not.toBeNull();
  });
});
