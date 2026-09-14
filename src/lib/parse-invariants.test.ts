import { describe, expect, it } from 'vitest';
import { parseOracleQuery } from './parser';
import { assertParseInvariants } from './fixtures/parse-invariants';
import { SQL_TEST_CASES } from './fixtures/sql-cases';

describe('parse invariants', () => {
  const successCases = SQL_TEST_CASES.filter((c) => c.expectSuccess);

  it.each(successCases)('$name — 構造的不変条件を満たす', (testCase) => {
    const result = parseOracleQuery(testCase.sql);
    expect(result.success).toBe(true);
    if (!result.success) return;
    testCase.assert?.(result.query);
    expect(() => assertParseInvariants(result.query, testCase.name)).not.toThrow();
  });
});

describe('parse invariants — 意図的な破損検出', () => {
  it('JOIN が存在するのに参照先が無ければ検出する', () => {
    expect(() =>
      assertParseInvariants({
        rawSql: '',
        statementType: 'SELECT',
        tables: [{ id: 'tbl-1', table: 'a', displayName: 'a' }],
        joins: [
          {
            id: 'join-1',
            type: 'INNER JOIN',
            sourceId: 'tbl-1',
            targetId: 'tbl-missing',
            condition: 'a.id = b.id',
          },
        ],
        columns: [{ expression: '*' }],
        groupBy: [],
        orderBy: [],
        distinct: false,
      }),
    ).toThrow(/unknown target/);
  });

  it('派生テーブルに derivedQuery が無ければ検出する', () => {
    expect(() =>
      assertParseInvariants({
        rawSql: '',
        statementType: 'SELECT',
        tables: [{ id: 'tbl-1', table: 't', displayName: 't (派生)', isDerived: true }],
        joins: [],
        columns: [{ expression: 'id' }],
        groupBy: [],
        orderBy: [],
        distinct: false,
      }),
    ).toThrow(/missing derivedQuery/);
  });
});
