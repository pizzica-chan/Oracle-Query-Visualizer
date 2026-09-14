import { describe, expect, it } from 'vitest';
import {
  isHintCommentStart,
  isLineCommentStart,
  maskNonCode,
  readBalancedParenEnd,
  readQQuoteEnd,
  readQuotedIdentifierEnd,
  readStringLiteralEnd,
} from './sql-lex';

describe('sql-lex', () => {
  describe('readBalancedParenEnd', () => {
    it('対応する閉じ括弧の直後を返す', () => {
      expect(readBalancedParenEnd('(a, b)', 0)).toBe(6);
      expect(readBalancedParenEnd('IN (idx_a, (idx_b))', 3)).toBe(19);
    });

    it('文字列・コメント・引用識別子内の括弧は数えない', () => {
      expect(readBalancedParenEnd("('a)b')", 0)).toBe(7);
      expect(readBalancedParenEnd('("x)y")', 0)).toBe(7);
      expect(readBalancedParenEnd('(idx /* ) */ )', 0)).toBe(14);
      expect(readBalancedParenEnd('(idx -- )\n)', 0)).toBe(11);
      expect(readBalancedParenEnd("(q'[)]' )", 0)).toBe(9);
    });

    it('閉じ括弧が無ければ null', () => {
      expect(readBalancedParenEnd('(idx', 0)).toBeNull();
      expect(readBalancedParenEnd('idx', 0)).toBeNull();
    });
  });

  describe('行コメント', () => {
    it('Oracle の -- は直後の空白を要求しない', () => {
      expect(isLineCommentStart('a--b', 1)).toBe(true);
      expect(isLineCommentStart('a-- b', 1)).toBe(true);
      expect(isLineCommentStart('a-b', 1)).toBe(false);
    });
  });

  describe('ヒントコメント', () => {
    it('/*+ で始まるブロックコメントだけをヒントと判定する', () => {
      expect(isHintCommentStart('/*+ FULL(t) */', 0)).toBe(true);
      expect(isHintCommentStart('/* memo */', 0)).toBe(false);
    });
  });

  describe('文字列リテラル', () => {
    it("'' で埋め込んだ単一引用符を終端にしない", () => {
      const text = "'O''Brien' AND";
      expect(readStringLiteralEnd(text, 0)).toBe(10);
    });

    it('バックスラッシュはエスケープにしない（Oracle の規則）', () => {
      const text = "'C:\\' AND x = 1";
      expect(readStringLiteralEnd(text, 0)).toBe(5);
    });
  });

  describe('引用識別子', () => {
    it('"" で埋め込んだ二重引用符を終端にしない', () => {
      const text = '"A""B" FROM';
      expect(readQuotedIdentifierEnd(text, 0)).toBe(6);
    });
  });

  describe('代替引用符', () => {
    it('対応する区切り文字まで読む', () => {
      expect(readQQuoteEnd("q'[it's]' x", 0)).toBe(9);
      expect(readQQuoteEnd("q'{a}' x", 0)).toBe(6);
      expect(readQQuoteEnd("q'!a!' x", 0)).toBe(6);
      expect(readQQuoteEnd("N'abc'", 0)).toBeNull();
    });

    it('代替引用符でなければ null', () => {
      expect(readQQuoteEnd("'plain'", 0)).toBeNull();
      expect(readQQuoteEnd('query', 0)).toBeNull();
    });
  });

  describe('maskNonCode', () => {
    it('文字列・コメント・引用識別子を同じ長さの空白にする', () => {
      const sql = `SELECT 'a' , "B" -- c\nFROM t`;
      const masked = maskNonCode(sql);
      expect(masked).toHaveLength(sql.length);
      expect(masked).not.toContain("'a'");
      expect(masked).not.toContain('"B"');
      expect(masked).toContain('FROM t');
    });
  });
});
