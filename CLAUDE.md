# Oracle Query Visualizer

Oracle Database の SELECT / UPDATE / DELETE をブラウザ内で解析し、JOIN・条件・クエリの作用を可視化する Web UI。
React 19 + TypeScript + Vite。サーバーを持たない完全クライアント完結型。

## プロジェクト固有ルール（最優先）

Cursor と共通の恒久ルール。**全文は以下が正**（要点だけ下に再掲するが、判断に迷ったら必ず本文を読む）:

@.cursor/rules/offline-only.mdc
@.cursor/rules/dist-on-push.mdc

- **実行時の外部通信は禁止** — `fetch` / CDN / 外部フォント / Analytics SDK を入れない。SQL やユーザー入力を外部へ送らない。`npm install` や `npm run build` でのネットワーク利用は問題ない（禁止なのは配布物の実行時）。
- **push 前に `dist/` を同期** — `npm run ensure-dist` を通し、ソースと一緒に `dist/` もコミットする。

## コマンド

```bash
npm run dev                  # 開発サーバー (http://localhost:5173)
npm test                     # ユニットテスト一式（vitest）
npm run build                # tsc -b && vite build（オフライン配布向け）
npm run test:dist            # ビルド + オフライン監査 + JOIN 図描画テスト
npm run check:browser        # ビルド + ヘッドレス Chrome で dist/ を操作（Tab・IME・クリップボード・hashchange など happy-dom で見られない動き）
npm run ensure-dist          # push 前: 再ビルド + 検証 + dist 同期チェック
```

型チェック単体は `npx tsc -b`。ESLint は**未導入**なので、ソース中の `eslint-disable` コメントは実際には効いていない（意図の記録として残っている）。

## 構成

```
src/lib/        解析のロジック（UI 非依存。テストはここに集中している）
src/components/ 表示（React Flow による JOIN 図、各タブ）
src/hooks/      React Flow の state 同期、配色の購読、エディタのカーソル位置と表示の連動
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
  → remapParsedQuerySpans で全 sourceSpan を元 SQL の座標へ戻し、
    shiftParsedQuerySpans で先頭の空白の分ずらし、trimParsedQuerySpanEnds で範囲の後ろの空白とコメントを除き、
    extendParsedQuerySpansOverOuterJoinMarks で直後の (+) を範囲に入れる
```

## パーサ選定の経緯（変更前に必ず読む）

node-sql-parser に **Oracle 専用ビルドは無い**。全方言を実測して選定した結果が現状:

- Oracle 構文のカバー率は **mysql と db2 が同率首位**
- ただし **db2 ビルドは位置情報（`loc`）を一切返さない**（mysql は 49 箇所 / db2 は 0 箇所）
- 位置情報は SQL ハイライトと「解析結果 ↔ SQL」の双方向リンクという中核機能の土台なので、**カバー率より位置情報を優先**し mysql ビルドを採用した

方言を変えたくなったら、まず `loc` が返るかを確認すること。返らない方言に替えると UI の中核が静かに壊れる。

## 変更時に踏みやすい落とし穴

- **node-sql-parser は WHERE・ON・HAVING の中で AND と OR を同じ優先順位として左から結び付ける**（`a OR b AND c` が `(a OR b) AND c` になる）。`parseOracleQuery` が `astify` の直後に `logical-precedence.ts` で組み直している。AST を自分で `astify` する経路を足すときも、この組み直しを通す。Oracle の `||` は文字列の連結なので、論理演算として扱わない（パーサーは比較より強く結び付け、連結として正しく読む）。

- **`parser.ts` はモジュールレベルの可変状態を持つ**（`nodeCounter` / `naturalJoinStarts` / `outerJoinMarkers` / `hierarchicalClauses` / `rowLimits` / `optimizerHints` / `nullsOrders` / `processedSql` / `castTypes` / `aggregateClauses` / `rangeFrameStarts` / `renamedFunctions` / `embeddedSubqueryAsts` / `maskedProcessed` / `maskedProcessedFor`）。`parseOracleQuery` の先頭の `resetIds()` で毎回全消しする前提なので、解析を並行化したり再入させたりすると壊れる。変数を足したら、`resetIds()` とこの一覧の両方に足す。

- **前処理で取り除いた句は空白に置き換わり、AST の `loc` 範囲の外に出る**。どの SELECT に属するかは `recordsOwnedBySelect()` が「SELECT の範囲 + 後続の空白」で判定している。`selectRange()` の空白ぶんの延長を外すと、`FETCH FIRST` や `CONNECT BY` が末尾のクエリから外れて拾われなくなる。式の位置（`loc`）も後ろの空白まで延びるので、取り除いた句の後ろに別の句が続くと、元の SQL の位置に戻したときに、式の範囲が取り除いた句まで入る（`WHERE a = 1 START WITH … CONNECT BY … ORDER SIBLINGS BY …` の `a = 1`）。`remapParsedQuerySpansWithRemovedClauses` が句の始まりで切っているので、新しく句を取り除くときは、その範囲を parser.ts の `removedClauseSpans` に足す。テストは取り除いた句の後ろに別の句が続く形で書く（句で終わる SQL では起きない）。

