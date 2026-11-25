// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import App from './App';
import { STORAGE_KEY } from './lib/app-persistence';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** 入力から解析までの待ち時間（App の setTimeout）より長く進める */
const AFTER_DEBOUNCE_MS = 1000;

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.useFakeTimers();
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

function storeSql(sql: string, resolveAliases = false) {
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ sql, resolveAliases }));
}

function renderAndSettle() {
  act(() => root.render(<App />));
  act(() => {
    vi.advanceTimersByTime(AFTER_DEBOUNCE_MS);
  });
}

/** 共有リンクのフラグメント（圧縮なしの形式）を作る */
function shareFragment(payload: unknown): string {
  const body = btoa(JSON.stringify(payload)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return `#q=r${body}`;
}

/** 共有リンクの展開（Promise）を進める */
async function flushPromises() {
  for (let i = 0; i < 5; i++) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

/** React の onChange が拾えるよう、textarea の値をネイティブの setter で入れて input を発火する */
function typeInto(textarea: HTMLTextAreaElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
  setter.call(textarea, value);
  textarea.dispatchEvent(new Event('input', { bubbles: true }));
}

describe('App — 初期表示', () => {
  it('未入力のまま時間が経っても、解析エラーではなくサンプル読み込みの案内を出す', () => {
    renderAndSettle();

    expect(host.querySelector('.welcome-state')).not.toBeNull();
    expect(host.querySelector('.error-state')).toBeNull();
  });
});

describe('App — 入力の保存', () => {
  it('復元した SQL は最初の描画から解析結果を出し、解析前の案内を一瞬も出さない', () => {
    storeSql('SELECT u.id FROM users u');
    act(() => root.render(<App />));
    expect(host.querySelector('.welcome-state')).toBeNull();
    expect(host.querySelector('.tab-bar')).not.toBeNull();
  });

  it('前回保存した SQL を復元して解析する', () => {
    storeSql('SELECT u.id FROM users u');
    renderAndSettle();

    expect(host.querySelector('textarea')?.value).toBe('SELECT u.id FROM users u');
    expect(host.querySelector('.tab-bar')).not.toBeNull();
  });

  it('入力した SQL と表示の設定を保存する', () => {
    renderAndSettle();
    act(() => typeInto(host.querySelector('textarea')!, 'SELECT 1 FROM dual'));
    act(() => {
      vi.advanceTimersByTime(AFTER_DEBOUNCE_MS);
    });
    const checkbox = host.querySelector<HTMLInputElement>('.tab-bar-options input')!;
    act(() => checkbox.click());
    act(() => {
      vi.advanceTimersByTime(AFTER_DEBOUNCE_MS);
    });

    const saved = JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? '{}');
    expect(saved).toEqual({ sql: 'SELECT 1 FROM dual', resolveAliases: true });
  });
});

describe('App — 構文エラーの位置', () => {
  it('エラーの行番号を赤くし、該当箇所へ移動するボタンを出す', () => {
    storeSql('SELECT a\nFROM t\nWHERE = 1');
    renderAndSettle();

    expect(host.querySelector('.parse-error')?.textContent).toContain('3 行');
    expect(host.querySelector('.sql-line--error')?.getAttribute('data-line')).toBe('3');
    expect(host.querySelector('.sql-hl--error')).not.toBeNull();
    expect(host.querySelector('.parse-error-jump')).not.toBeNull();
  });

  it('エディタの下には要約だけを出し、期待していた字句の一覧は右側の詳細に分ける', () => {
    renderAndSettle();
    act(() => typeInto(host.querySelector('textarea')!, 'SELECT a,, b FROM t'));
    act(() => {
      vi.advanceTimersByTime(AFTER_DEBOUNCE_MS);
    });
    const alert = host.querySelector('.parse-error-text')!.textContent!;
    expect(alert).toContain('1 行 10 列の「,」で構文を解釈できません');
    expect(alert).not.toContain('Expected');
    expect(host.querySelector('.error-state .error-message')!.textContent).not.toContain('Expected');
    expect(host.querySelector('.error-state details.error-detail code')!.textContent).toContain('Expected');
  });
});

describe('App — エディタのカーソル位置と右側の表示の連動', () => {
  it('カーソルのある語に対応する要素に印を付ける', () => {
    const sql = 'SELECT u.id FROM users u WHERE u.active = 1';
    storeSql(sql);
    renderAndSettle();

    const textarea = host.querySelector('textarea')!;
    const offset = sql.indexOf('u.active') + 2;
    act(() => {
      textarea.focus();
      textarea.setSelectionRange(offset, offset);
      textarea.dispatchEvent(new Event('select', { bubbles: true }));
      textarea.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, key: 'ArrowRight' }));
    });

    const marked = host.querySelector<HTMLElement>('.source-selectable--caret');
    expect(marked).not.toBeNull();
    const start = Number(marked!.dataset.spanStart);
    const end = Number(marked!.dataset.spanEnd);
    expect(start).toBeLessThanOrEqual(offset);
    expect(end).toBeGreaterThanOrEqual(offset);
  });
});

