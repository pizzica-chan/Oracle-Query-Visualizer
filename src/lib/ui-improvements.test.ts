import { describe, expect, it } from 'vitest';
import type { Edge } from '@xyflow/react';
import { aliasTooltipFor } from './effect-text-highlight';
import { JOIN_EDGE_COLORS, themedJoinColor, themedJoinEdge } from './join-flow-layout';
import { parseOracleQuery } from './parser';
import { pickInnermostSpanIndex } from './source-link';
import { highlightSqlToHtml, highlightSqlToLineHtml } from './sql-highlight';
import { resolveColorScheme } from './theme';

function mustParse(sql: string) {
  const result = parseOracleQuery(sql);
  if (!result.success) throw new Error(result.error.message);
  return result.query;
}

describe('エディタのハイライト（エラーの印と行ごとの出力）', () => {
  it('エラーの範囲に error クラスを付ける', () => {
    const sql = 'SELECT a FROM t';
    const html = highlightSqlToHtml(sql, undefined, { start: 7, end: 8 });
    expect(html).toContain('sql-hl--error">a</span>');
  });

  it('focus と error が重なる部分には両方のクラスを付ける', () => {
    const html = highlightSqlToHtml('SELECT abc', { start: 7, end: 10 }, { start: 8, end: 9 });
    expect(html).toContain('class="sql-hl--focus">a</span>');
    expect(html).toContain('class="sql-hl--focus sql-hl--error">b</span>');
  });

  it('行ごとの出力は行数と一致し、複数行のコメントは行の境目で span を閉じて開き直す', () => {
    const sql = 'SELECT /* a\nb */ 1\n';
    const lines = highlightSqlToLineHtml(sql);
    expect(lines).toHaveLength(3);
    expect(lines[0]).toContain('<span class="sql-hl--comment">/* a</span>');
    expect(lines[1]).toContain('<span class="sql-hl--comment">b */</span>');
    expect(lines[2]).toBe('');
  });

  it('行ごとの出力をつなぐと、元の SQL の文字がすべて残る', () => {
    const sql = "SELECT\n  u.id, 'x\ny'\nFROM users u -- c";
    const text = highlightSqlToLineHtml(sql)
      .map((line) => line.replace(/<[^>]+>/g, ''))
      .join('\n');
    expect(text).toBe(sql);
  });
});

describe('pickInnermostSpanIndex', () => {
  const spans = [
    { start: 0, end: 30 },
    { start: 5, end: 12 },
    { start: 7, end: 9 },
    { start: 20, end: 25 },
  ];

  it('カーソルを含むうち、いちばん短い範囲を選ぶ', () => {
    expect(pickInnermostSpanIndex(spans, 8)).toBe(2);
    expect(pickInnermostSpanIndex(spans, 6)).toBe(1);
    expect(pickInnermostSpanIndex(spans, 15)).toBe(0);
  });

  it('範囲の終端ちょうど（語の直後のカーソル）も含める', () => {
    expect(pickInnermostSpanIndex(spans, 25)).toBe(3);
  });

  it('どれにも含まれなければ -1', () => {
    expect(pickInnermostSpanIndex(spans, 31)).toBe(-1);
    expect(pickInnermostSpanIndex([], 0)).toBe(-1);
  });
});

