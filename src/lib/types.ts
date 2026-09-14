export interface SourceSpan {
  start: number;
  end: number;
}

export interface SqlFragment {
  text: string;
  sourceSpan?: SourceSpan;
}

export type JoinType =
  | 'INNER JOIN'
  | 'LEFT JOIN'
  | 'RIGHT JOIN'
  | 'FULL JOIN'
  | 'CROSS JOIN'
  | 'JOIN';

/** オプティマイザヒント `/*+ … *\/` */
export interface OptimizerHint {
  /** `/*+` と `*\/` を除いたヒント本文 */
  text: string;
  sourceSpan?: SourceSpan;
}

/** 階層問い合わせ（CONNECT BY / START WITH） */
export interface HierarchicalQuery {
  startWith?: string;
  connectBy?: string;
  noCycle?: boolean;
  sourceSpan?: SourceSpan;
  startWithSpan?: SourceSpan;
  connectBySpan?: SourceSpan;
}

export interface CteRef {
  name: string;
  query: ParsedQuery;
  sourceSpan?: SourceSpan;
}

export interface TableRef {
  id: string;
  schema?: string;
  table: string;
  alias?: string;
  displayName: string;
  /** FROM句の派生テーブル `(SELECT ...) AS t` */
  isDerived?: boolean;
  derivedQuery?: ParsedQuery;
  /** 元 SQL 内のテーブル参照位置 */
  sourceSpan?: SourceSpan;
}

export interface UnionBranch {
  id: string;
  /** 先頭ブランチは undefined */
  operator?: string;
  query: ParsedQuery;
  /** 元 SQL 内のこの SELECT ブランチ全体 */
  sourceSpan?: SourceSpan;
}

export interface JoinEdge {
  id: string;
  type: JoinType;
  sourceId: string;
  targetId: string;
  condition: string;
  conditionParts?: { left: string; operator: string; right: string };
  /** ON 条件の構造化表現（サブクエリ・相関参照を含む） */
  conditionRoot?: ConditionNode;
  /** レイアウト解析用 — エイリアス解決前の ON 条件（表示用 condition とは別） */
  layoutCondition?: string;
  layoutConditionParts?: { left: string; operator: string; right: string };
  layoutConditionRoot?: ConditionNode;
  /** ON 条件の位置 */
  sourceSpan?: SourceSpan;
  /** NATURAL JOIN（同名前列で結合） */
  isNatural?: boolean;
  /** FROM 句のカンマ結合に対し WHERE 句の条件から組み立てた結合 */
  fromWhereClause?: boolean;
  /** 旧式外部結合演算子 `(+)` 由来の外部結合 */
  isOuterJoinOperator?: boolean;
}

export type ConditionNodeType =
  | 'and'
  | 'or'
  | 'not'
  | 'comparison'
  | 'in'
  | 'between'
  | 'like'
  | 'is_null'
  | 'exists'
  | 'subquery'
  | 'function'
  | 'raw';

export interface ConditionNode {
  id: string;
  type: ConditionNodeType;
  label: string;
  operator?: string;
  left?: string;
  right?: string;
  children?: ConditionNode[];
  highlight?: boolean;
  /** 元 SQL 内の条件式位置 */
  sourceSpan?: SourceSpan;
  /** IN / EXISTS / 比較式内のサブクエリ */
  nestedQuery?: ParsedQuery;
  /** 旧式外部結合演算子 `(+)` が付いていた辺（付いた側が「行を補われる側」） */
  outerJoinSide?: 'left' | 'right';
  /** ROWNUM による行数制限条件 */
  isRownum?: boolean;
}

export interface SelectColumn {
  expression: string;
  alias?: string;
  sourceSpan?: SourceSpan;
}

export interface SetClause {
  column: string;
  table?: string;
  value: string;
  label: string;
}

export interface DeleteTarget {
  name: string;
  label: string;
}

export interface ParsedQuery {
  rawSql: string;
  statementType: 'SELECT' | 'UPDATE' | 'DELETE';
  /** 元 SQL 内のこの SELECT（サブクエリ・UNION ブランチ等）の範囲 */
  sourceSpan?: SourceSpan;
  tables: TableRef[];
  joins: JoinEdge[];
  where?: ConditionNode;
  having?: ConditionNode;
  columns: SelectColumn[];
  setClauses?: SetClause[];
  deleteTargets?: DeleteTarget[];
  groupBy: SqlFragment[];
  orderBy: SqlFragment[];
  /** FETCH FIRST … ROWS ONLY の行数 */
  limit?: string;
  limitSpan?: SourceSpan;
  /** OFFSET … ROWS のスキップ行数 */
  offset?: string;
  offsetSpan?: SourceSpan;
  /** FETCH FIRST n PERCENT ROWS — 件数ではなく割合 */
  rowLimitPercent?: boolean;
  /** FETCH … WITH TIES — 同順位の行も返す */
  rowLimitWithTies?: boolean;
  /** 元 SQL 上の行制限句全体 */
  rowLimitSpan?: SourceSpan;
  distinct: boolean;
  /** オプティマイザヒント */
  hints?: OptimizerHint[];
  /** 元 SQL 上のヒントコメント範囲（先頭のヒント） */
  hintSpan?: SourceSpan;
  /** 階層問い合わせ */
  hierarchical?: HierarchicalQuery;
  /** UNION / UNION ALL 等の各ブランチ（2本以上のとき） */
  unionBranches?: UnionBranch[];
  /** WITH 句で定義された CTE */
  ctes?: CteRef[];
}

export interface ParseError {
  message: string;
  position?: number;
}

export type ParseResult =
  | { success: true; query: ParsedQuery }
  | { success: false; error: ParseError };