describe('App — 共有リンク', () => {
  afterEach(() => {
    window.history.replaceState(null, '', window.location.pathname);
  });

  it('共有リンクの SQL を表示するが、編集するまでは保存していた自分の SQL を上書きしない', async () => {
    storeSql('SELECT mine FROM t');
    window.location.hash = shareFragment({ sql: 'SELECT shared FROM t' });

    act(() => root.render(<App />));
    await flushPromises();
    act(() => {
      vi.advanceTimersByTime(AFTER_DEBOUNCE_MS);
    });

    const textarea = host.querySelector('textarea')!;
    expect(textarea.value).toBe('SELECT shared FROM t');
    expect(JSON.parse(window.localStorage.getItem(STORAGE_KEY)!).sql).toBe('SELECT mine FROM t');

    act(() => typeInto(textarea, 'SELECT shared, edited FROM t'));
    act(() => {
      vi.advanceTimersByTime(AFTER_DEBOUNCE_MS);
    });
    expect(JSON.parse(window.localStorage.getItem(STORAGE_KEY)!).sql).toBe('SELECT shared, edited FROM t');
  });

  it('共有リンクを開いたあと、表示の設定だけを変えても保存する', async () => {
    storeSql('SELECT mine FROM t');
    window.location.hash = shareFragment({ sql: 'SELECT u.id FROM users u' });
    act(() => root.render(<App />));
    await flushPromises();
    act(() => {
      vi.advanceTimersByTime(AFTER_DEBOUNCE_MS);
    });

    act(() => host.querySelector<HTMLInputElement>('.tab-bar-options input')!.click());
    act(() => {
      vi.advanceTimersByTime(AFTER_DEBOUNCE_MS);
    });
    expect(JSON.parse(window.localStorage.getItem(STORAGE_KEY)!)).toEqual({
      sql: 'SELECT u.id FROM users u',
      resolveAliases: true,
    });
  });

  it('中身の欠けた共有リンクを開いたら、読み込めなかったことを表示し、保存していた SQL はそのまま', async () => {
    storeSql('SELECT mine FROM t');
    window.location.hash = '#q=r!!!';
    act(() => root.render(<App />));
    await flushPromises();

    expect(host.querySelector('.app-share-status')?.textContent).toContain('読み込めませんでした');
    expect(host.querySelector('textarea')!.value).toBe('SELECT mine FROM t');
  });

  it('共有リンクではないフラグメント（#foo）では何も表示しない', async () => {
    window.location.hash = '#foo';
    act(() => root.render(<App />));
    await flushPromises();
    expect(host.querySelector('.app-share-status')).toBeNull();
  });

  it('# 以降だけが変わったとき（hashchange）も共有リンクの SQL を読み込み、直前の編集は保存しておく', async () => {
    storeSql('SELECT mine FROM t');
    renderAndSettle();
    const textarea = host.querySelector('textarea')!;
    // 保存の待ち時間（300ms）が過ぎる前にリンクを開く
    act(() => typeInto(textarea, 'SELECT mine, edited FROM t'));

    window.location.hash = shareFragment({ sql: 'SELECT shared FROM t' });
    window.dispatchEvent(new HashChangeEvent('hashchange'));
    await flushPromises();
    act(() => {
      vi.advanceTimersByTime(AFTER_DEBOUNCE_MS);
    });

    expect(host.querySelector('textarea')!.value).toBe('SELECT shared FROM t');
    expect(JSON.parse(window.localStorage.getItem(STORAGE_KEY)!).sql).toBe('SELECT mine, edited FROM t');
  });
});