describe('aliasTooltipFor', () => {
  const query = mustParse('SELECT u.id FROM hr.users u JOIN orders ON orders.user_id = u.id');

  it('別名のテーブルと、別名で修飾した列に実テーブル名を返す', () => {
    expect(aliasTooltipFor({ text: 'u', kind: 'table' }, query)).toBe('u は hr.users の別名');
    expect(aliasTooltipFor({ text: 'u.id', kind: 'column' }, query)).toBe('u は hr.users の別名');
  });

  it('外側とサブクエリで同じ別名が別のテーブルを指すときは返さない', () => {
    const nested = mustParse(
      'SELECT o.id FROM orders o WHERE EXISTS (SELECT 1 FROM order_items o WHERE o.qty > 0)',
    );
    expect(aliasTooltipFor({ text: 'o.qty', kind: 'column' }, nested)).toBeUndefined();
    expect(aliasTooltipFor({ text: 'o', kind: 'table' }, nested)).toBeUndefined();
  });

  it('サブクエリの中だけにある別名も、指す先が 1 つなら返す', () => {
    const nested = mustParse(
      'SELECT u.id FROM users u WHERE EXISTS (SELECT 1 FROM orders o WHERE o.user_id = u.id)',
    );
    expect(aliasTooltipFor({ text: 'o.user_id', kind: 'column' }, nested)).toBe('o は orders の別名');
  });

  it('スカラーサブクエリの中で同じ別名が別のテーブルを指すときは返さない', () => {
    const scalar = mustParse('SELECT o.id, (SELECT COUNT(*) FROM order_items o WHERE o.x = 1) AS n FROM orders o');
    expect(aliasTooltipFor({ text: 'o.x', kind: 'column' }, scalar)).toBeUndefined();
  });

  it('CTE の定義の中で同じ別名が別のテーブルを指すときは返さない', () => {
    const cte = mustParse(
      'WITH recent AS (SELECT o.id FROM order_items o) SELECT o.id FROM orders o JOIN recent r ON r.id = o.id',
    );
    expect(aliasTooltipFor({ text: 'o.id', kind: 'column' }, cte)).toBeUndefined();
  });

  it('CTE の参照の別名には WITH 句の名前を返す', () => {
    const cte = mustParse('WITH recent AS (SELECT id FROM orders) SELECT r.id FROM recent r');
    expect(aliasTooltipFor({ text: 'r.id', kind: 'column' }, cte)).toBe('r は WITH 句の recent の別名');
  });

  it('派生テーブル（FROM 句のサブクエリ）の別名にはその旨を返す', () => {
    const derived = mustParse('SELECT d.total FROM (SELECT SUM(x) AS total FROM t) d');
    expect(aliasTooltipFor({ text: 'd.total', kind: 'column' }, derived)).toBe(
      'd は派生テーブル（FROM 句のサブクエリ）の別名',
    );
  });

  it('別名の無いテーブル、知らない別名、テーブル以外の字句には返さない', () => {
    expect(aliasTooltipFor({ text: 'orders', kind: 'table' }, query)).toBeUndefined();
    expect(aliasTooltipFor({ text: 'x.id', kind: 'column' }, query)).toBeUndefined();
    expect(aliasTooltipFor({ text: 'u', kind: 'keyword' }, query)).toBeUndefined();
    expect(aliasTooltipFor({ text: 'u' }, query)).toBeUndefined();
  });
});

describe('配色', () => {
  it('自動はシステムの設定に従い、明示した設定はそのまま', () => {
    expect(resolveColorScheme('system', true)).toBe('dark');
    expect(resolveColorScheme('system', false)).toBe('light');
    expect(resolveColorScheme('light', true)).toBe('light');
    expect(resolveColorScheme('dark', false)).toBe('dark');
  });

  it('ライトテーマでは JOIN の線の色をすべて別の色に差し替え、ダークでは変えない', () => {
    for (const color of Object.values(JOIN_EDGE_COLORS)) {
      expect(themedJoinColor(color, 'dark')).toBe(color);
      expect(themedJoinColor(color, 'light')).not.toBe(color);
    }
  });

  it('辺の線と矢印の色を一緒に差し替える', () => {
    const inner = JOIN_EDGE_COLORS['INNER JOIN'];
    const edge = {
      id: 'e1',
      source: 'a',
      target: 'b',
      style: { stroke: inner, strokeWidth: 2 },
      markerEnd: { type: 'arrowclosed', color: inner },
    } as Edge;
    const themed = themedJoinEdge(edge, 'light');
    const lightInner = themedJoinColor(inner, 'light');
    expect(themed.style?.stroke).toBe(lightInner);
    expect(themed.style?.strokeWidth).toBe(2);
    expect((themed.markerEnd as { color: string }).color).toBe(lightInner);
    expect(themedJoinEdge(edge, 'dark')).toBe(edge);
  });
});