- **長さを変えない書き換えを優先する**。`(+)` → 空白、`"Name"` → 別の引用記号、ヒントの `+` → 空白、ウィンドウ枠の `RANGE` → `ROWS `（後ろに空白 1 つ）は、いずれも**同じ長さ**に置き換えているので位置対応表がずれない。長さが変わる書き換え（`q'[…]'`、`UNIQUE`→`DISTINCT`、CAST の型名、`DELETE` への `FROM` 補完、`SET a = DEFAULT` の引用、バックスラッシュの二重化、`SUM(DISTINCT a)` の括弧、`VARIANCE` の仮の名前、`#`・`$`・日本語を含む識別子の引用）は `spliceProcessed()` を通し、記録済みの位置を `adjustRecordedPositions()` で補正する。**長さの変わる書き換えを追加するなら、位置を記録する処理より後ろに置く**。

- **`(+)` の向きを取り違えない**。`(+)` が付いた側が「行を補われる（NULL で埋まる）側」。`a.x = b.y(+)` は `a LEFT JOIN b`。逆にすると図と説明が両方とも嘘になる。

- **カンマ結合の JOIN 化は AND 連結された最上位の条件だけ**（`collectAndedConditions`）。OR の下の条件を結合として拾うと、実際には直積になるクエリを内部結合として描いてしまう。

- **SQL テキストを正規表現で走査するときは `maskNonCode()` を通す**。文字列リテラル・コメント・引用識別子の中身（例: `WHERE note = 'CONNECT BY x'`）を構文と誤読する。`maskNonCode` は長さを保つので、マスク後のオフセットは元テキストと一致する。ただし引用識別子も伏せるので、式の中の表の参照（`"E E".id`）を探すときは、引用識別子を残す `maskLiteralsAndComments()` を使う。

- **Oracle の字句規則は MySQL と違う**（`src/lib/sql-lex.ts`）。`--` は直後の空白を要求しない／`#` 行コメントは無い／`"` は文字列ではなく引用識別子／`\` はエスケープではない／`q'[…]'` がある。ここを MySQL の規則に戻すと前処理が静かに誤動作する。

- **解析結果の範囲は、呼び出し元が渡した SQL（前後の空白を含む）の座標で返す**。解析は前後の空白を除いた SQL で行うので、`shiftParsedQuerySpans` で先頭の空白の分ずらし、`trimParsedQuerySpanEnds` で範囲の後ろの空白とコメントを除いている。どちらも名前が `Span` で終わるフィールドを自動でたどるので、範囲を持つフィールドを足すときは名前を `…Span` にする。前処理の時点で元 SQL の座標を持つもの（`hintSpan`・`rowLimitSpan` など）も、前後の空白を除いた SQL の座標なので、同じくずらす対象になる。

- **「実質 INNER JOIN」の根拠にするのは、NULL を伝えると確かめた関数だけ**（`join-effective-inner.ts` の `NULL_PROPAGATING_FUNCTIONS`）。一覧に無い関数（`NVL`・`DECODE`・`CONCAT`・パッケージのファンクションなど）の引数の中だけに外部結合の相手の列がある条件は、根拠にしない。Oracle の `||` と `CONCAT` は、片方が NULL でももう片方の値を返す（SQL Language Reference「Concatenation Operator」）ので、MySQL 版の判定を持ってくるときに注意する。一覧に関数を足すときは、公式のリファレンスで NULL の扱いを確かめる。

- **ホバーで要素の位置や当たり判定を変えない**（`transform` で持ち上げる、線の当たり判定のパスを細くする、など）。要素の端にあるマウスが外れてホバーが切れ、戻ってまたホバーする、を繰り返してカーソルや表示が点滅する。ホバーで変えるのは色・枠・影だけにする。

- **JOIN 図の線と矢印の色は CSS 変数にしない**。React Flow は矢印マーカーの id に色の文字列を使うので、`var(...)` を渡すと id が壊れる。テーマごとの色は `themedJoinColor` / `themedJoinEdge`（`join-flow-layout.ts`）で 16 進の色を差し替える。ミニマップや背景の点など props で渡す色も同じ。

- **別名の重複は大文字小文字を区別せずに数える**。Oracle は引用符なしの名前の大文字小文字を区別しない（SQL Language Reference「Database Object Names and Qualifiers」）。「同じ別名が 1 つだけか」のように重複を数える判定（別名のツールチップなど）では、区別しない側で数える。

- **エディタのカーソル連動は DOM の `data-span-start` / `data-span-end` で要素を探す**（`useCaretSourceLink`）。新しい表示要素を SQL と連動させるときは `sourceSelectableProps` を使えば、クリックの連動とカーソルの連動の両方の対象になる。非表示のタブ（`.tab-pane--hidden`）の要素は対象外。

- **解析結果の右側（`AnalysisResult`）は `memo` で包み、SQL の入力中は描き直さない**。大きな SQL では右側の DOM が 20 万要素を超え、1 文字ごとに描き直すと入力が数秒止まる。props に渡すのは、入力中に変わらない値（`useMemo` の結果、`useState` の setter、`useCallback`）だけにする。その場で作るオブジェクトや関数（`{...}` や `() => ...`）を渡すと、描くたびに値が変わるので、memo で描き直しを止められない。`App.render-count.test.tsx` で確かめている。

- **エディタの色分け（`sql-highlight.ts`）は、入力の 1 文字ごとに SQL 全体に対して実行する**。文字ごとに正規表現を作ったり、残りの文字列を `slice` で切り出したりしない。正規表現は最初に 1 回だけ作り、sticky（`y`）で位置を指定して照合する。

- **入力中の SQL をボタンなどで差し替えるときは、SqlEditor の中で `execCommand('insertText')` を使って入れる**（サンプルの読み込みは `replaceAll`、字下げは `applyEdit`）。`setSql` などで値を直接差し替えると、ブラウザの「元に戻す」の履歴が消える。さらに 300ms 後には保存も上書きされるので、入力していた SQL を取り戻せなくなる。

- **テストや `npm run check:browser` の確認項目を足したら、直す前のコードで失敗することを確かめる**。別の経路で同じ状態になって、修正がなくても通る項目を書いてしまうことがある。直したファイルだけを `git stash push <ファイル>` で戻してテストを実行し、戻ったことを `git status` で確かめる（無いファイルを並べると stash そのものが失敗し、直したコードのままテストを実行してしまう）。不具合は特定の形でしか出ないことがある（取り除いた句の後ろに句が続く、位置を返さないノード、など）ので、見つけた SQL そのものから縮めてテストを書く。テストや確認スクリプトの指摘を、確認の仕組みの誤りと判断する前に、その SQL で実際の範囲と表示を確かめる。

- **vitest の既定 environment は `node`**。DOM が要るテストはファイル先頭に `// @vitest-environment happy-dom` を書く。

