// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';
import { JoinDiagram } from './JoinDiagram';
import { JOIN_MINIMAP_COMPACT_SIZE } from '../lib/join-flow-layout';
import { parseOracleQuery, SAMPLE_SQL } from '../lib/parser';

describe('JoinDiagram', () => {
  let container: HTMLDivElement;
  let root: Root;

  afterEach(() => {
    act(() => root?.unmount());
    container?.remove();
  });

  function mount(props: React.ComponentProps<typeof JoinDiagram>) {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => {
      root.render(<JoinDiagram {...props} />);
    });
  }

  it('SAMPLE_SQL の JOIN 図をクラッシュなく描画する', () => {
    const result = parseOracleQuery(SAMPLE_SQL);
    expect(result.success).toBe(true);
    if (!result.success) return;

    expect(() =>
      mount({
        tables: result.query.tables,
        joins: result.query.joins,
        resolveAliases: false,
      }),
    ).not.toThrow();

    expect(container.querySelector('.join-diagram')).toBeTruthy();
    expect(container.querySelector('.join-diagram--draggable')).toBeTruthy();
    expect(container.querySelector('.react-flow')).toBeTruthy();
    expect(container.querySelector('.react-flow__minimap')).toBeTruthy();
  });

  it('JOIN 条件欄は ON 条件の参照元テーブルを表示する', () => {
    const result = parseOracleQuery(SAMPLE_SQL);
    expect(result.success).toBe(true);
    if (!result.success) return;

    mount({
      tables: result.query.tables,
      joins: result.query.joins,
      resolveAliases: false,
      query: result.query,
    });

    expect(container.textContent).toContain('u, o, p → lm');
    expect(container.textContent).toContain('p → c');
    expect(container.textContent).toContain('u → hot');
    expect(container.textContent).not.toContain('lm → c');
    expect(container.textContent).not.toContain('c → hot');
  });

  it('グラフ上の ON 条件表示を切り替えられる', () => {
    const result = parseOracleQuery(SAMPLE_SQL);
    expect(result.success).toBe(true);
    if (!result.success) return;

    mount({
      tables: result.query.tables,
      joins: result.query.joins,
      resolveAliases: false,
      query: result.query,
    });

    expect(container.querySelector('.join-diagram-toolbar')).toBeTruthy();
    expect(container.querySelector('.join-diagram-toolbar-btn')?.textContent).toContain('配置をリセット');
    const toggle = container.querySelector(
      '.join-diagram-toolbar-toggle input',
    ) as HTMLInputElement | null;
    expect(toggle?.checked).toBe(true);

    act(() => {
      toggle!.click();
    });
    expect(toggle?.checked).toBe(false);

    act(() => {
      toggle!.click();
    });
    expect(toggle?.checked).toBe(true);
  });

  it('SAMPLE_SQL で実質 INNER JOIN の凡例と JOIN 条件バッジを表示する', () => {
    const result = parseOracleQuery(SAMPLE_SQL);
    expect(result.success).toBe(true);
    if (!result.success) return;

    mount({
      tables: result.query.tables,
      joins: result.query.joins,
      resolveAliases: false,
      query: result.query,
    });

    expect(container.querySelector('.join-diagram-legend')).toBeTruthy();
    expect(container.textContent).toContain('≈INNER');
    expect(container.textContent).toContain('実質 INNER');
  });

  it('同一 props の再描画で無限ループしない', () => {
    const result = parseOracleQuery(SAMPLE_SQL);
    expect(result.success).toBe(true);
    if (!result.success) return;

    const props = {
      tables: result.query.tables,
      joins: result.query.joins,
      resolveAliases: false,
    };

    mount(props);

    expect(() => {
      for (let i = 0; i < 20; i++) {
        act(() => {
          root.render(<JoinDiagram {...props} />);
        });
      }
    }).not.toThrow();
  });

  it('compact モードではミニマップが小さく表示される', () => {
    const result = parseOracleQuery(SAMPLE_SQL);
    expect(result.success).toBe(true);
    if (!result.success) return;

    mount({
      tables: result.query.tables.slice(0, 2),
      joins: result.query.joins.slice(0, 1),
      resolveAliases: false,
      compact: true,
    });

    const minimap = container.querySelector('.join-minimap--compact') as HTMLElement | null;
    expect(minimap).toBeTruthy();
    expect(container.querySelector('.join-diagram--draggable')).toBeFalsy();
    expect(minimap?.style.width).toBe(`${JOIN_MINIMAP_COMPACT_SIZE.width}px`);
    expect(minimap?.style.height).toBe(`${JOIN_MINIMAP_COMPACT_SIZE.height}px`);
  });

  it('テーブル 0 件では empty-state を表示し React Flow をマウントしない', () => {
    mount({ tables: [], joins: [], resolveAliases: false });
    expect(container.querySelector('.empty-state')).toBeTruthy();
    expect(container.querySelector('.react-flow')).toBeFalsy();
  });
});
