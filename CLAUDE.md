# Oracle Query Visualizer

Oracle Database の SELECT / UPDATE / DELETE をブラウザ内で解析し、JOIN・条件・クエリの作用を可視化する Web UI。
React 19 + TypeScript + Vite。サーバーを持たない完全クライアント完結型。

## プロジェクト固有ルール（最優先）

Cursor と共通の恒久ルール。**全文は以下が正**（要点だけ下に再掲するが、判断に迷ったら必ず本文を読む）:

@.cursor/rules/offline-only.mdc
@.cursor/rules/dist-on-push.mdc

- **実行時の外部通信は禁止** — `fetch` / CDN / 外部フォント / Analytics SDK を入れない。SQL やユーザー入力を外部へ送らない。`npm install` や `npm run build` でのネットワーク利用は問題ない（禁止なのは配布物の実行時）。
- **push 前に `dist/` を同期** — `npm run ensure-dist` を通し、ソースと一緒に `dist/` もコミットする。`GITHUB_PAGES=true` のビルド結果は `dist/` にコミットしない。

## コマンド

```bash
npm run dev                  # 開発サーバー (http://localhost:5173)
npm test                     # ユニットテスト一式（vitest）
npm run build                # tsc -b && vite build（オフライン配布向け）
npm run test:dist            # ビルド + オフライン監査 + JOIN 図描画テスト
npm run ensure-dist          # push 前: 再ビルド + 検証 + dist 同期チェック
```

型チェック単体は `npx tsc -b`。ESLint は**未導入**なので、ソース中の `eslint-disable` コメントは実際には効いていない（意図の記録として残っている）。

## 構成

```
src/lib/        解析のロジック（UI 非依存。テストはここに集中している）
src/components/ 表示（React Flow による JOIN 図、各タブ）
src/hooks/      React Flow の state 同期
src/lib/fixtures/ 全テストが共有する SQL ケース集と不変条件アサーション
```

解析パイプライン:

```
入力 SQL
  → sql-preprocess: Oracle 固有構文を取り除き／書き換え、
                    取り除いた句（(+), CONNECT BY, 行制限句, ヒント等）を位置付きで記録し、
                    同時に processedToOriginal（位置対応表）を作る
  → node-sql-parser（MySQL ビルド）で AST 化
  → parser.ts で ParsedQuery へ変換（記録した Oracle 構文を各 SELECT へ割り当てる）
  → remapParsedQuerySpans で全 sourceSpan を元 SQL の座標へ戻す
```

## パーサ選定の経緯（変更前に必ず読む）

node-sql-parser に **Oracle 専用ビルドは無い**。全方言を実測して選定した結果が現状:

- Oracle 構文のカバー率は **mysql と db2 が同率首位**
- ただし **db2 ビルドは位置情報（`loc`）を一切返さない**（mysql は 49 箇所 / db2 は 0 箇所）
- 位置情報は SQL ハイライトと「解析結果 ↔ SQL」の双方向リンクという中核機能の土台なので、**カバー率より位置情報を優先**し mysql ビルドを採用した

方言を変えたくなったら、まず `loc` が返るかを確認すること。返らない方言に替えると UI の中核が静かに壊れる。

## 変更時に踏みやすい落とし穴

- **`parser.ts` はモジュールレベルの可変状態を持つ**（`nodeCounter` / `naturalJoinStarts` / `outerJoinMarkers` / `hierarchicalClauses` / `rowLimits` / `optimizerHints` / `nullsOrders` / `processedSql`）。`parseOracleQuery` の先頭の `resetIds()` で毎回全消しする前提なので、解析を並行化したり再入させたりすると壊れる。

- **前処理で取り除いた句は空白に置き換わり、AST の `loc` 範囲の外に出る**。どの SELECT に属するかは `recordsOwnedBySelect()` が「SELECT の範囲 + 後続の空白」で判定している。`selectRange()` の空白ぶんの延長を外すと、`FETCH FIRST` や `CONNECT BY` が末尾のクエリから外れて拾われなくなる。

- **長さを変えない書き換えを優先する**。`(+)` → 空白、`"Name"` → 別の引用記号、ヒントの `+` → 空白は、いずれも**同じ長さ**に置き換えているので位置対応表がずれない。長さが変わる書き換え（`q'[…]'`、`UNIQUE`→`DISTINCT`、CAST の型名、`DELETE` への `FROM` 補完、バックスラッシュの二重化）は `spliceProcessed()` を通し、記録済みの位置を `adjustRecordedPositions()` で補正する。**長さの変わる書き換えを追加するなら、位置を記録する処理より後ろに置く**。

- **`(+)` の向きを取り違えない**。`(+)` が付いた側が「行を補われる（NULL で埋まる）側」。`a.x = b.y(+)` は `a LEFT JOIN b`。逆にすると図と説明が両方とも嘘になる。

- **カンマ結合の JOIN 化は AND 連結された最上位の条件だけ**（`collectAndedConditions`）。OR の下の条件を結合として拾うと、実際には直積になるクエリを内部結合として描いてしまう。

- **SQL テキストを正規表現で走査するときは `maskNonCode()` を通す**。文字列リテラル・コメント・引用識別子の中身（例: `WHERE note = 'CONNECT BY x'`）を構文と誤読する。`maskNonCode` は長さを保つので、マスク後のオフセットは元テキストと一致する。

- **Oracle の字句規則は MySQL と違う**（`src/lib/sql-lex.ts`）。`--` は直後の空白を要求しない／`#` 行コメントは無い／`"` は文字列ではなく引用識別子／`\` はエスケープではない／`q'[…]'` がある。ここを MySQL の規則に戻すと前処理が静かに誤動作する。

- **vitest の既定 environment は `node`**。DOM が要るテストはファイル先頭に `// @vitest-environment happy-dom` を書く。

- **新しい SQL 構文への対応は `src/lib/fixtures/sql-cases.ts`（Oracle 固有は `oracle-cases.ts`）にケースを足す**。複数のテストファイルがこのフィクスチャを横断で回すので、1 箇所足せば解析の不変条件・正規化・オフライン監査すべてに乗る。
