import { describe, expect, it } from 'vitest';
import { applyAliasResolution } from './alias-resolver';
import { collectTableIdsFromJoinCondition, formatJoinConditionLabel } from './join-condition';
import { parseOracleQuery } from './parser';

describe('join-condition', () => {
  describe('formatJoinConditionLabel', () => {
    it('相関 IN サブクエリの WHERE を表示に含める', () => {
      const result = parseOracleQuery(`
        SELECT u.id
        FROM users u
        JOIN orders o ON o.user_id IN (SELECT user_id FROM banned b WHERE b.ref_id = u.id)
      `);
      expect(result.success).toBe(true);
      if (!result.success) return;

      const root = result.query.joins[0]?.conditionRoot;
      expect(root).toBeDefined();
      expect(formatJoinConditionLabel(root!)).toContain('o.user_id IN (SELECT');
      expect(formatJoinConditionLabel(root!)).toContain('FROM b WHERE b.ref_id = u.id');
    });

    it('EXISTS / NOT EXISTS サブクエリの WHERE を表示に含める', () => {
      const exists = parseOracleQuery(`
        SELECT u.id FROM users u
        JOIN orders o ON EXISTS (SELECT 1 FROM payments p WHERE p.order_id = o.id AND p.user_id = u.id)
      `);
      const notExists = parseOracleQuery(`
        SELECT u.id FROM users u
        JOIN orders o ON NOT EXISTS (SELECT 1 FROM payments p WHERE p.order_id = o.id)
      `);
      expect(exists.success && notExists.success).toBe(true);
      if (!exists.success || !notExists.success) return;

      expect(formatJoinConditionLabel(exists.query.joins[0]!.conditionRoot!)).toContain(
        'EXISTS (SELECT 1 FROM p WHERE p.order_id = o.id AND p.user_id = u.id)',
      );
      expect(formatJoinConditionLabel(notExists.query.joins[0]!.conditionRoot!)).toContain(
        'NOT EXISTS (SELECT 1 FROM p WHERE p.order_id = o.id)',
      );
    });

    it('AND で結合した ON 条件を連結する', () => {
      const result = parseOracleQuery(`
        SELECT u.id FROM users u
        JOIN orders o ON o.user_id = u.id AND o.status = 'active'
      `);
      expect(result.success).toBe(true);
      if (!result.success) return;

      const label = formatJoinConditionLabel(result.query.joins[0]!.conditionRoot!);
      expect(label).toBe("o.user_id = u.id AND o.status = 'active'");
    });
  });

  describe('collectTableIdsFromJoinCondition', () => {
    it('サブクエリ内の相関参照テーブルを収集する', () => {
      const result = parseOracleQuery(`
        SELECT u.id
        FROM users u
        JOIN line_items li ON li.user_id = u.id
        JOIN orders o ON o.id IN (SELECT order_id FROM order_items x WHERE x.user_id = u.id)
      `);
      expect(result.success).toBe(true);
      if (!result.success) return;

      const { tables, joins } = result.query;
      const u = tables.find((t) => t.alias === 'u')!;
      const li = tables.find((t) => t.alias === 'li')!;
      const o = tables.find((t) => t.alias === 'o')!;
      const oJoin = joins.find((j) => j.targetId === o.id)!;

      const ids = new Set<string>();
      collectTableIdsFromJoinCondition(oJoin, tables, ids);
      expect([...ids].sort()).toEqual([o.id, u.id].sort());
      expect(ids.has(li.id)).toBe(false);
    });

    it('エイリアス解決後も layoutConditionRoot から相関参照を拾う', () => {
      const result = parseOracleQuery(`
        SELECT u.id
        FROM users u
        JOIN orders o ON o.user_id IN (SELECT user_id FROM banned b WHERE b.ref_id = u.id)
      `);
      expect(result.success).toBe(true);
      if (!result.success) return;

      const resolved = applyAliasResolution(result.query, true);
      const u = resolved.tables.find((t) => t.alias === 'u')!;
      const o = resolved.tables.find((t) => t.alias === 'o')!;
      const join = resolved.joins[0]!;

      expect(join.layoutConditionRoot).toBeDefined();
      expect(join.condition).toContain('users');
      expect(join.layoutConditionRoot?.label ?? '').not.toContain('users.');

      const ids = new Set<string>();
      collectTableIdsFromJoinCondition(join, resolved.tables, ids);
      expect([...ids].sort()).toEqual([o.id, u.id].sort());
    });
  });
});
