import { describe, expect, it } from 'vitest';
import { parseOracleQuery } from './parser';
import { buildQueryEffect, buildUnionQueryEffect, type ConditionEffectNode, type QueryEffect } from './query-effect';
import { SQL_TEST_CASES } from './fixtures/sql-cases';
import { collectAllNestedQueries } from './query-utils';
import type { ParsedQuery } from './types';

/**
 * 解析の途中で使う仮の名前と値。画面に出すと、SQL に無い語に見える。
 * - `(no condition)`: 結合条件の無い JOIN の印（NO_JOIN_CONDITION）。画面では「すべての組み合わせ」などに置き換える
 * - `derived` / `derived_0`: 別名の無いサブクエリの仮の名前
 * - `table_1`: 名前を読めなかった表の仮の名前
 */
const INTERNAL_PLACEHOLDER = /\(no condition\)|\bderived(?:_\d+)?\b|\btable_\d+\b/;

function conditionTexts(node: ConditionEffectNode | undefined): string[] {
  if (!node) return [];
  return [node.text ?? '', node.label ?? '', ...(node.children ?? []).flatMap(conditionTexts)];
}

function effectTexts(effect: QueryEffect): string[] {
  return [
    effect.summary,
    ...effect.sections.flatMap((section) => [
      section.title ?? '',
      ...(section.lines ?? []).map((line) => line.text),
      ...conditionTexts(section.conditionRoot),
      ...(section.filterParts ?? []).flatMap((part) => [part.label, ...conditionTexts(part.root)]),
      ...(section.presenceGroups ?? []).flatMap((group) =>
        group.entries.flatMap((entry) => [entry.tableLabel, ...conditionTexts(entry.join?.condition)]),
      ),
    ]),
  ];
}

function displayedTexts(query: ParsedQuery): string[] {
  const texts: string[] = [];
  for (const q of [query, ...collectAllNestedQueries(query)]) {
    for (const mode of ['japanese', 'sql'] as const) {
      const union = buildUnionQueryEffect(q, mode);
      if (union) {
        texts.push(...union.unionNotes, ...(union.wholeResult?.lines ?? []).map((l) => l.text));
        for (const branch of union.branches) texts.push(...effectTexts(branch.effect));
      } else {
        texts.push(...effectTexts(buildQueryEffect(q, mode)));
      }
    }
  }
  return texts;
}

describe('画面に出す説明に、解析の途中で使う仮の名前を出さない', () => {
  const cases = SQL_TEST_CASES.filter((c) => c.expectSuccess);

  it.each(cases.map((c) => [c.name, c.sql] as const))('%s', (_name, sql) => {
    const result = parseOracleQuery(sql);
    if (!result.success) return;
    const leaked = displayedTexts(result.query).filter((text) => INTERNAL_PLACEHOLDER.test(text));
    expect(leaked).toEqual([]);
  });
});
