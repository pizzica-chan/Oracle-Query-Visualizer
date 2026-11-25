/**
 * 画面のための処理（行ごとのハイライト、構文エラーの位置、別名のツールチップ、カーソル連動の範囲）を、
 * 全テストが共有する SQL ケース集（fixtures/sql-cases.ts）の全件に流して確かめる。
 * 手書きの少数の例だけで確かめると、複雑な SQL・作りの悪い SQL で崩れるのを見落とす
 * （式の表示の欠落をまとめて直した a5041df で、共有のケース集に流す形にしたのと同じ考え方）
 */
import { describe, expect, it } from 'vitest';
import { aliasTooltipFor } from './effect-text-highlight';
import { SQL_TEST_CASES } from './fixtures/sql-cases';
import { NO_JOIN_CONDITION } from './join-condition';
import { buildJoinFlowLayout } from './join-flow-layout';
import { parseOracleQuery } from './parser';
import { buildQueryEffect } from './query-effect';
import { collectAllNestedQueries } from './query-utils';
import { highlightSqlToLineHtml } from './sql-highlight';
import type { ParsedQuery, SourceSpan } from './types';

function unescapeHtml(text: string): string {
  return text.replace(/&quot;/g, '"').replace(/&gt;/g, '>').replace(/&lt;/g, '<').replace(/&amp;/g, '&');
}

/** 行ごとの HTML から、タグを外して元の文字列に戻す */
function textOfLines(lines: string[]): string {
  return lines.map((line) => unescapeHtml(line.replace(/<[^>]+>/g, ''))).join('\n');
}

/** ParsedQuery の中の sourceSpan をすべて集める（カーソル連動はこの範囲で要素を探す） */
function collectSpans(value: unknown, out: SourceSpan[] = [], seen = new Set<unknown>()): SourceSpan[] {
  if (!value || typeof value !== 'object' || seen.has(value)) return out;
  seen.add(value);
  const record = value as Record<string, unknown>;
  const span = record.sourceSpan as SourceSpan | undefined;
  if (span && typeof span.start === 'number' && typeof span.end === 'number') out.push(span);
  for (const child of Object.values(record)) collectSpans(child, out, seen);
  return out;
}

describe('画面のための処理 — 共有の SQL ケース集の全件', () => {
  it.each(SQL_TEST_CASES)('$name — 行ごとのハイライトは元の SQL の文字をすべて残し、行数が一致する', ({ sql }) => {
    const lines = highlightSqlToLineHtml(sql);
    expect(lines).toHaveLength(sql.split('\n').length);
    expect(textOfLines(lines)).toBe(sql);
  });

  it.each(SQL_TEST_CASES)('$name — エラーの範囲を印にしても、文字は欠けない', ({ sql }) => {
    const result = parseOracleQuery(sql);
    if (result.success || !result.error.span) return;
    const { start, end } = result.error.span;
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    expect(end).toBeLessThanOrEqual(sql.length);
    expect(textOfLines(highlightSqlToLineHtml(sql, { error: result.error.span }))).toBe(sql);
  });

  const successCases = SQL_TEST_CASES.filter((c) => c.expectSuccess);

  it.each(successCases)('$name — カーソル連動に使う範囲は、すべて入力 SQL の中に収まる', ({ sql }) => {
    const result = parseOracleQuery(sql);
    if (!result.success) throw new Error(result.error.message);
    for (const span of collectSpans(result.query)) {
      expect(span.start).toBeGreaterThanOrEqual(0);
      expect(span.end).toBeGreaterThanOrEqual(span.start);
      expect(span.end).toBeLessThanOrEqual(sql.length);
    }
  });

  it.each(successCases)('$name — 作用説明・SQL構造・JOIN 図の線に、条件の無い結合を表す内部の印を出さない', ({ sql }) => {
    const result = parseOracleQuery(sql);
    if (!result.success) throw new Error(result.error.message);
    for (const scope of [result.query, ...collectAllNestedQueries(result.query)]) {
      for (const mode of ['sql', 'japanese'] as const) {
        expect(JSON.stringify(buildQueryEffect(scope, mode))).not.toContain(NO_JOIN_CONDITION);
      }
      const { edges } = buildJoinFlowLayout(scope.tables, scope.joins, false, scope);
      for (const edge of edges) expect(String(edge.data?.condition ?? '')).not.toContain(NO_JOIN_CONDITION);
    }
  });

  it.each(successCases)('$name — 別名のツールチップは、どの階層でも同じテーブルを指す別名にだけ出る', ({ sql }) => {
    const result = parseOracleQuery(sql);
    if (!result.success) throw new Error(result.error.message);
    const scopes: ParsedQuery[] = [result.query, ...collectAllNestedQueries(result.query)];
    for (const table of scopes.flatMap((scope) => scope.tables)) {
      for (const name of [table.alias, table.table].filter((n): n is string => Boolean(n))) {
        const tooltip = aliasTooltipFor({ text: name, kind: 'table' }, result.query);
        if (tooltip === undefined) continue;
        expect(tooltip.startsWith(`${name} は`)).toBe(true);
        // ツールチップが出るなら、その名前を別名に持つテーブルは（大文字小文字を区別せずに）すべて同じものを指す
        const targets = new Set(
          scopes
            .flatMap((scope) => scope.tables)
            .filter((t) => t.alias?.toLowerCase() === name.toLowerCase())
            .map((t) => (t.isDerived ? `derived:${t.displayName}` : `${t.schema ?? ''}.${t.table}`)),
        );
        expect(targets.size, `${name}: ${[...targets].join(', ')}`).toBeLessThanOrEqual(1);
      }
    }
  });
});

describe('別名のツールチップ — 大文字小文字', () => {
  it('大文字小文字だけが違う別名が別のテーブルを指すときは出さない（Oracle は引用符なしの別名の大文字小文字を区別しない）', () => {
    const result = parseOracleQuery(
      'SELECT o.id FROM orders o WHERE EXISTS (SELECT 1 FROM order_items O WHERE O.qty > 0)',
    );
    if (!result.success) throw new Error(result.error.message);
    expect(aliasTooltipFor({ text: 'o.id', kind: 'column' }, result.query)).toBeUndefined();
    expect(aliasTooltipFor({ text: 'O.qty', kind: 'column' }, result.query)).toBeUndefined();
  });
});