describe('App — タブのキーボード操作と選択の状態', () => {
  function key(target: Element, name: string) {
    act(() => {
      target.dispatchEvent(new KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true }));
    });
  }

  it('解析結果のタブは選んでいるタブを aria-selected で示し、← → Home End で移る', () => {
    storeSql('SELECT u.id FROM users u');
    renderAndSettle();
    const selected = () => host.querySelector('.tab-list [role="tab"][aria-selected="true"]')?.textContent;
    const tabs = () => [...host.querySelectorAll<HTMLButtonElement>('.tab-list [role="tab"]')];
    expect(selected()).toBe('SQL構造');
    expect(tabs().map((t) => t.tabIndex)).toEqual([0, -1, -1]);

    key(tabs()[0]!, 'ArrowRight');
    expect(selected()).toBe('作用説明');
    expect(document.activeElement).toBe(tabs()[1]);
    key(tabs()[1]!, 'End');
    expect(selected()).toBe('JOIN 図');
    key(tabs()[2]!, 'ArrowRight');
    expect(selected()).toBe('SQL構造');
    key(tabs()[0]!, 'ArrowLeft');
    expect(selected()).toBe('JOIN 図');
    key(tabs()[2]!, 'Home');
    expect(selected()).toBe('SQL構造');

    const panel = host.querySelector('[role="tabpanel"].tab-content')!;
    expect(document.getElementById(panel.getAttribute('aria-labelledby')!)?.textContent).toBe('SQL構造');
  });
});

describe('App — サンプルの読み込みと元に戻す', () => {
  function clickSample(label: string) {
    const editor = host.querySelector('.sql-editor')!;
    const button = [...editor.querySelectorAll<HTMLButtonElement>('.sample-load-btn')].find(
      (b) => b.textContent?.trim() === label,
    )!;
    act(() => {
      button.focus();
      button.click();
    });
  }

  function undoButton() {
    return [...host.querySelectorAll<HTMLButtonElement>('.sql-editor-notice button')].find(
      (b) => b.textContent === '元に戻す',
    );
  }

  it('入力していた SQL をサンプルで置き換えたら、「元に戻す」で前の SQL に戻せる', () => {
    renderAndSettle();
    const textarea = host.querySelector('textarea')!;
    act(() => typeInto(textarea, 'SELECT mine FROM t'));
    clickSample('UPDATE');
    expect(textarea.value).toMatch(/^UPDATE/);
    // happy-dom には execCommand が無く、値を直接差し替える。この場合は Ctrl+Z では戻せないので案内しない
    expect(host.querySelector('.sql-editor-notice')!.textContent).not.toContain('Ctrl+Z');

    act(() => undoButton()!.click());
    expect(textarea.value).toBe('SELECT mine FROM t');
    expect(undoButton()).toBeUndefined();
    act(() => {
      vi.advanceTimersByTime(AFTER_DEBOUNCE_MS);
    });
    expect(JSON.parse(window.localStorage.getItem(STORAGE_KEY)!).sql).toBe('SELECT mine FROM t');
  });

  it('空の入力にサンプルを入れたときは「元に戻す」を出さない', () => {
    renderAndSettle();
    clickSample('CONNECT BY');
    expect(host.querySelector('textarea')!.value).toMatch(/^SELECT/);
    expect(undoButton()).toBeUndefined();
  });

  it('置き換えたあとに編集したら「元に戻す」を消す（編集した内容を戻さないため）', () => {
    renderAndSettle();
    const textarea = host.querySelector('textarea')!;
    act(() => typeInto(textarea, 'SELECT mine FROM t'));
    clickSample('(+) 結合');
    expect(undoButton()).toBeDefined();
    act(() => typeInto(textarea, `${textarea.value}\nFETCH FIRST 1 ROWS ONLY`));
    expect(undoButton()).toBeUndefined();
  });
});

