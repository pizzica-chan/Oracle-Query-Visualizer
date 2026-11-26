# レビューの記録

## 2026-11-26 MySQL 版からの取り込みのセルフレビュー

- 観点: 日本語の表記、技術的な正しさ、横展開
- 範囲: push 済みのコミット 8bddbcb（`src/`、`scripts/browser-check/`、`index.html`、`CLAUDE.md`、`README.md`）と、MySQL 版の a80f8b4（`src/lib/query-effect.ts`）。`dist/` はビルドの生成物なので対象外。`src/index.css` は比較モードの規則を除いたかだけを見て、見た目は `npm run check:browser` の結果で確かめた
- モデル: claude-opus-5-5（エフォート: 不明）
- 結果: 指摘 3 件。3 件とも直した（この記録と同じコミット）
  - 日本語の名前のバインド変数（`WHERE t.name = :名前`）が構文エラーになっていた。8bddbcb より前は読めていた退行で、日本語の識別子を引用する処理が `:` のあとの名前まで引用していた
  - 全角の空白のエラー文が、Oracle の動作の説明として読める書き方だった。この画面の解析での扱いだと分かる書き方にした
  - 実質 INNER JOIN の判定のコメントで、リファレンスで確かめていない関数の動作（REPLACE と CONCAT、GROUPING と GROUPING_ID）を、確かめたように書いていた
