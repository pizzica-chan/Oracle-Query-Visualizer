# Oracle Query Visualizer

Oracle Database の **SELECT / UPDATE / DELETE** をブラウザ内で解析し、JOIN・条件・クエリの作用を視覚的に表示する Web UI です。
SQL の送信や外部 API 通信は行わず、**完全オフライン**で動作します。

## 機能

### SQL 入力

- リアルタイム解析（入力後 400ms）
- シンタックスハイライト（Oracle のキーワード・`(+)` 演算子・ヒントコメント・引用識別子に対応）
- サンプル読み込み（SELECT / UNION / UPDATE / DELETE / (+) 結合 / CONNECT BY）
  - SELECT: 多段 JOIN・インラインビュー・相関 EXISTS / IN / NOT IN・オプティマイザヒント・`FETCH FIRST`
  - UNION: ブランチごとに JOIN・集約・インラインビュー・サブクエリ（`UNION ALL` / `MINUS`）
  - (+) 結合: 旧式外部結合演算子を使ったカンマ結合
  - CONNECT BY: 階層問い合わせ（`START WITH` / `CONNECT BY NOCYCLE`）

### タブ

| タブ | 内容 |
|------|------|
| **SQL構造** | 句ごとの SQL 構造（表示対象・結合条件・WHERE・集約・階層問い合わせ・後処理）。クリックで左の SQL と連動（デフォルト） |
| **作用説明** | SQL が苦手な方向けの自然言語説明。JOIN を文章で説明し、要約・WHERE・集約・階層問い合わせを日本語で表示 |
| **JOIN 図** | テーブル間の結合をインタラクティブなグラフで表示。UNION / MINUS 時はブランチごとの JOIN 図 |
| **サブクエリ** | IN / EXISTS / インラインビューなどネストした SELECT を個別に解析（該当時のみ表示） |

### Oracle 固有構文の扱い

| 構文 | 扱い |
|------|------|
| **旧式外部結合 `(+)`** | カンマ結合 + WHERE の結合条件を JOIN 図の辺として組み立てます。`(+)` が付いた側が「行を補われる側」なので、`a.x = b.y(+)` は `a LEFT JOIN b`、`a.x(+) = b.y` は `a RIGHT JOIN b` として表示します |
| **カンマ結合（暗黙結合）** | WHERE 句の AND 連結された列同士の比較を結合条件として読み、INNER JOIN の辺にします。結合条件がなければ直積（CROSS JOIN）として表示します |
| **階層問い合わせ** | `START WITH` / `CONNECT BY [NOCYCLE] [PRIOR]` を専用セクションで説明します |
| **オプティマイザヒント** | `/*+ … */` を拾い、代表的なヒント（`ORDERED` / `LEADING` / `USE_NL` / `INDEX` / `PARALLEL` など）の意味を添えて表示します。**実行計画への指示であって結果集合は変わらない**ことを明示します |
| **行制限句** | `OFFSET n ROWS FETCH FIRST/NEXT m ROWS ONLY`（`PERCENT` / `WITH TIES` を含む）を後処理として説明します |
| **ROWNUM** | WHERE 句の `ROWNUM` 比較を行数制限条件として識別します |
| **集合演算** | `UNION` / `UNION ALL` / `MINUS` / `INTERSECT` をブランチごとに解析します |
| **結果集合を変えない修飾** | `PARTITION (p)` / `SAMPLE (n)` / `AS OF TIMESTAMP`（フラッシュバック）/ `FOR UPDATE [OF …] [NOWAIT]` / `table@dblink` / `ORDER SIBLINGS BY` は取り除いてから解析します |
| **その他** | `DUAL`、`SELECT UNIQUE`、`NVL` / `DECODE` / `TO_DATE` / `EXTRACT` / `REGEXP_*` などの関数、`LISTAGG … WITHIN GROUP`、分析関数 `OVER (…)`（`PARTITION BY` / `ORDER BY` / ウィンドウ枠）、`ROLLUP` / `CUBE`、`NULLS FIRST/LAST`、代替引用符 `q'[…]'`、引用識別子 `"Name"`、`#` / `$` を含む識別子（`SERIAL#` / `V$SESSION`）、`DELETE` の `FROM` 省略形 |

### その他

- **エイリアスを実テーブル名で表示** — チェックで JOIN 図・条件・SQL構造の表示名を切り替え
  - 自己結合の別名（`e` / `m`）は切り替えても残します。同じ `employees` に潰すと「employees の行をすべて残し employees を LEFT JOIN」のように説明が読めなくなるためです。実テーブル名はテーブルのラベルに併記されます

## 起動方法（開発）

```bash
npm install
npm run dev
```

ブラウザで http://localhost:5173 を開いてください。

## ビルド

```bash
npm run build
npm run preview   # ビルド成果物の確認（http://localhost:4173）
```

## 公開

`master` / `main` への push で Cloudflare が自動ビルド・デプロイします。

**公開 URL:** https://oracle-query-visualizer.kitchen1217.workers.dev/

[CI](.github/workflows/ci.yml) は push 時にテストと `dist/` の検証を行うだけで、デプロイには関与しません。

## オフライン配布

`npm run build` の成果物は **`dist/`** に出力されます。