- **新しい SQL 構文への対応は `src/lib/fixtures/sql-cases.ts`（Oracle 固有は `oracle-cases.ts`）にケースを足す**。複数のテストファイルがこのフィクスチャを横断で回すので、1 箇所足せば解析の不変条件・正規化・オフライン監査すべてに乗る。

- **式の表示用の文字列（`exprToString` の結果）を、あとから読み直して表を探す処理がある**。読み直しているのは、別名の置き換え（`alias-resolver.ts`）、実質 INNER JOIN の判定（`join-effective-inner.ts`）、結合条件が参照する表（`join-condition.ts`）、カンマ結合の表の特定（parser.ts の `tableIndexOfExpression`）、作用説明の色分け（`effect-text-highlight.ts`）。名前の引用符や schema の付け方など、式の書き方を変えたら、これらをすべて確かめる（`\.` を含む正規表現で検索すると洗い出せる）。表の参照を正規表現で探すときは `\b` を使わず、`qualifiedReferencePattern()`（sql-lex.ts）を使う。`\b` は ASCII の文字しか語として扱わないので、日本語の名前（`売上.`）の前で境界にならない。

- **SQL パーサーは、文字列・数値・NULL・CASE 式・CAST・DUAL・FROM 句のサブクエリに位置（`loc`）を返さない**。列の範囲は `fillMissingColumnSpans`、インラインビューは `derivedTableSourceSpan`、DUAL は `fillDualSpan` で補い、CAST の元の型名は、位置で探せないときに書き換えたあとの型名で探している（いずれも parser.ts）。範囲や位置に頼る処理を足すときは、これらの形でもテストする。

- **SQL パーサー（MySQL ビルド）は、Oracle では書けない SQL も受け付ける**（ON の無い `JOIN` など）。受け付けたまま説明すると、Oracle では動かない SQL の作用を見せてしまう。新しい書き方に対応するときは、SQL Language Reference の構文図（文章版は `img_text/<名前>.html`）で書けるかを確かめ、書けない形はエラーにする。

- **作用説明に、SQL の結果についての説明（NULL の扱い・ROWNUM・小計の行・行ロックなど）を足すときは、公式のリファレンスで確かめ、コードのコメントに出典を書く**。ページの文を文言どおりに確かめられないときは、確かめられた範囲だけを書き、コメントにもそう書く。

- **解析の途中で使う仮の名前と値を、画面に出さない**（結合条件の無い JOIN の印 `(no condition)`、別名の無いサブクエリの `derived`、名前を読めなかった表の `table_1`）。`display-placeholder.test.ts` が、共有のケース集の全件の作用説明と SQL 構造で確かめている。仮の名前を新しく作るときは、このテストの判定にも足す。

- **MySQL 版（`../MySQL-QueryParser`）と同じ作りのファイルが多い**（`query-effect.ts`・`join-effective-inner.ts`・`join-condition.ts`・`alias-resolver.ts`・`effect-text-highlight.ts`、parser.ts の式の表示と範囲を補う処理など）。片方で不具合を直したら、もう片方の同じ関数も確かめる。違う作りの例: 集合演算の結果全体の ORDER BY と行制限は、Oracle 版では最上位の `ParsedQuery` が持ち、MySQL 版では `unionTail` が持つ。