describe('App — エディタのキー操作', () => {
  function renderWithSql(sql: string) {
    storeSql(sql);
    renderAndSettle();
    return host.querySelector('textarea')!;
  }

  it('日本語の変換中の Tab では字下げしない', () => {
    const textarea = renderWithSql('SELECT a FROM t');
    act(() => {
      textarea.focus();
      textarea.setSelectionRange(6, 6);
      textarea.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true, isComposing: true }),
      );
    });
    expect(textarea.value).toBe('SELECT a FROM t');
  });

  it('変換中でない Tab ではカーソル位置に字下げを入れる', () => {
    const textarea = renderWithSql('SELECT a FROM t');
    act(() => {
      textarea.focus();
      textarea.setSelectionRange(6, 6);
      textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }));
    });
    expect(textarea.value).toBe('SELECT   a FROM t');
  });

  it('Esc のあとの Shift+Tab は、Shift の押下で印が消えず、字下げを戻さない（前の項目へ移る）', () => {
    const textarea = renderWithSql('  SELECT a FROM t');
    const send = (init: KeyboardEventInit) =>
      textarea.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init }));
    let tabPrevented = true;
    act(() => {
      textarea.focus();
      textarea.setSelectionRange(4, 4);
      send({ key: 'Escape' });
      send({ key: 'Shift', shiftKey: true });
      tabPrevented = !send({ key: 'Tab', shiftKey: true });
    });
    expect(textarea.value).toBe('  SELECT a FROM t');
    expect(tabPrevented).toBe(false);
  });

  it('Esc のあとでもフォーカスが一度外れたら、次の Tab は字下げする', () => {
    const textarea = renderWithSql('SELECT a FROM t');
    act(() => {
      textarea.focus();
      textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      textarea.blur();
      textarea.focus();
      textarea.setSelectionRange(6, 6);
      textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }));
    });
    expect(textarea.value).toBe('SELECT   a FROM t');
  });

  it('サンプルの読み込みなど入力以外で SQL を差し替えたら、カーソル連動の枠を外す', () => {
    const sql = 'SELECT u.id FROM users u WHERE u.active = 1';
    const textarea = renderWithSql(sql);
    act(() => {
      textarea.focus();
      textarea.setSelectionRange(sql.indexOf('u.active') + 2, sql.indexOf('u.active') + 2);
      textarea.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, key: 'ArrowRight' }));
    });
    expect(host.querySelector('.source-selectable--caret')).not.toBeNull();

    const sampleButton = host.querySelector<HTMLButtonElement>('.sql-editor .sample-load-btn')!;
    act(() => {
      sampleButton.focus();
      sampleButton.click();
    });
    act(() => {
      vi.advanceTimersByTime(AFTER_DEBOUNCE_MS);
    });
    expect(host.querySelector('.source-selectable--caret')).toBeNull();
  });

  it('説明の参照先（aria-describedby）は、エラーの有無にかかわらず実在する要素を指す', () => {
    const ok = renderWithSql('SELECT a FROM t');
    expect(document.getElementById(ok.getAttribute('aria-describedby')!)).not.toBeNull();
  });

  it('エラーの表示中は、説明の参照先がエラーの表示を指す', () => {
    const bad = renderWithSql('SELECT a,\nFROM t');
    const target = document.getElementById(bad.getAttribute('aria-describedby')!);
    expect(target?.classList.contains('parse-error')).toBe(true);
  });
});