```
dist/
  index.html      … CSS は <style> にインライン、JS は ./assets/app.js を参照
  assets/app.js
  assets/app.css  … ビルド生成物（index.html からは参照しない）
```

**インライン CSS + classic script（非 module）** のため、`dist/index.html` をブラウザで直接開いても利用できます（`dist/assets/app.js` も同じフォルダに必要）。

> `file://` では外部 CSS（`<link href="...">`）と ES module の外部読み込みが CORS でブロックされます。CSS は HTML 内に埋め込み、JS は IIFE の classic script で読み込みます。

リポジトリには `dist/` も同梱しているため、Node.js がなくても配布物だけでオフライン利用できます。

配布物を更新する場合:

```bash
npm run build               # オフライン配布向け
npm run verify-dist-offline # file:// 直開き向けか検証
npm run ensure-dist         # push 前: 再ビルド + 検証 + dist 同期チェック
```

## テスト

```bash
npm test              # ユニットテスト一式
npm run test:dist     # ビルド + オフライン監査・JOIN 図描画テスト
```

## 対応範囲

### 文種

- **SELECT**（UNION / MINUS / INTERSECT・サブクエリ・インラインビュー・WITH 句を含む）
- **UPDATE**（単一表、インラインビュー、SET 句の相関サブクエリ、複数列同時更新 `SET (a, b) = (SELECT …)`）
- **DELETE**（`FROM` 省略形を含む）

### SQL 構文（主要）

- JOIN: INNER / LEFT / RIGHT / FULL / CROSS、**NATURAL JOIN**、**JOIN USING**、カンマ結合（暗黙結合）、**旧式外部結合 `(+)`**
- **WITH（副問合せファクタリング）** — 定義の解析と FROM 参照の紐付け、作用説明での表示
- WHERE / HAVING: 比較、IN、BETWEEN、LIKE、IS NULL、EXISTS、NOT、AND / OR
- GROUP BY / ORDER BY（`NULLS FIRST` / `NULLS LAST`）/ 行制限句 / DISTINCT（`UNIQUE`）
- 階層問い合わせ: `START WITH` / `CONNECT BY [NOCYCLE] [PRIOR]`
- オプティマイザヒント `/*+ … */`

### 未対応・制限

未対応の構文は、**何が未対応なのかを日本語のエラーで返します**（パーサの英語メッセージをそのまま出しません）。

- INSERT / MERGE / DDL / PL/SQL ブロックなど、SELECT / UPDATE / DELETE 以外
- 複数文（`;` 区切りで 2 文以上）— 1 文目だけ解析して残りを黙って捨てないよう、エラーにします
- PIVOT / UNPIVOT、`GROUP BY GROUPING SETS`、MODEL 句、MATCH_RECOGNIZE、`CROSS APPLY` / `OUTER APPLY`、XMLTABLE / JSON_TABLE
- ウィンドウ枠の境界に式を書く形（`RANGE BETWEEN UNBOUNDED PRECEDING AND (sal/2) PRECEDING`）
- ウィンドウ関数の専用説明（構文としては解析します）
- 実行計画・実際の行数取得（解析・可視化のみ）

### 実運用 SQL での試験

- **実例での試験**（`src/lib/real-world-sql.test.ts`）— Oracle 公式ドキュメント・HR サンプルスキーマ・データディクショナリ問い合わせ・業務システムの定番パターンなど 101 件
- **複雑な SQL / 作りの悪い SQL の試験**（`src/lib/complex-sql.test.ts`）— 20 テーブル連鎖 JOIN、4 段ネストの相関サブクエリ、CTE の連鎖参照、7 段ネストの AND/OR/NOT、200 要素の IN リスト、旧式結合 5 テーブル、階層問い合わせとの併用など 42 件。実務でよくある「整形なし 1 行詰め込み」「WHERE 1=1」「無意味な多重括弧」「IN の代わりに OR を 12 個」「結合条件の欠落による直積」なども含みます

いずれも解析が通るかだけでなく、次まで検証します:

- 構造的不変条件（テーブル・JOIN・条件木の整合性）
- 取りこぼし（テーブル数・JOIN 数・CTE 数・ネスト数）
- 位置情報が元 SQL の範囲に収まり潰れていないこと
- **表示テキストへ内部データ（AST）が漏れていないこと**
- エイリアス解決・JOIN 図レイアウトが落ちないこと、解析が 500ms 未満で終わること

## 技術スタック

- React 19 + TypeScript + Vite
- [node-sql-parser](https://github.com/taozhi8833990/node-sql-parser) — SQL の AST 解析
  - node-sql-parser に **Oracle 専用ビルドは存在しません**。Oracle 構文のカバー率と位置情報（`loc`）の有無を全方言で実測した結果、位置情報を返すビルドの中で最もカバー率が高い **MySQL ビルド**を土台に採用し、Oracle 固有構文は `src/lib/sql-preprocess.ts` の前処理層で吸収しています（`(+)` / `CONNECT BY` / 行制限句 / ヒント / 引用識別子 / 代替引用符など）
  - 位置情報はソースハイライトと SQL ↔ 解析結果の双方向リンクの土台なので、これを返さないビルド（db2 など）は採用していません
- [@xyflow/react](https://reactflow.dev/) — JOIN 関係のグラフ表示
