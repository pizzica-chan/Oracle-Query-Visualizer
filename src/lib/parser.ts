/* eslint-disable @typescript-eslint/no-explicit-any */
// node-sql-parser には Oracle 専用ビルドが無い。Oracle 構文のカバー率と
// 位置情報（loc）の両方を実測で比べた結果、MySQL ビルドが最良だったため
// これを土台にし、Oracle 固有構文は sql-preprocess.ts で吸収している。
// 既定エントリ（ルート）は全方言を同梱するので、専用ビルドを直接読む
// （オフライン配布の JS を大幅に軽くする）
import { Parser } from 'node-sql-parser/build/mysql';
import { normalizeConditionTree } from './condition-tree-normalize';
import { NO_JOIN_CONDITION, formatJoinConditionLabel } from './join-condition';
import { fixLogicalOperatorPrecedence } from './logical-precedence';
import { displayIdentifier, findUnclosedLiteral, isWordChar, readBalancedParenEnd } from './sql-lex';
import {
  maskNonCode,
  preprocessSqlForParser,
  remapParsedQuerySpans,
  shiftParsedQuerySpans,
  trimParsedQuerySpanEnds,
  type AggregateClauseInfo,
  type CastTypeInfo,
  type HierarchicalClauseInfo,
  type NullsOrderInfo,
  type OptimizerHintInfo,
  type OuterJoinMarker,
  type RowLimitInfo,
} from './sql-preprocess';
import {
  columnEntrySourceSpan,
  orderByEntrySourceSpan,
  toSourceSpan,
} from './source-span';
import type {
  ConditionNode,
  CteRef,
  HierarchicalQuery,
  JoinEdge,
  JoinType,
  OptimizerHint,
  ParseResult,
  ParsedQuery,
  SelectColumn,
  SetClause,
  DeleteTarget,
  SqlFragment,
  SourceSpan,
  TableRef,
} from './types';

const parser = new Parser();

let nodeCounter = 0;
/** 前処理後 SQL 上で NATURAL 由来の JOIN キーワード開始オフセット */
let naturalJoinStarts: number[] = [];
let processedSql = '';
/** 前処理で取り除いた Oracle 固有構文（位置は前処理後 SQL 上） */
let outerJoinMarkers: OuterJoinMarker[] = [];
let hierarchicalClauses: HierarchicalClauseInfo[] = [];
let rowLimits: RowLimitInfo[] = [];
let optimizerHints: OptimizerHintInfo[] = [];
let nullsOrders: NullsOrderInfo[] = [];
/** CAST の型名を書き換えた所（位置は前処理後 SQL 上）。表示で元の型名に戻す */
let castTypes: CastTypeInfo[] = [];
/** 取り除いた WITHIN GROUP (…) / KEEP (…)（位置は前処理後 SQL 上）。表示で関数の後ろに戻す */
let aggregateClauses: AggregateClauseInfo[] = [];
/** ウィンドウ枠の RANGE を ROWS に置き換えた位置（前処理後 SQL 上）。表示で RANGE に戻す */
let rangeFrameStarts: number[] = [];
/** 前処理で置き換えた関数名（大文字の仮の名前 → 元の名前） */
let renamedFunctions = new Map<string, string>();
/**
 * exprToString が要約したサブクエリの AST。いま組み立てているクエリの分だけを持つ
 * （collectEmbeddedSubqueries がクエリごとに差し替える）
 */
let embeddedSubqueryAsts: any[] = [];
/** maskedProcessedSql() の結果と、その元にした processedSql */
let maskedProcessed = '';
let maskedProcessedFor = '';

function nextId(prefix: string): string {
  nodeCounter += 1;
  return `${prefix}-${nodeCounter}`;
}

function resetIds(): void {
  nodeCounter = 0;
  naturalJoinStarts = [];
  processedSql = '';
  outerJoinMarkers = [];
  hierarchicalClauses = [];
  rowLimits = [];
  optimizerHints = [];
  nullsOrders = [];
  castTypes = [];
  aggregateClauses = [];
  rangeFrameStarts = [];
  renamedFunctions = new Map();
  embeddedSubqueryAsts = [];
  maskedProcessed = '';
  maskedProcessedFor = '';
}

function noteEmbeddedSubquery(ast: any): void {
  if (!embeddedSubqueryAsts.includes(ast)) embeddedSubqueryAsts.push(ast);
}

/**
 * build の間に exprToString が要約したサブクエリを解析し、embeddedSubqueries として持たせる。
 * 要約した文字列（`(SELECT 1列 FROM t)`）だけでは、中の別名がどのテーブルを指すかが分からない
 */
function collectEmbeddedSubqueries(build: () => ParsedQuery): ParsedQuery {
  const outer = embeddedSubqueryAsts;
  embeddedSubqueryAsts = [];
  try {
    const query = build();
    const collected = embeddedSubqueryAsts;
    if (collected.length === 0) return query;
    return { ...query, embeddedSubqueries: collected.map((ast) => parseSelectQuery(ast, '')) };
  } finally {
    embeddedSubqueryAsts = outer;
  }
}

function formatIdentifier(name: unknown): string {
  if (name == null) return '';
  if (typeof name === 'string') return name;
  if (typeof name === 'object' && name !== null && 'value' in name) {
    const value = (name as { value?: unknown }).value;
    if (value != null) return String(value);
  }
  return String(name);
}

function formatTableName(db: string | undefined, table: string): string {
  if (db) return `${db}.${table}`;
  return table;
}

function toArray<T>(value: T | T[] | null | undefined): T[] {
  if (value == null) return [];
  return Array.isArray(value) ? value : [value];
}

/**
 * 関数名を大文字で返す。前処理で仮の名前に置き換えた関数（VARIANCE）は、元の名前に戻す。
 * `pkg.f(x)` や `schema.f(x)` の修飾は、パーサーが名前とは別の schema に入れる。落とすと、
 * 別のパッケージの関数（pkg1.f と pkg2.f）が同じ関数に見える
 */
function resolveFunctionName(nameField: unknown): string {
  const name = readFunctionName(nameField);
  const restored = renamedFunctions.get(name) ?? name;
  const schema =
    nameField && typeof nameField === 'object' ? formatIdentifier((nameField as { schema?: unknown }).schema) : '';
  return schema ? `${schema}.${restored}` : restored;
}

function readFunctionName(nameField: unknown): string {
  if (typeof nameField === 'string') return nameField.toUpperCase();
  if (!nameField || typeof nameField !== 'object') return '';

  const inner = (nameField as { name?: unknown }).name;

  if (typeof inner === 'string') return inner.toUpperCase();

  if (Array.isArray(inner)) {
    return inner
      .map((item) => {
        if (typeof item === 'string') return item;
        if (item && typeof item === 'object' && 'value' in item) {
          return String((item as { value: unknown }).value);
        }
        return '';
      })
      .filter(Boolean)
      .join(' ')
      .toUpperCase();
  }

  return '';
}

function extractFunctionArgs(node: any): any[] {
  const raw = node.args?.value ?? node.args;
  if (raw?.type === 'expr_list') return toArray(raw.value);
  return toArray(raw);
}

/**
 * 文字列リテラルを引用符で囲んで書く。パーサーは引用符の中身を、`''` も含めて書いたとおりに value に入れる。
 * ただしバックスラッシュは、前処理（escapeBackslashesInStringLiterals）が二重にしてから渡しているので、元の 1 つに戻す。
 * 戻さないと、`'C:\temp'` が `'C:\\temp'`（別の値）に見える
 */
function formatSingleQuotedString(value: string): string {
  return `'${value.replace(/\\\\/g, '\\')}'`;
}

function formatDoubleQuotedString(value: string): string {
  return `"${value}"`;
}

function formatQuotedLiteral(node: any): string {
  if (typeof node.raw === 'string' && node.raw.length > 0) {
    const raw = node.raw;
    if (raw.startsWith("'") || raw.startsWith('"')) return raw;
  }
  if (node.type === 'double_quote_string') return formatDoubleQuotedString(String(node.value));
  return formatSingleQuotedString(String(node.value));
}

/**
 * 接頭辞の付くリテラル（N'abc'、DATE '2024-01-01'、TIMESTAMP '2024-01-01 00:00:00'）。
 * パーサーは引用符の中身だけを value に入れるので、接頭辞と引用符を戻さないと、
 * DATE '2024-01-01' が 2024-01-01（引き算の式）に、N'abc' が列名の abc に見える
 */
function formatPrefixedLiteral(node: any): string | null {
  const value = String(node.value ?? '');
  switch (node.type) {
    case 'natural_string':
      return `N${formatSingleQuotedString(value)}`;
    case 'date':
    case 'time':
    case 'timestamp':
    case 'datetime':
      return `${String(node.type).toUpperCase()} ${formatSingleQuotedString(value)}`;
    default:
      return null;
  }
}

/** LIKE の ESCAPE 句。右辺に付くので、比較を組み立てるときも忘れず添える */
function formatEscapeClause(node: any): string {
  const escape = node?.right?.escape;
  return escape ? ` ESCAPE ${exprToString(escape.value)}` : '';
}

/**
 * 関数の引数を並べる。`TRIM(BOTH ' ' FROM name)` のようにキーワードが引数列に混ざる形があり、
 * そこへカンマを入れると元の SQL と違う式に見えてしまう
 */
function formatFunctionArgs(args: any[]): string {
  let out = '';
  let prevWasKeyword = false;
  args.forEach((arg: any, index: number) => {
    const isKeyword = arg?.type === 'origin';
    // キーワード（LEADING・FROM など）は、ほかのキーワードと同じく大文字で書く。パーサーは書いたとおりに持つ
    const text = isKeyword ? exprToString(arg).toUpperCase() : exprToString(arg);
    if (index > 0) out += isKeyword || prevWasKeyword ? ' ' : ', ';
    out += text;
    prevWasKeyword = isKeyword;
  });
  return out;
}

/** CAST の変換先データ型。node-sql-parser は配列で返し、桁・精度は別フィールドに入る */
function formatCastTarget(target: any): string {
  const entry = Array.isArray(target) ? target[0] : target;
  if (!entry) return '';
  const dataType = String(entry.dataType ?? '');
  const params = [entry.length, entry.scale].filter((v) => v !== undefined && v !== null);
  return params.length > 0 ? `${dataType}(${params.join(',')})` : dataType;
}

/**
 * ウィンドウ枠。`ROWS BETWEEN a AND b` は BETWEEN の二項式、
 * `ROWS UNBOUNDED PRECEDING` は { type: 'rows', expr } の形で来る
 */
function formatWindowFrame(frame: any): string {
  if (!frame) return '';
  if (frame.type !== 'binary_expr' && typeof frame.type === 'string' && frame.expr) {
    return `${frame.type} ${exprToString(frame.expr)}`;
  }
  return exprToString(frame);
}

/**
 * CAST の変換先として元の SQL に書いた型（`NUMBER(10, 2)`）。前処理で MySQL の型名（DECIMAL）に
 * 書き換えてから読むので、式の直後の AS の位置で書き換えた記録を探して戻す。見つからなければ undefined
 */
function originalCastType(node: any): string | undefined {
  const exprEnd = node?.expr?.loc?.end?.offset;
  if (typeof exprEnd !== 'number') return undefined;
  const record = castTypes.find(
    (r) => r.processedPos >= exprEnd && /^[\s)]*AS\s*$/i.test(processedSql.slice(exprEnd, r.processedPos)),
  );
  return record?.originalType;
}

/**
 * 関数の呼び出しの直後にあった WITHIN GROUP (…) / KEEP (…)（前の空白を含む）。無ければ空文字。
 * 前処理で空白に置き換えてから読むので、呼び出しの閉じ括弧の直後で記録を探す。
 * 引数の中の関数の記録と取り違えないよう、関数の始まりからの括弧が閉じきった位置のものだけを使う
 */
function trailingAggregateClause(node: any): string {
  const start = node?.loc?.start?.offset;
  const end = node?.loc?.end?.offset;
  if (typeof start !== 'number' || typeof end !== 'number' || aggregateClauses.length === 0) return '';
  const record = aggregateClauses.find((r) => {
    if (r.processedPos <= start || r.processedPos > end) return false;
    const before = maskNonCode(processedSql.slice(start, r.processedPos)).trimEnd();
    if (!before.endsWith(')')) return false;
    let depth = 0;
    for (const ch of before) {
      if (ch === '(') depth += 1;
      else if (ch === ')') depth -= 1;
    }
    return depth === 0;
  });
  return record ? ` ${record.text}` : '';
}

/** 分析関数の OVER 句。落とすと同じ関数呼び出しに見えてしまう */
/** 関数の OVER 句の枠を、前処理で RANGE から ROWS に置き換えたか */
function hasRangeFrame(node: any): boolean {
  const start = node?.loc?.start?.offset;
  const end = node?.loc?.end?.offset;
  if (typeof start !== 'number' || typeof end !== 'number') return false;
  return rangeFrameStarts.some(
    (pos) => pos > start && pos < end && /\bOVER\b/i.test(maskNonCode(processedSql.slice(start, pos))),
  );
}

function formatOverClause(over: any, node?: any): string {
  const named = over?.as_window_specification;
  // `OVER w`（WINDOW 句で定義した名前の参照）は文字列で来る
  if (typeof named === 'string') return named ? ` OVER ${named}` : '';
  const spec = named?.window_specification;
  if (!spec) return named?.name ? ` OVER ${named.name}` : '';

  const parts: string[] = [];
  const partitionBy = toArray<any>(spec.partitionby)
    .map((p: any) => exprToString(p?.expr ?? p))
    .filter(Boolean);
  if (partitionBy.length > 0) parts.push(`PARTITION BY ${partitionBy.join(', ')}`);

  const orderBy = toArray<any>(spec.orderby)
    .map((o: any) => {
      const nulls = nullsOrderFor(o);
      return `${exprToString(o?.expr ?? o)}${o?.type ? ` ${o.type}` : ''}${nulls ? ` NULLS ${nulls.position}` : ''}`;
    })
    .filter((text) => text.trim().length > 0);
  if (orderBy.length > 0) parts.push(`ORDER BY ${orderBy.join(', ')}`);

  // 枠（ROWS BETWEEN 1 PRECEDING AND CURRENT ROW など）は集計する行の範囲を決める。落とすと別の集計に見える
  const frame = formatWindowFrame(spec.window_frame_clause).toUpperCase();
  if (frame) parts.push(hasRangeFrame(node) ? frame.replace(/^ROWS\b/, 'RANGE') : frame);

  return ` OVER (${parts.join(' ')})`;
}

/** 式に付く COLLATE。表示から外すと、照合順序を変えた比較が普通の比較と同じ式に見える */
function formatExprSuffix(node: any): string {
  let out = '';
  const collation = node?.collate?.collate?.name;
  if (collation) out += ` COLLATE ${formatIdentifier(collation)}`;
  if (typeof node?.suffix === 'string' && node.suffix) out += ` ${node.suffix}`;
  return out;
}

function exprToString(node: any): string {
  if (!node) return '';
  return `${exprToStringCore(node)}${formatExprSuffix(node)}`;
}

function exprToStringCore(node: any): string {

  // 元 SQL の括弧を落とすと (a + b) * 2 が a + b * 2 になり、表示が別の意味になる
  const wrap = (text: string): string => (node.parentheses ? `(${text})` : text);

  switch (node.type) {
    case 'column_ref': {
      const parts: string[] = [];
      if (node.table) parts.push(displayIdentifier(formatIdentifier(node.table)));
      if (node.column) parts.push(displayIdentifier(formatIdentifier(node.column)));
      return parts.join('.') || '*';
    }
    case 'number':
      return String(node.value);
    case 'bool':
      // パーサーは TRUE / FALSE を JavaScript の真偽値で持つ。ほかのキーワードと同じく大文字で書く
      return String(node.value).toUpperCase();
    case 'string':
    case 'single_quote_string':
    case 'double_quote_string':
      return formatQuotedLiteral(node);
    case 'natural_string':
    case 'date':
    case 'time':
    case 'timestamp':
    case 'datetime':
      return formatPrefixedLiteral(node) ?? String(node.value);
    case 'param':
      // バインド変数 `:id`。コロンを落とすと列名の id に見える
      return `:${formatIdentifier(node.value)}`;
    case 'null':
      return 'NULL';
    case 'star':
      return node.table ? `${node.table}.*` : '*';
    case 'expr_list':
      // 行の値 `(a, b) IN ((1, 2))` の括弧。IN の値の並びには parentheses が付かないので、括弧は二重にならない
      return wrap(
        toArray(node.value)
          .map((a: any) => exprToString(a))
          .join(', '),
      );
    case 'binary_expr': {
      // BETWEEN の上限と下限は、パーサーが値の並びで持つ。そのまま書くと `a BETWEEN 1, 5` になる
      const betweenBounds =
        /^(NOT\s+)?BETWEEN$/i.test(String(node.operator ?? '')) && node.right?.type === 'expr_list'
          ? toArray<any>(node.right.value)
          : [];
      if (betweenBounds.length === 2) {
        return wrap(
          `${exprToString(node.left)} ${node.operator} ${exprToString(betweenBounds[0])} AND ${exprToString(betweenBounds[1])}`,
        );
      }
      // ESCAPE を落とすと LIKE の意味が変わって見える
      return wrap(
        `${exprToString(node.left)} ${node.operator} ${exprToString(node.right)}${formatEscapeClause(node)}`,
      );
    }
    case 'unary_expr':
      return wrap(`${node.operator} ${exprToString(node.expr)}`);
    case 'extract':
      return `EXTRACT(${node.args?.field ?? ''} FROM ${exprToString(node.args?.source)})`;
    case 'interval':
      return `INTERVAL ${exprToString(node.expr)} ${String(node.unit ?? '').toUpperCase()}`.trim();
    case 'function': {
      const fnName = resolveFunctionName(node.name);
      const rawArgs = extractFunctionArgs(node);
      // 前処理で仮の名前にした集約（VARIANCE）の `DISTINCT(a)` は、元の `VARIANCE(DISTINCT a)` の形に戻す。
      // Oracle に DISTINCT という関数は無いので、この形は前処理が作ったものだけ
      const distinctArg = rawArgs.length === 1 ? rawArgs[0] : undefined;
      if (distinctArg?.type === 'function' && resolveFunctionName(distinctArg.name) === 'DISTINCT' && !distinctArg.over) {
        return `${fnName}(DISTINCT ${formatFunctionArgs(extractFunctionArgs(distinctArg))})${formatOverClause(node.over, node)}`;
      }
      const args = formatFunctionArgs(rawArgs);
      // `a > ALL (SELECT …)` や `EXISTS (SELECT …)`。サブクエリの要約は括弧付きなので、関数の括弧を重ねない
      if (/^(?:ALL|ANY|SOME|EXISTS)$/.test(fnName) && /^\(SELECT .*\)$/.test(args)) return `${fnName} ${args}`;
      // 前処理で関数の形にした階層問い合わせの演算子は、元の `CONNECT_BY_ROOT e.name` の形に戻す
      if (/^(?:CONNECT_BY_ROOT|PRIOR)$/.test(fnName) && rawArgs.length === 1 && !node.over) return `${fnName} ${args}`;
      return `${fnName}(${args})${trailingAggregateClause(node)}${formatOverClause(node.over, node)}`;
    }
    case 'aggr_func': {
      let rawArgs = node.args?.expr ?? node.args?.value ?? node.args;
      let distinctPrefix = node.args?.distinct ? 'DISTINCT ' : '';
      // `SUM(DISTINCT a)` は前処理で `SUM(DISTINCT(a))` にしてから読むので、DISTINCT という名前の関数で来る
      if (
        !distinctPrefix &&
        rawArgs?.type === 'function' &&
        resolveFunctionName(rawArgs.name) === 'DISTINCT' &&
        !rawArgs.over
      ) {
        distinctPrefix = 'DISTINCT ';
        rawArgs = extractFunctionArgs(rawArgs);
      }
      const args = toArray<any>(rawArgs)
        .map((a: any) => exprToString(a))
        .join(', ');
      return `${node.name}(${distinctPrefix}${args})${trailingAggregateClause(node)}${formatOverClause(node.over, node)}`;
    }
    case 'case': {
      // ELSE は args の末尾に type:'else' の要素として入る。条件のフィールド名は cond。
      // 単純 CASE（CASE 式 WHEN 値 …）は対象式が node.expr に来る
      const operand = node.expr ? ` ${exprToString(node.expr)}` : '';
      const branches = toArray<any>(node.args).map((arg: any) => {
        if (arg?.type === 'else') return `ELSE ${exprToString(arg.result)}`;
        const cond = exprToString(arg?.cond ?? arg?.condition);
        return `WHEN ${cond} THEN ${exprToString(arg?.result)}`;
      });
      return `CASE${operand} ${branches.join(' ')} END`;
    }
    case 'cast': {
      return `CAST(${exprToString(node.expr)} AS ${originalCastType(node) ?? formatCastTarget(node.target)})`;
    }
    case 'datatype':
      // 型を引数に取る関数の型。素通しすると AST の JSON が表示に出る
      return formatCastTarget(node);
    case 'subquery': {
      const inner = node.subquery?.ast ?? node.subquery ?? node.ast;
      if (inner?.type === 'select') {
        noteEmbeddedSubquery(inner);
        return summarizeSelect(inner);
      }
      return '(subquery)';
    }
    default: {
      // `SET col = (SELECT …)` のように、型を持たず ast だけを抱えたノードが来る
      const inner = extractSubquerySelectAst(node);
      if (inner) {
        noteEmbeddedSubquery(inner);
        return summarizeSelect(inner);
      }
      if (node.value !== undefined) return String(node.value);
      if (node.raw) return node.raw;
      return JSON.stringify(node);
    }
  }
}

function extractSubquerySelectAst(node: any): any | null {
  if (!node) return null;
  if (node.type === 'subquery') {
    const inner = node.subquery?.ast ?? node.subquery;
    return inner?.type === 'select' ? inner : null;
  }
  if (node.ast?.type === 'select') return node.ast;
  if (node.type === 'select') return node;
  if (node.type === 'expr_list') {
    for (const item of toArray<any>(node.value)) {
      const found = extractSubquerySelectAst(item);
      if (found) return found;
    }
  }
  return null;
}

function summarizeSelect(ast: any): string {
  const from = toArray<any>(ast.from);
  const first = from[0];
  if (first?.expr?.ast?.type === 'select') {
    const alias = first.as ?? 'derived';
    return `(SELECT ... AS ${alias})`;
  }
  const cols = toArray<any>(ast.columns).length;
  // `EXISTS (SELECT 1 FROM DUAL)`。DUAL は名前を持たないので、そのままだと「FROM ?」になる
  if (first?.type === 'dual') return `(SELECT ${cols}列 FROM DUAL)`;
  return `(SELECT ${cols}列 FROM ${first?.table ?? '?'})`;
}

function normalizeSetOp(op: string | undefined): string {
  if (!op) return 'UNION';
  return op.replace(/\s+/g, ' ').trim().toUpperCase();
}

function collectUnionBranches(root: any): Array<{ ast: any; unionOp?: string }> {
  const branches: Array<{ ast: any; unionOp?: string }> = [{ ast: root }];
  let node = root;
  while (node._next) {
    branches.push({ ast: node._next, unionOp: normalizeSetOp(node.set_op) });
    node = node._next;
  }
  return branches;
}

function withConditionSpan(node: ConditionNode, astNode: any): ConditionNode {
  const sourceSpan = toSourceSpan(astNode?.loc);
  return sourceSpan ? { ...node, sourceSpan } : node;
}

function normalizeJoinType(join: string | undefined): JoinType {
  if (!join) return 'INNER JOIN';
  const upper = join.toUpperCase().replace(/\s+/g, ' ').trim();
  if (upper.includes('LEFT')) return 'LEFT JOIN';
  if (upper.includes('RIGHT')) return 'RIGHT JOIN';
  if (upper.includes('FULL')) return 'FULL JOIN';
  if (upper.includes('CROSS')) return 'CROSS JOIN';
  if (upper === 'JOIN') return 'JOIN';
  return 'INNER JOIN';
}

function locStartOffset(node: any): number | null {
  const offset = node?.loc?.start?.offset;
  return typeof offset === 'number' ? offset : null;
}


/**
 * 前処理で取り除いた句は空白になって AST の範囲の外へ出る。
 * SELECT の終端を後続の空白ぶんだけ伸ばし、直後にあった句を取りこぼさないようにする
 */
function extendOverBlank(end: number): number {
  let i = end;
  while (i < processedSql.length && /\s/.test(processedSql[i]!)) i += 1;
  return i;
}

/** この SELECT が「自分のもの」として扱う前処理後オフセットの範囲判定 */
function selectRange(ast: any): { start: number; end: number } | null {
  const start = locStartOffset(ast);
  const end = ast?.loc?.end?.offset;
  if (start == null || typeof end !== 'number') return null;
  return { start, end: extendOverBlank(end) };
}

/**
 * 集合演算（UNION など）の全体の範囲。最初のブランチの始まりから、最後のブランチの終わりまで。
 * 最後のブランチの loc は後ろの空白まで伸びるので、取り除いた行制限句（全体に効くもの）もこの範囲に入る。
 * 入れ子の SELECT を外側の SELECT の範囲から除くのに使う。最初のブランチの範囲だけを除くと、
 * `(SELECT … UNION SELECT … FETCH FIRST 5 ROWS ONLY) d` の行制限句が外側の SELECT のものに見える
 */
function compoundSelectRange(ast: any): { start: number; end: number } | null {
  const range = selectRange(ast);
  if (!range) return null;
  let last = ast;
  while (last?._next) last = last._next;
  const lastRange = last === ast ? null : selectRange(last);
  let end = Math.max(range.end, lastRange?.end ?? range.end);
  // 括弧で囲んだ最後のブランチの後ろの行制限句（`(…) UNION (…) FETCH FIRST 3 ROWS ONLY`）も全体のもの
  const tail = last !== ast && last?.parentheses_symbol ? compoundTailRowLimit(last) : undefined;
  if (tail) end = Math.max(end, tail.processedPos + 1);
  return { start: range.start, end };
}

/** ast の内側にある別の SELECT（サブクエリ・CTE・UNION の後続ブランチ）の範囲 */
function descendantSelectRanges(ast: any): Array<{ start: number; end: number }> {
  const ranges: Array<{ start: number; end: number }> = [];
  const seen = new Set<unknown>();

  const walk = (node: any, isRoot: boolean): void => {
    if (!node || typeof node !== 'object') return;
    if (seen.has(node)) return;
    seen.add(node);

    if (Array.isArray(node)) {
      for (const item of node) walk(item, false);
      return;
    }

    if (!isRoot && node.type === 'select') {
      const inner = compoundSelectRange(node);
      if (inner) ranges.push(inner);
      // 入れ子の内側はこの範囲に含まれるので、これ以上下りる必要はない
      return;
    }

    for (const [key, value] of Object.entries(node)) {
      if (key === 'loc') continue;
      walk(value, false);
    }
  };

  walk(ast, true);
  return ranges;
}

/**
 * 前処理で取り除いた句を、それが書かれていた SELECT に割り当てる。
 * 入れ子 SELECT の範囲に入るものは内側のものなので除く
 */
function recordsOwnedBySelect<T extends { processedPos: number }>(
  ast: any,
  records: T[],
): T[] {
  if (records.length === 0) return [];
  const range = selectRange(ast);
  if (!range) return [];
  const excluded = descendantSelectRanges(ast);
  return records.filter((record) => {
    const pos = record.processedPos;
    if (pos < range.start || pos >= range.end) return false;
    return !excluded.some((inner) => pos >= inner.start && pos < inner.end);
  });
}

function hierarchicalForAst(ast: any): HierarchicalQuery | undefined {
  const [clause] = recordsOwnedBySelect(ast, hierarchicalClauses);
  if (!clause) return undefined;
  return {
    startWith: clause.startWith,
    connectBy: clause.connectBy,
    noCycle: clause.noCycle || undefined,
    sourceSpan: clause.sourceSpan,
    startWithSpan: clause.startWithSpan,
    connectBySpan: clause.connectBySpan,
  };
}

function hintsForAst(ast: any): OptimizerHint[] | undefined {
  const owned = recordsOwnedBySelect(ast, optimizerHints);
  if (owned.length === 0) return undefined;
  return owned.map((hint) => ({ text: hint.text, sourceSpan: hint.sourceSpan }));
}

interface RowLimitFields {
  limit?: string;
  limitSpan?: SourceSpan;
  offset?: string;
  offsetSpan?: SourceSpan;
  rowLimitPercent?: boolean;
  rowLimitWithTies?: boolean;
  rowLimitSpan?: SourceSpan;
}

function rowLimitForAst(ast: any): RowLimitFields {
  const [limit] = recordsOwnedBySelect(ast, rowLimits);
  return rowLimitFields(limit);
}

function rowLimitFields(limit: RowLimitInfo | undefined): RowLimitFields {
  if (!limit) return {};
  return {
    limit: limit.count,
    limitSpan: limit.countSpan,
    offset: limit.offset,
    offsetSpan: limit.offsetSpan,
    rowLimitPercent: limit.percent || undefined,
    rowLimitWithTies: limit.withTies || undefined,
    rowLimitSpan: limit.sourceSpan,
  };
}

/** ORDER BY エントリの直後にあった NULLS FIRST / LAST を拾う */
function nullsOrderFor(entry: any): NullsOrderInfo | undefined {
  const end = entry?.expr?.loc?.end?.offset;
  if (typeof end !== 'number' || nullsOrders.length === 0) return undefined;
  return nullsOrders.find((info) => {
    if (info.processedPos < end) return false;
    const between = processedSql.slice(end, info.processedPos);
    return /^[\s]*(?:ASC|DESC)?[\s]*$/i.test(between);
  });
}

/** JOIN 種別の表示用文字列（NATURAL JOIN・旧式外部結合に対応） */
export function formatJoinDisplayType(
  join: Pick<JoinEdge, 'type' | 'isNatural' | 'fromWhereClause' | 'isOuterJoinOperator'>,
): string {
  if (join.isNatural) {
    const base = join.type === 'JOIN' ? 'INNER JOIN' : join.type;
    return `NATURAL ${base}`;
  }
  // FROM 句ではなく WHERE 句に結合条件が書かれていることを図の上でも分かるようにする
  if (join.isOuterJoinOperator) return `${join.type}（(+)）`;
  if (join.fromWhereClause && join.type !== 'CROSS JOIN') return `${join.type}（WHERE）`;
  return join.type;
}

function fromEntryRegionEnd(entry: any): number {
  return entry?.on?.loc?.end?.offset ?? entry?.loc?.end?.offset ?? 0;
}

function fromEntryTableStart(entry: any): number | null {
  const offset = entry?.loc?.start?.offset;
  return typeof offset === 'number' ? offset : null;
}

/** 同一 FROM 内で、このテーブルを導入する最初の JOIN が NATURAL 由来か */
function isNaturalJoinEntry(entry: any, prevEntry: any | null): boolean {
  if (naturalJoinStarts.length === 0 || !processedSql) return false;
  const tableStart = fromEntryTableStart(entry);
  if (tableStart == null) return false;

  const regionStart = prevEntry ? fromEntryRegionEnd(prevEntry) : 0;
  if (tableStart <= regionStart) return false;

  const slice = processedSql.slice(regionStart, tableStart);
  const re = /\b(?:INNER|LEFT|RIGHT|FULL|CROSS)\s+JOIN\b/gi;
  const first = re.exec(slice);
  if (!first) return false;

  return naturalJoinStarts.includes(regionStart + first.index);
}

function parseWithClause(withClauses: any[] | null | undefined): CteRef[] {
  if (!withClauses?.length) return [];

  return withClauses.map((entry) => {
    const name = entry.name?.value ?? String(entry.name ?? 'cte');
    const innerAst = entry.stmt?.ast;
    const query =
      innerAst?.type === 'select'
        ? buildNestedSelect(innerAst)
        : buildSelectParsed({ type: 'select', columns: ['*'], from: [] });
    return {
      name,
      query,
      sourceSpan: toSourceSpan(entry.loc),
    };
  });
}

function attachCteDefinitions(tables: TableRef[], ctes: CteRef[]): TableRef[] {
  if (!ctes.length) return tables;

  const byName = new Map(ctes.map((c) => [c.name, c]));
  return tables.map((table) => {
    const cte = byName.get(table.table) ?? (table.alias ? byName.get(table.alias) : undefined);
    if (!cte) return table;

    return {
      ...table,
      isDerived: true,
      derivedQuery: cte.query,
      displayName: `${cte.name}（CTE）`,
      table: cte.name,
      alias: table.alias && table.alias !== table.table ? table.alias : cte.name,
    };
  });
}

function applyCtesToQuery(query: ParsedQuery, ctes: CteRef[]): ParsedQuery {
  if (!ctes.length) return query;
  return {
    ...query,
    ctes,
    tables: attachCteDefinitions(query.tables, ctes),
  };
}

/** オペランドの直後に旧式外部結合演算子 `(+)` が書かれていたか */
function hasOuterJoinMarkerAfter(operand: any): boolean {
  const end = operand?.loc?.end?.offset;
  if (typeof end !== 'number' || outerJoinMarkers.length === 0) return false;
  return outerJoinMarkers.some((marker) => {
    if (marker.processedPos < end) return false;
    return processedSql.slice(end, marker.processedPos).trim().length === 0;
  });
}

function outerJoinSideOf(node: any): 'left' | 'right' | undefined {
  if (hasOuterJoinMarkerAfter(node.right)) return 'right';
  if (hasOuterJoinMarkerAfter(node.left)) return 'left';
  return undefined;
}

function isRownumRef(node: any): boolean {
  return (
    node?.type === 'column_ref' &&
    !node.table &&
    formatIdentifier(node.column).toUpperCase() === 'ROWNUM'
  );
}

/** ROWNUM <= n のような行数制限条件か */
function isRownumComparison(node: any): boolean {
  return isRownumRef(node?.left) || isRownumRef(node?.right);
}

function parseComparison(node: any): ConditionNode {
  const left = exprToString(node.left);
  const right = exprToString(node.right);
  const outerJoinSide = outerJoinSideOf(node);
  const markerText = (side: 'left' | 'right') => (outerJoinSide === side ? '(+)' : '');
  return withConditionSpan(
    {
      id: nextId('cond'),
      type: 'comparison',
      label: `${left}${markerText('left')} ${node.operator} ${right}${markerText('right')}${formatEscapeClause(node)}`,
      operator: node.operator,
      left,
      right,
      ...(outerJoinSide ? { outerJoinSide } : {}),
      ...(isRownumComparison(node) ? { isRownum: true } : {}),
    },
    node,
  );
}

function parseComparisonWithSubquery(node: any): ConditionNode {
  const left = exprToString(node.left);
  const subAst = extractSubquerySelectAst(node.right);
  if (subAst) {
    return withConditionSpan(
      {
        id: nextId('cond'),
        type: 'subquery',
        label: `${left} ${node.operator} ${summarizeSelect(subAst)}`,
        operator: node.operator,
        left,
        nestedQuery: buildNestedSelect(subAst),
      },
      node,
    );
  }
  return parseComparison(node);
}

function parseConditionTree(node: any): ConditionNode | undefined {
  if (!node) return undefined;

  switch (node.type) {
    case 'binary_expr': {
      const op = node.operator?.toUpperCase?.() ?? node.operator;

      if (op === 'AND' || op === 'OR') {
        const children: ConditionNode[] = [];
        const left = parseConditionTree(node.left);
        const right = parseConditionTree(node.right);
        if (left) children.push(left);
        if (right) children.push(right);
        return withConditionSpan(
          {
            id: nextId('cond'),
            type: op === 'AND' ? 'and' : 'or',
            label: op,
            operator: op,
            children,
          },
          node,
        );
      }

      if (op === 'IS') {
        const left = exprToString(node.left);
        const right = exprToString(node.right);
        return withConditionSpan(
          {
            id: nextId('cond'),
            type: 'is_null',
            label: `${left} IS ${right}`,
            left,
            right,
          },
          node,
        );
      }

      if (op === 'IN' || op === 'NOT IN') {
        const left = exprToString(node.left);
        const subAst = extractSubquerySelectAst(node.right);
        if (subAst) {
          return withConditionSpan(
            {
              id: nextId('cond'),
              type: 'in',
              label: `${left} ${node.operator} ${summarizeSelect(subAst)}`,
              operator: node.operator,
              left,
              nestedQuery: buildNestedSelect(subAst),
            },
            node,
          );
        }
        const values =
          node.right?.type === 'expr_list'
            ? toArray<any>(node.right.value).map((a: any) => exprToString(a)).join(', ')
            : exprToString(node.right);
        return withConditionSpan(
          {
            id: nextId('cond'),
            type: 'in',
            label: `${left} ${node.operator} (${values})`,
            operator: node.operator,
            left,
            right: values,
          },
          node,
        );
      }

      if (op === 'BETWEEN' || op === 'NOT BETWEEN') {
        const left = exprToString(node.left);
        const [low, high] =
          node.right?.type === 'expr_list'
            ? toArray<any>(node.right.value).map((a: any) => exprToString(a))
            : [exprToString(node.right), ''];
        return withConditionSpan(
          {
            id: nextId('cond'),
            type: 'between',
            label: `${left} ${node.operator} ${low} AND ${high}`,
            operator: node.operator,
            left,
            right: `${low} AND ${high}`,
          },
          node,
        );
      }

      return parseComparisonWithSubquery(node);
    }

    case 'subquery': {
      const subAst = extractSubquerySelectAst(node);
      return withConditionSpan(
        {
          id: nextId('cond'),
          type: 'subquery',
          label: summarizeSelect(subAst ?? node),
          nestedQuery: subAst ? buildNestedSelect(subAst) : undefined,
        },
        node,
      );
    }

    case 'unary_expr': {
      const op = (node.operator?.toUpperCase?.() ?? node.operator ?? '').replace(/\s+/g, ' ').trim();

      if (op === 'NOT EXISTS' || op === 'EXISTS') {
        const subAst = extractSubquerySelectAst(node.expr);
        return withConditionSpan(
          {
            id: nextId('cond'),
            type: 'exists',
            label: subAst ? `${op} ${summarizeSelect(subAst)}` : `${op} (subquery)`,
            nestedQuery: subAst ? buildNestedSelect(subAst) : undefined,
          },
          node,
        );
      }

      if (op === 'NOT') {
        const child = parseConditionTree(node.expr);
        return withConditionSpan(
          {
            id: nextId('cond'),
            type: 'not',
            label: 'NOT',
            operator: 'NOT',
            children: child ? [child] : [],
          },
          node,
        );
      }
      return withConditionSpan(
        {
          id: nextId('cond'),
          type: 'raw',
          label: exprToString(node),
        },
        node,
      );
    }

    case 'function': {
      const name = resolveFunctionName(node.name);
      const args = extractFunctionArgs(node);

      if (name === 'NOT') {
        const child = args[0] ? parseConditionTree(args[0]) : undefined;
        return withConditionSpan(
          {
            id: nextId('cond'),
            type: 'not',
            label: 'NOT',
            operator: 'NOT',
            children: child ? [child] : [],
          },
          node,
        );
      }

      if (name === 'IN') {
        const left = exprToString(args[0]);
        const values = args.slice(1).map((a: any) => exprToString(a)).join(', ');
        return withConditionSpan(
          {
            id: nextId('cond'),
            type: 'in',
            label: `${left} IN (${values})`,
            left,
            right: values,
          },
          node,
        );
      }

      if (name === 'EXISTS') {
        const subAst = extractSubquerySelectAst(args[0]);
        return withConditionSpan(
          {
            id: nextId('cond'),
            type: 'exists',
            label: subAst ? `EXISTS ${summarizeSelect(subAst)}` : 'EXISTS (subquery)',
            nestedQuery: subAst ? buildNestedSelect(subAst) : undefined,
          },
          node,
        );
      }

      if (name === 'BETWEEN') {
        const expr = exprToString(args[0]);
        const low = exprToString(args[1]);
        const high = exprToString(args[2]);
        return withConditionSpan(
          {
            id: nextId('cond'),
            type: 'between',
            label: `${expr} BETWEEN ${low} AND ${high}`,
            left: expr,
            right: `${low} AND ${high}`,
          },
          node,
        );
      }

      return withConditionSpan(
        {
          id: nextId('cond'),
          type: 'function',
          label: exprToString(node),
        },
        node,
      );
    }

    default:
      return withConditionSpan(
        {
          id: nextId('cond'),
          type: 'raw',
          label: exprToString(node),
        },
        node,
      );
  }
}

function enrichConditionTree(node: ConditionNode): ConditionNode {
  let enriched: ConditionNode = node;
  if (node.type === 'comparison' && node.operator?.toUpperCase() === 'LIKE') {
    enriched = { ...node, type: 'like' };
  }
  if (enriched.children?.length) {
    enriched = { ...enriched, children: enriched.children.map(enrichConditionTree) };
  }
  return normalizeConditionTree(enriched);
}

function parseColumns(columns: any[]): SelectColumn[] {
  if (!columns || columns.length === 0) return [{ expression: '*' }];

  return columns.map((col) => {
    if (col === '*' || col.expr?.type === 'star') {
      const sourceSpan = toSourceSpan(col.expr?.loc ?? col.loc);
      return {
        expression: col.expr?.table ? `${col.expr.table}.*` : '*',
        sourceSpan,
      };
    }
    const expr = col.expr ? exprToString(col.expr) : exprToString(col);
    const alias = col.as ?? col.alias;
    const sourceSpan = columnEntrySourceSpan(col);
    return { expression: expr, alias: alias || undefined, sourceSpan };
  });
}

/** 前処理後の SQL の、文字列・コメント・引用識別子を伏せたもの。列の範囲を補うときに使う */
function maskedProcessedSql(): string {
  if (maskedProcessedFor !== processedSql) {
    // 前処理で引用識別子を `…` にしているので、その中も伏せる
    maskedProcessed = maskNonCode(processedSql).replace(/`[^`]*`/g, (quoted) => ' '.repeat(quoted.length));
    maskedProcessedFor = processedSql;
  }
  return maskedProcessed;
}

function keywordAt(masked: string, pos: number, keyword: string): boolean {
  if (masked.slice(pos, pos + keyword.length).toUpperCase() !== keyword) return false;
  return !/[\w$#.]/.test(masked[pos - 1] ?? '') && !/[\w$#]/.test(masked[pos + keyword.length] ?? '');
}

/**
 * パーサが位置（loc）を返さない列（CASE 式・文字列や数値・NULL など）の範囲を補う。
 * 範囲が無いと、その列をクリックしても、エディタのカーソルを置いても、SQL と連動しない。
 * SELECT の範囲の中で、括弧の深さ 0 の SELECT から FROM までを、深さ 0 のカンマで区切る
 * （WITH の定義やサブクエリは括弧の中にあるので数えない）。
 * 区切った数が列の数と合わないときは補わない
 */
function fillMissingColumnSpans(columns: SelectColumn[], ast: any): SelectColumn[] {
  if (columns.every((column) => column.sourceSpan)) return columns;
  const astStart = ast?.loc?.start?.offset;
  const astEnd = ast?.loc?.end?.offset;
  if (typeof astStart !== 'number' || typeof astEnd !== 'number') return columns;
  const masked = maskedProcessedSql();

  let listStart: number | undefined;
  let listEnd: number | undefined;
  const commas: number[] = [];
  let depth = 0;
  for (let i = astStart; i < astEnd; i++) {
    const ch = masked[i]!;
    if (ch === '(') depth += 1;
    else if (ch === ')') depth -= 1;
    if (depth !== 0) continue;
    if (listStart === undefined) {
      if (keywordAt(masked, i, 'SELECT')) {
        listStart = i + 'SELECT'.length;
        const modifier = /^\s*(?:DISTINCT|UNIQUE|ALL)\b/i.exec(masked.slice(listStart, astEnd));
        if (modifier) listStart += modifier[0].length;
        i = listStart - 1;
      }
    } else if (ch === ',') {
      commas.push(i);
    } else if (keywordAt(masked, i, 'FROM')) {
      listEnd = i;
      break;
    }
  }
  if (listStart === undefined || listEnd === undefined) return columns;

  const bounds = [listStart, ...commas, listEnd];
  if (bounds.length - 1 !== columns.length) return columns;
  return columns.map((column, index) => {
    if (column.sourceSpan) return column;
    let start = index === 0 ? bounds[0]! : bounds[index]! + 1;
    let end = bounds[index + 1]!;
    // 文字列の中も伏せてあるので、空白かどうかは前処理後の SQL の文字で見る。
    // 範囲の後ろのコメントは trimParsedQuerySpanEnds が除く
    for (;;) {
      while (start < end && /\s/.test(processedSql[start]!)) start += 1;
      const comment = /^(?:--[^\n]*|\/\*[\s\S]*?\*\/)/.exec(processedSql.slice(start, end));
      if (!comment) break;
      start += comment[0].length;
    }
    while (end > start && /\s/.test(processedSql[end - 1]!)) end -= 1;
    return end > start ? { ...column, sourceSpan: { start, end } } : column;
  });
}

/**
 * インラインビューの範囲（`(SELECT …) v`）。パーサは FROM の項目としての位置を返さないので、
 * 中の SELECT の範囲から、囲む括弧と後ろの別名まで広げる。範囲が無いと、JOIN 図のノードや
 * 作用の説明の行をクリックしても、SQL と連動しない
 */
function derivedTableSourceSpan(inner: SourceSpan | undefined, alias: string | undefined): SourceSpan | undefined {
  if (!inner) return undefined;
  const masked = maskedProcessedSql();
  let open = inner.start - 1;
  while (open >= 0 && /\s/.test(masked[open]!)) open -= 1;
  if (masked[open] !== '(') return inner;
  const close = readBalancedParenEnd(masked, open);
  if (close == null) return inner;
  if (!alias) return { start: open, end: close };
  // 括弧と別名のあいだの空白・コメント・AS を飛ばす（伏せた SQL では、コメントは空白になっている）
  let pos = close;
  const skipBlank = () => {
    while (pos < masked.length && /\s/.test(masked[pos]!) && processedSql[pos] !== '`') pos += 1;
  };
  skipBlank();
  const as = /^AS(?![\w$#])/i.exec(masked.slice(pos));
  if (as) {
    pos += as[0].length;
    skipBlank();
  }
  const name = /^(?:`[^`]*`|[^\s,()]+)/.exec(processedSql.slice(pos));
  return { start: open, end: name ? pos + name[0].length : close };
}

const PARENTHESIZED_JOIN_MESSAGE =
  '括弧でまとめた JOIN（例: a LEFT JOIN (b JOIN c ON …) ON …）には対応していません';

function buildTableRef(entry: any, index: number): TableRef {
  const sourceSpan = toSourceSpan(entry.loc);

  // `a LEFT JOIN (b JOIN c ON …) ON …` は括弧の中が配列で来る。
  // 1 つのテーブルとして読むと b と c が図から消え、`table_1` という実在しない名前が出る
  if (Array.isArray(entry.expr)) throw new Error(PARENTHESIZED_JOIN_MESSAGE);

  // Oracle の DUAL は 1 行 1 列のダミー表。パーサは table 名を持たない特別なノードを返す
  if (entry.type === 'dual') {
    return {
      id: nextId('tbl'),
      table: 'dual',
      displayName: 'dual（1行のダミー表）',
      sourceSpan,
    };
  }

  if (entry.expr?.ast?.type === 'select') {
    // Oracle はインラインビューに別名を付けなくてよい（`SELECT * FROM (SELECT …) WHERE ROWNUM <= 10`）。
    // 別名が無いときは、画面で読める名前を付ける。内部の仮の名前（derived_0）は SQL にも画面にも無い語になる
    // 別名が無いときは別名を持たせない。SQL に無い別名を JOIN 図や別名のツールチップに出さないため
    const givenAlias = entry.as ?? entry.alias;
    const name = givenAlias ?? `派生テーブル${index + 1}`;
    const derivedQuery = buildNestedSelect(entry.expr.ast);
    const span = toSourceSpan(entry.expr?.loc) ?? derivedQuery.sourceSpan;
    return {
      id: nextId('tbl'),
      table: name,
      alias: givenAlias,
      displayName: givenAlias ? `${name}（派生テーブル）` : `${name}（別名なし）`,
      isDerived: true,
      derivedQuery: span ? { ...derivedQuery, sourceSpan: span } : derivedQuery,
      sourceSpan: sourceSpan ?? derivedTableSourceSpan(span, givenAlias),
    };
  }

  const table = entry.table ?? entry.name ?? `table_${index}`;
  const schema = entry.db ?? entry.schema;
  const alias = entry.as ?? entry.alias;
  const displayName = alias || formatTableName(schema, table);
  return {
    id: nextId('tbl'),
    schema: schema || undefined,
    table,
    alias: alias || undefined,
    displayName,
    sourceSpan,
  };
}

function parseJoinCondition(on: any): {
  condition: string;
  parts?: { left: string; operator: string; right: string };
  conditionRoot?: ConditionNode;
} {
  if (!on) return { condition: NO_JOIN_CONDITION };

  let conditionRoot = parseConditionTree(on);
  if (conditionRoot) conditionRoot = enrichConditionTree(conditionRoot);
  const condition = conditionRoot ? formatJoinConditionLabel(conditionRoot) : exprToString(on);

  if (on.type === 'binary_expr' && on.operator === '=') {
    return {
      condition,
      conditionRoot,
      parts: {
        left: exprToString(on.left),
        operator: '=',
        right: exprToString(on.right),
      },
    };
  }

  return { condition, conditionRoot };
}

function tableJoinQualifier(table: TableRef): string {
  return table.alias ?? table.table;
}

function parseUsingColumnName(entry: unknown): string {
  if (typeof entry === 'string') return entry;
  if (entry && typeof entry === 'object') {
    const value = (entry as { value?: unknown; column?: unknown }).value
      ?? (entry as { column?: unknown }).column;
    if (typeof value === 'string') return value;
  }
  return '';
}

function formatUsingClause(columns: string[]): string {
  return `USING (${columns.join(', ')})`;
}

function buildUsingComparison(
  column: string,
  source: TableRef,
  target: TableRef,
): ConditionNode {
  const left = `${tableJoinQualifier(source)}.${column}`;
  const right = `${tableJoinQualifier(target)}.${column}`;
  return {
    id: nextId('cond'),
    type: 'comparison',
    label: `${left} = ${right}`,
    operator: '=',
    left,
    right,
  };
}

function parseUsingJoinCondition(
  using: unknown[],
  source: TableRef,
  target: TableRef,
): {
  condition: string;
  parts?: { left: string; operator: string; right: string };
  conditionRoot?: ConditionNode;
} {
  const columns = using.map(parseUsingColumnName).filter(Boolean);
  if (columns.length === 0) return { condition: NO_JOIN_CONDITION };

  const comparisons = columns.map((col) => buildUsingComparison(col, source, target));
  const conditionRoot = enrichConditionTree(
    comparisons.length === 1
      ? comparisons[0]!
      : {
          id: nextId('cond'),
          type: 'and',
          label: 'AND',
          operator: 'AND',
          children: comparisons,
        },
  );

  const first = comparisons[0]!;
  const parts =
    comparisons.length === 1
      ? { left: first.left!, operator: '=', right: first.right! }
      : undefined;

  return {
    condition: formatUsingClause(columns),
    conditionRoot,
    parts,
  };
}

function parseJoinConditionFromEntry(
  entry: any,
  source: TableRef,
  target: TableRef,
): ReturnType<typeof parseJoinCondition> {
  const using = toArray(entry?.using);
  if (using.length > 0) {
    return parseUsingJoinCondition(using, source, target);
  }
  return parseJoinCondition(entry.on);
}

interface FromClauseResult {
  tables: TableRef[];
  joins: JoinEdge[];
  /** カンマ結合で並べられたテーブル（結合条件は WHERE 句にある） */
  commaJoinedIndexes: number[];
}

function parseFromClause(from: any[]): FromClauseResult {
  const tables: TableRef[] = [];
  const joins: JoinEdge[] = [];
  const commaJoinedIndexes: number[] = [];

  // `FROM (a JOIN b ON …)` のように FROM 句全体を括弧で囲むと、配列ではなく 1 つのオブジェクトで来る
  if (from && !Array.isArray(from)) throw new Error(PARENTHESIZED_JOIN_MESSAGE);
  if (!from || from.length === 0) return { tables, joins, commaJoinedIndexes };

  from.forEach((entry, index) => {
    const tableRef = buildTableRef(entry, index);
    tables.push(tableRef);

    if (index === 0) return;

    // JOIN キーワードが無い＝カンマ結合。結合条件は WHERE 句にあるので後段で組み立てる
    if (!entry.join) {
      commaJoinedIndexes.push(index);
      return;
    }

    const joinType = normalizeJoinType(entry.join);
    const prevTable = tables[index - 1]!;
    const prevEntry = from[index - 1];
    const isNatural = isNaturalJoinEntry(entry, prevEntry);
    let { condition, parts, conditionRoot } = parseJoinConditionFromEntry(entry, prevTable, tableRef);

    if (isNatural && condition === NO_JOIN_CONDITION) {
      condition = 'NATURAL JOIN';
    }

    joins.push({
      id: nextId('join'),
      type: joinType,
      sourceId: prevTable.id,
      targetId: tableRef.id,
      condition,
      conditionParts: parts,
      conditionRoot,
      isNatural: isNatural || undefined,
      sourceSpan: toSourceSpan(entry.on?.loc ?? entry.loc),
    });
  });

  return { tables, joins, commaJoinedIndexes };
}

// ---------------------------------------------------------------------------
// カンマ結合 + WHERE 句の結合条件（Oracle の旧式結合）を JOIN として組み立てる
// ---------------------------------------------------------------------------

function tableQualifierKey(table: TableRef): string {
  return (table.alias ?? table.table).toUpperCase();
}

/** `e.deptno` のような修飾付き参照から、対応するテーブルの添字を引く */
function tableIndexOfExpression(expression: string | undefined, tables: TableRef[]): number {
  if (!expression) return -1;
  const qualifier = expression.split('.')[0]?.trim().toUpperCase();
  if (!qualifier || qualifier === expression.trim().toUpperCase()) return -1;
  return tables.findIndex((table) => tableQualifierKey(table) === qualifier);
}

/** AND で連結された最上位の条件だけを集める（OR の下は結合条件として扱わない） */
function collectAndedConditions(node: ConditionNode | undefined, out: ConditionNode[] = []): ConditionNode[] {
  if (!node) return out;
  if (node.type === 'and') {
    for (const child of node.children ?? []) collectAndedConditions(child, out);
    return out;
  }
  out.push(node);
  return out;
}

interface DerivedJoinGroup {
  sourceIndex: number;
  targetIndex: number;
  nodes: ConditionNode[];
  /** 行が補われる側（(+) が付いた側） */
  optionalSide?: 'source' | 'target';
}

function groupJoinConditions(
  conditions: ConditionNode[],
  tables: TableRef[],
  eligible: Set<number>,
): DerivedJoinGroup[] {
  const groups = new Map<string, DerivedJoinGroup>();

  for (const node of conditions) {
    if (node.type !== 'comparison' && node.type !== 'like') continue;
    const leftIndex = tableIndexOfExpression(node.left, tables);
    const rightIndex = tableIndexOfExpression(node.right, tables);
    if (leftIndex < 0 || rightIndex < 0 || leftIndex === rightIndex) continue;
    if (!eligible.has(leftIndex) && !eligible.has(rightIndex)) continue;

    const sourceIndex = Math.min(leftIndex, rightIndex);
    const targetIndex = Math.max(leftIndex, rightIndex);
    const key = `${sourceIndex}-${targetIndex}`;
    const group = groups.get(key) ?? { sourceIndex, targetIndex, nodes: [] };
    group.nodes.push(node);

    if (node.outerJoinSide) {
      const markedIndex = node.outerJoinSide === 'left' ? leftIndex : rightIndex;
      group.optionalSide = markedIndex === sourceIndex ? 'source' : 'target';
    }
    groups.set(key, group);
  }

  return [...groups.values()].sort((a, b) => a.targetIndex - b.targetIndex || a.sourceIndex - b.sourceIndex);
}

/**
 * `b.fiscal_year(+) = 2024` のような (+) 付きの片側条件を、その表を補われる側に持つ結合へ足す。
 * Oracle はこれを結合条件の一部として扱う（ANSI の `ON … AND b.fiscal_year = 2024` 相当）ので、
 * 行の絞り込みではなく結合条件として見せる
 */
function attachOuterJoinFilters(
  conditions: ConditionNode[],
  tables: TableRef[],
  groups: DerivedJoinGroup[],
): void {
  if (groups.length === 0) return;

  for (const node of conditions) {
    if (!node.outerJoinSide) continue;
    if (node.type !== 'comparison' && node.type !== 'like') continue;

    const leftIndex = tableIndexOfExpression(node.left, tables);
    const rightIndex = tableIndexOfExpression(node.right, tables);
    // 両辺が表を指すものは結合条件として groupJoinConditions が既に取り込んでいる
    if (leftIndex >= 0 && rightIndex >= 0) continue;

    const markedIndex = node.outerJoinSide === 'left' ? leftIndex : rightIndex;
    if (markedIndex < 0) continue;

    const group = groups.find(
      (g) =>
        (g.optionalSide === 'source' && g.sourceIndex === markedIndex) ||
        (g.optionalSide === 'target' && g.targetIndex === markedIndex),
    );
    if (group) group.nodes.push(node);
  }
}

function combineConditionNodes(nodes: ConditionNode[]): ConditionNode {
  if (nodes.length === 1) return nodes[0]!;
  return {
    id: nextId('cond'),
    type: 'and',
    label: 'AND',
    operator: 'AND',
    children: nodes,
  };
}

/**
 * カンマ結合されたテーブルについて、WHERE 句の結合条件から JOIN 辺を作る。
 * `(+)` が付いた側が「行を補われる側」なので、外部結合の向きはそこから決まる
 */
function deriveJoinsFromWhere(
  tables: TableRef[],
  commaJoinedIndexes: number[],
  where: ConditionNode | undefined,
): JoinEdge[] {
  if (commaJoinedIndexes.length === 0) return [];

  const eligible = new Set(commaJoinedIndexes);
  const conditions = collectAndedConditions(where);
  const groups = groupJoinConditions(conditions, tables, eligible);
  attachOuterJoinFilters(conditions, tables, groups);
  const joins: JoinEdge[] = [];
  const connected = new Set<number>();

  for (const group of groups) {
    const source = tables[group.sourceIndex]!;
    const target = tables[group.targetIndex]!;
    const conditionRoot = combineConditionNodes(group.nodes);
    const first = group.nodes[0]!;
    const type: JoinType =
      group.optionalSide === 'target'
        ? 'LEFT JOIN'
        : group.optionalSide === 'source'
          ? 'RIGHT JOIN'
          : 'INNER JOIN';

    joins.push({
      id: nextId('join'),
      type,
      sourceId: source.id,
      targetId: target.id,
      condition: formatJoinConditionLabel(conditionRoot),
      conditionParts:
        group.nodes.length === 1 && first.left && first.right && first.operator
          ? { left: first.left, operator: first.operator, right: first.right }
          : undefined,
      conditionRoot,
      fromWhereClause: true,
      isOuterJoinOperator: group.optionalSide ? true : undefined,
      sourceSpan: first.sourceSpan,
    });
    connected.add(group.sourceIndex);
    connected.add(group.targetIndex);
  }

  // 条件で結ばれなかったカンマ結合は直積。直前のテーブルへ CROSS JOIN として繋ぐ
  for (const index of commaJoinedIndexes) {
    if (connected.has(index)) continue;
    const target = tables[index]!;
    const source = tables[index - 1]!;
    joins.push({
      id: nextId('join'),
      type: 'CROSS JOIN',
      sourceId: source.id,
      targetId: target.id,
      condition: NO_JOIN_CONDITION,
      fromWhereClause: true,
    });
  }

  return joins;
}

/** 1 本の SELECT（UNION の 1 ブランチ）を解析する。UNION と WITH は呼び出し側が扱う */
function buildSelectParsed(ast: any): ParsedQuery {
  return collectEmbeddedSubqueries(() => buildSelectParsedCore(ast));
}

function buildSelectParsedCore(ast: any): ParsedQuery {
  const { tables, joins, commaJoinedIndexes } = parseFromClause(ast.from);

  let where = parseConditionTree(ast.where);
  if (where) where = enrichConditionTree(where);

  let having = parseConditionTree(ast.having);
  if (having) having = enrichConditionTree(having);

  const derivedJoins = deriveJoinsFromWhere(tables, commaJoinedIndexes, where);

  const groupBy: SqlFragment[] = toArray<any>(ast.groupby?.columns ?? ast.groupby).map((g: any) => ({
    text: exprToString(g),
    sourceSpan: toSourceSpan(g.loc),
  }));

  const orderBy = parseOrderByEntries(ast.orderby);

  const hints = hintsForAst(ast);

  return {
    rawSql: '',
    sourceSpan: toSourceSpan(ast?.loc),
    statementType: 'SELECT',
    tables,
    joins: [...joins, ...derivedJoins],
    where,
    having,
    columns: fillMissingColumnSpans(parseColumns(ast.columns), ast),
    groupBy,
    orderBy,
    ...rowLimitForAst(ast),
    distinct: Boolean(ast.distinct),
    hints,
    hintSpan: hints?.[0]?.sourceSpan,
    hierarchical: hierarchicalForAst(ast),
  };
}

function parseOrderByEntries(entries: any): SqlFragment[] {
  return toArray<any>(entries).map((o: any) => {
    const nulls = nullsOrderFor(o);
    const span = orderByEntrySourceSpan(o, processedSql);
    // NULLS FIRST / LAST は前処理で空白に置き換わり、AST の範囲の外にある。項目の範囲はその終わりまで延ばす
    const nullsEnd = nulls ? nulls.processedPos + nulls.processedLength : undefined;
    return {
      text: `${exprToString(o.expr)}${o.type ? ` ${o.type}` : ''}${nulls ? ` NULLS ${nulls.position}` : ''}`,
      sourceSpan:
        span && nullsEnd !== undefined && nullsEnd > span.end ? { start: span.start, end: nullsEnd } : span,
    };
  });
}

/**
 * `(SELECT …) UNION (SELECT …) ORDER BY 1 FETCH FIRST 3 ROWS ONLY` のように、括弧で囲んだ最後のブランチの
 * 後ろに書いた行制限句。前処理で取り除いた位置が、最後のブランチの閉じ括弧の外（集合演算の全体）にあるものを返す。
 * 閉じ括弧の数で見るのは、派生テーブルの外（`(… UNION (…)) d FETCH …`）の行制限句と区別するため
 */
function compoundTailRowLimit(lastAst: any): RowLimitInfo | undefined {
  const lastEnd = lastAst?.loc?.end?.offset;
  if (typeof lastEnd !== 'number') return undefined;
  return rowLimits.find((record) => {
    if (record.processedPos < lastEnd) return false;
    const between = maskNonCode(processedSql.slice(lastEnd, record.processedPos));
    if (between.includes(';')) return false;
    const closes = (between.match(/\)/g) ?? []).length;
    const opens = (between.match(/\(/g) ?? []).length;
    return closes - opens === 1;
  });
}

/**
 * 入れ子の SELECT（派生テーブル・CTE の本体・サブクエリ）を解析する。
 * buildSelectParsed だけだと 2 本目以降の UNION ブランチと WITH 句を捨ててしまうので、
 * 最上位と同じ手順で組み立てる
 */
function buildNestedSelect(ast: any): ParsedQuery {
  return parseSelectQuery(ast, '');
}

function parseSelectQuery(ast: any, rawSql: string): ParsedQuery {
  const ctes = parseWithClause(ast.with);
  const branches = collectUnionBranches(ast);
  let main = applyCtesToQuery(buildSelectParsed(branches[0].ast), ctes);
  main.rawSql = rawSql;

  if (branches.length > 1) {
    // 最初のブランチに付いた ORDER BY / 行制限句（`(SELECT … FETCH FIRST 1 ROWS ONLY) UNION …`）は、
    // そのブランチだけのもの。文全体の並び順と行数は、下で最後のブランチの後ろから拾う
    main = {
      ...main,
      orderBy: [],
      limit: undefined,
      limitSpan: undefined,
      offset: undefined,
      offsetSpan: undefined,
      rowLimitPercent: undefined,
      rowLimitWithTies: undefined,
      rowLimitSpan: undefined,
    };
    // Oracle では、括弧の無い最後のブランチの後ろの ORDER BY / 行制限句は集合演算の結果全体に効く。
    // パーサは最後のブランチに載せるので、文レベルへ引き上げ、そのブランチからは外す。
    // 外さないと、作用説明でそのブランチだけが「最大 3 行」のように絞られて見える。
    // 括弧で囲んだ最後のブランチの ORDER BY / 行制限句は、そのブランチだけに効く
    const lastAst = branches[branches.length - 1]!.ast;
    const last = lastAst?.parentheses_symbol ? null : buildSelectParsed(lastAst);
    // 括弧で囲んだブランチの後ろの ORDER BY は、パーサーが先頭の AST の _orderby に入れる
    if (lastAst?.parentheses_symbol) {
      if (ast._orderby && main.orderBy.length === 0) main.orderBy = parseOrderByEntries(ast._orderby);
      const tail = compoundTailRowLimit(lastAst);
      if (tail && main.limit == null && main.offset == null) Object.assign(main, rowLimitFields(tail));
    }
    if (last && main.orderBy.length === 0 && last.orderBy.length > 0) main.orderBy = last.orderBy;
    if (last && main.limit == null && main.offset == null && (last.limit != null || last.offset != null)) {
      main.limit = last.limit;
      main.limitSpan = last.limitSpan;
      main.offset = last.offset;
      main.offsetSpan = last.offsetSpan;
      main.rowLimitPercent = last.rowLimitPercent;
      main.rowLimitWithTies = last.rowLimitWithTies;
      main.rowLimitSpan = last.rowLimitSpan;
    }

    main.unionBranches = branches.map((branch, index) => {
      let branchQuery = applyCtesToQuery(buildSelectParsed(branch.ast), ctes);
      if (last && branch.ast === lastAst) {
        branchQuery = {
          ...branchQuery,
          orderBy: [],
          limit: undefined,
          limitSpan: undefined,
          offset: undefined,
          offsetSpan: undefined,
          rowLimitPercent: undefined,
          rowLimitWithTies: undefined,
          rowLimitSpan: undefined,
        };
      }
      const sourceSpan = toSourceSpan(branch.ast?.loc);
      return {
        id: nextId('union'),
        operator: index === 0 ? undefined : branch.unionOp,
        sourceSpan,
        query: {
          ...branchQuery,
          rawSql: '',
          sourceSpan: sourceSpan ?? branchQuery.sourceSpan,
        },
      };
    });
  }

  return main;
}

/** SQL に書かれた集合演算子の数（maskNonCode 済みの SQL を渡す） */
function countSetOperatorKeywords(masked: string): number {
  return masked.match(/\b(?:UNION|MINUS|EXCEPT|INTERSECT)\b/gi)?.length ?? 0;
}

/** AST が持つ集合演算の数。サブクエリ・派生テーブル・CTE の中も数える */
function countSetOperatorsInAst(node: any, seen: Set<unknown> = new Set()): number {
  if (!node || typeof node !== 'object' || seen.has(node)) return 0;
  seen.add(node);
  let count = !Array.isArray(node) && node._next ? 1 : 0;
  for (const [key, value] of Object.entries(node)) {
    if (key !== 'loc') count += countSetOperatorsInAst(value, seen);
  }
  return count;
}

function parseSetClauses(set: any[]): SetClause[] {
  if (!set || set.length === 0) return [];

  return set.map((entry) => {
    const column = entry.column ?? '';
    const table = entry.table || undefined;
    const value = exprToString(entry.value);
    const qualified = table ? `${table}.${column}` : column;
    return {
      column,
      table,
      value,
      label: `${qualified} = ${value}`,
    };
  });
}

function parseUpdateAst(ast: any, rawSql: string): ParsedQuery {
  return collectEmbeddedSubqueries(() => parseUpdateAstCore(ast, rawSql));
}

function parseUpdateAstCore(ast: any, rawSql: string): ParsedQuery {
  const { tables, joins, commaJoinedIndexes } = parseFromClause(ast.table);

  let where = parseConditionTree(ast.where);
  if (where) where = enrichConditionTree(where);

  const derivedJoins = deriveJoinsFromWhere(tables, commaJoinedIndexes, where);
  const hints = hintsForAst(ast);

  return {
    rawSql,
    statementType: 'UPDATE',
    tables,
    joins: [...joins, ...derivedJoins],
    where,
    columns: [],
    setClauses: parseSetClauses(ast.set),
    groupBy: [],
    orderBy: [],
    distinct: false,
    hints,
    hintSpan: hints?.[0]?.sourceSpan,
    hierarchical: hierarchicalForAst(ast),
  };
}

function parseDeleteTargets(targets: any[], tables: TableRef[]): DeleteTarget[] {
  return toArray(targets).map((entry) => {
    // `DELETE FROM (SELECT …) WHERE …` の対象はインラインビュー。名前を持たないので、派生テーブルとして探す
    const derived = entry?.expr?.ast?.type === 'select';
    const matched = derived
      ? tables.find((t) => t.isDerived && (entry.as ? t.alias === entry.as : !t.alias))
      : tables.find((t) => t.alias === (entry.table ?? entry.as) || t.table === (entry.table ?? entry.as) || t.displayName === (entry.table ?? entry.as));
    const name = derived ? (matched?.table ?? '') : (entry.table ?? entry.as ?? '');
    const label = matched
      ? matched.alias
        ? `${matched.table} AS ${matched.alias}`
        : matched.schema
          ? `${matched.schema}.${matched.table}`
          : matched.table
      : name;
    return { name, label };
  });
}

function parseDeleteAst(ast: any, rawSql: string): ParsedQuery {
  return collectEmbeddedSubqueries(() => parseDeleteAstCore(ast, rawSql));
}

function parseDeleteAstCore(ast: any, rawSql: string): ParsedQuery {
  const { tables, joins, commaJoinedIndexes } = parseFromClause(ast.from);

  let where = parseConditionTree(ast.where);
  if (where) where = enrichConditionTree(where);

  const derivedJoins = deriveJoinsFromWhere(tables, commaJoinedIndexes, where);
  const hints = hintsForAst(ast);

  return {
    rawSql,
    statementType: 'DELETE',
    tables,
    joins: [...joins, ...derivedJoins],
    where,
    columns: [],
    deleteTargets: parseDeleteTargets(ast.table ?? ast.from, tables),
    groupBy: [],
    orderBy: [],
    distinct: false,
    hints,
    hintSpan: hints?.[0]?.sourceSpan,
    hierarchical: hierarchicalForAst(ast),
  };
}

/**
 * 解析できない Oracle 構文。素の構文エラーを見せても原因が分からないので、
 * 何が未対応なのかを日本語で返す
 */
const UNSUPPORTED_SYNTAX: Array<{ pattern: RegExp; message: string }> = [
  { pattern: /\bPIVOT\s*\(/i, message: 'PIVOT 句は未対応です' },
  { pattern: /\bUNPIVOT\s*(?:INCLUDE\s+NULLS\s*|EXCLUDE\s+NULLS\s*)?\(/i, message: 'UNPIVOT 句は未対応です' },
  { pattern: /\bGROUPING\s+SETS\s*\(/i, message: 'GROUP BY GROUPING SETS は未対応です' },
  { pattern: /\b(?:CROSS|OUTER)\s+APPLY\b/i, message: 'CROSS APPLY / OUTER APPLY は未対応です' },
  { pattern: /\bMODEL\s+(?:DIMENSION|PARTITION|MEASURES)\b/i, message: 'MODEL 句は未対応です' },
  { pattern: /\bMATCH_RECOGNIZE\s*\(/i, message: 'MATCH_RECOGNIZE は未対応です' },
  { pattern: /\bXMLTABLE\s*\(|\bJSON_TABLE\s*\(/i, message: 'XMLTABLE / JSON_TABLE は未対応です' },
  {
    pattern: /(?:\bFROM|\bJOIN|,)\s*TABLE\s*\(/i,
    message: 'FROM 句の TABLE(…)（コレクションや関数の結果を表として読む書き方）は未対応です',
  },
  {
    pattern: /\)\s*(?:SEARCH\s+(?:DEPTH|BREADTH)\s+FIRST\s+BY|CYCLE\s+[^;]*?\bSET\b)/i,
    message: '再帰的な WITH の SEARCH 句と CYCLE 句は未対応です',
  },
  {
    pattern: /\b(?:ROWS|RANGE)\s+(?:BETWEEN\s+)?INTERVAL\b|\bAND\s+INTERVAL\b[^)]*\b(?:PRECEDING|FOLLOWING)\b/i,
    message: 'ウィンドウ枠の境界に INTERVAL を書く形（RANGE INTERVAL … PRECEDING）は未対応です',
  },
  { pattern: /\bRETURNING\b[^;]*\bINTO\b/i, message: 'RETURNING … INTO 句は未対応です' },
];

/** 文の種類。SELECT / UPDATE / DELETE 以外は解析対象外として名前で返す */
const STATEMENT_KEYWORDS: Array<{ pattern: RegExp; label: string }> = [
  { pattern: /^\s*MERGE\b/i, label: 'MERGE' },
  { pattern: /^\s*INSERT\b/i, label: 'INSERT' },
  { pattern: /^\s*CREATE\b/i, label: 'CREATE' },
  { pattern: /^\s*ALTER\b/i, label: 'ALTER' },
  { pattern: /^\s*DROP\b/i, label: 'DROP' },
  { pattern: /^\s*TRUNCATE\b/i, label: 'TRUNCATE' },
  { pattern: /^\s*GRANT\b|^\s*REVOKE\b/i, label: '権限操作' },
  { pattern: /^\s*(?:DECLARE|BEGIN)\b/i, label: 'PL/SQL ブロック' },
  { pattern: /^\s*CALL\b|^\s*EXEC(?:UTE)?\b/i, label: 'プロシージャ呼び出し' },
];

/** 解析前に、未対応と分かっている構文をはっきりしたメッセージで弾く */
function detectUnsupportedSyntax(sql: string): string | null {
  const masked = maskNonCode(sql);

  for (const { pattern, label } of STATEMENT_KEYWORDS) {
    if (pattern.test(masked)) {
      return `現在 SELECT / UPDATE / DELETE 文のみ対応しています（検出: ${label}）`;
    }
  }
  for (const { pattern, message } of UNSUPPORTED_SYNTAX) {
    if (pattern.test(masked)) return message;
  }
  return null;
}

export function parseOracleQuery(sql: string): ParseResult {
  resetIds();

  const trimmed = sql.trim();
  if (!trimmed) {
    return { success: false, error: { message: 'SQLを入力してください' } };
  }

  const unsupported = detectUnsupportedSyntax(trimmed);
  if (unsupported) {
    return { success: false, error: { message: unsupported } };
  }

  // 位置（sourceSpan）は呼び出し元が渡した sql 上のオフセットで返す。
  // 解析は前後の空白を取り除いた文字列で行うので、先頭の空白の分だけ後ろへずらす。
  // ずらさないと、空行や字下げで始まる SQL でエディタの強調位置がその分だけ手前にずれる
  const leadingTrim = sql.length - sql.trimStart().length;
  /** 前処理後の SQL 上のオフセットと、入力 sql 上のオフセットの対応表。構文エラーの位置を戻すのに使う */
  let processedToInputForError: number[] | null = null;

  try {
    const preprocessResult = preprocessSqlForParser(trimmed);
    const preprocessed = preprocessResult.sql;
    const processedToOriginal = preprocessResult.processedToOriginal;
    processedToInputForError = processedToOriginal.map((offset) => offset + leadingTrim);
    renamedFunctions = preprocessResult.renamedFunctions;
    naturalJoinStarts = preprocessResult.naturalJoinStarts;
    outerJoinMarkers = preprocessResult.outerJoinMarkers;
    hierarchicalClauses = preprocessResult.hierarchicalClauses;
    rowLimits = preprocessResult.rowLimits;
    optimizerHints = preprocessResult.hints;
    nullsOrders = preprocessResult.nullsOrders;
    castTypes = preprocessResult.castTypes;
    aggregateClauses = preprocessResult.aggregateClauses;
    rangeFrameStarts = preprocessResult.rangeFrameStarts;
    processedSql = preprocessed;
    const ast = parser.astify(preprocessed, {
      database: 'MySQL',
      parseOptions: { includeLocations: true },
    });
    // パーサーは WHERE などの中で AND と OR を同じ優先順位で結び付けるので、Oracle の優先順位で組み直す
    fixLogicalOperatorPrecedence(ast);
    // 先頭 `;` などで astify が type を持たない空要素を返すことがある。文数に数えない
    const statements = (Array.isArray(ast) ? ast : [ast]).filter((statement) => statement?.type);
    const first = statements[0];

    if (!first) {
      return { success: false, error: { message: '解析できるSQLが見つかりません' } };
    }

    // 2 文目以降を黙って捨てると、貼り付けミスに気づけないまま 1 文目の解析結果を見てしまう
    if (statements.length > 1) {
      return {
        success: false,
        error: {
          message: `複数の文が含まれています（${statements.length} 文）。1 文ずつ入力してください`,
        },
      };
    }

    // 前後の空白を除いた SQL の座標へ戻し、入力 sql の座標へずらしてから、範囲の後ろの空白とコメントを除く
    const remap = (query: ParsedQuery) =>
      trimParsedQuerySpanEnds(
        shiftParsedQuerySpans(remapParsedQuerySpans(processedToOriginal, query, trimmed), leadingTrim),
        sql,
      );

    if (first.type === 'select') {
      // `SELECT … UNION (SELECT …)` は右側のブランチがエラーにならずに AST から消えるか、別の形に化ける。
      // サブクエリの中でも同じで、そのまま解析すると集合演算の無い SELECT として表示してしまう
      if (countSetOperatorKeywords(maskNonCode(preprocessed)) > countSetOperatorsInAst(first)) {
        return {
          success: false,
          error: {
            message:
              '集合演算（UNION / MINUS / INTERSECT）の一部のブランチを解析できませんでした。右側だけを括弧で囲む書き方（SELECT … UNION (SELECT …)）には対応していません。両側を括弧で囲むか、括弧を外してください',
          },
        };
      }
      const query = parseSelectQuery(first, sql);
      return outerJoinRestrictionResult(remap(query), sql);
    }

    if (first.type === 'update') {
      const query = parseUpdateAst(first, sql);
      return outerJoinRestrictionResult(remap(query), sql);
    }

    if (first.type === 'delete') {
      const query = parseDeleteAst(first, sql);
      return outerJoinRestrictionResult(remap(query), sql);
    }

    return {
      success: false,
      error: {
        message: `現在 SELECT / UPDATE / DELETE 文のみ対応しています（検出: ${first.type?.toUpperCase() ?? 'unknown'}）`,
      },
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : 'SQLの解析に失敗しました';
    const rawSpan = processedToInputForError
      ? syntaxErrorSpan(err, processedToInputForError, sql)
      : undefined;
    if (!rawSpan) {
      const reservedAlias = reservedAliasSpan(sql, message);
      return {
        success: false,
        error: {
          message: translateParserMessage(message),
          ...(reservedAlias ? { position: reservedAlias.start, span: reservedAlias } : {}),
        },
      };
    }
    const cause = likelySyntaxErrorCause(sql, rawSpan.start, syntaxErrorFound(message) === null);
    if (cause) {
      return {
        success: false,
        error: { message: cause.message, detail: message, position: cause.span.start, span: cause.span },
      };
    }
    // パーサーは 1 文字だけを指すので、語の途中で切れていたら語の終わりまで広げる（「ROW」を「R」とだけ示さない）
    const span = extendSpanToWordEnd(sql, rawSpan);
    const { line, column } = lineColumnAt(sql, span.start);
    const found = syntaxErrorFound(message);
    // 見つかった文字は、パーサーの文（前処理で書き換えたあとの SQL）からではなく、元の SQL のエラーの範囲から取る
    const foundText = sql.slice(span.start, span.end).trim();
    const summary =
      found === undefined
        ? `${line} 行 ${column} 列で構文を解釈できません（${message}）`
        : found === null
          ? `${line} 行 ${column} 列で構文を解釈できません（SQL が途中で終わっています）`
          : foundText
            ? `${line} 行 ${column} 列の「${foundText}」で構文を解釈できません`
            : `${line} 行 ${column} 列で構文を解釈できません`;
    return {
      success: false,
      error: {
        message: summary,
        ...(found === undefined ? {} : { detail: message }),
        position: span.start,
        span,
      },
    };
  }
}

const OUTER_JOIN_MARK_RE = /\(\s*\+\s*\)/;

/**
 * 旧式外部結合 (+) の制限に反する書き方をエラーにする（Oracle Database 23 SQL Language Reference「Joins」）。
 * - (+) を含む条件は、OR でほかの条件とつなげない
 * - (+) を付けた列を、IN で比べられない
 * そのまま解析すると、OR の下の結合条件を結合として拾えず、「直積」と説明してしまう
 */
function outerJoinRestrictionResult(query: ParsedQuery, sql: string): ParseResult {
  const masked = maskNonCode(sql);
  const errorAt = (start: number, end: number, message: string): ParseResult => {
    const at = lineColumnAt(sql, start);
    return { success: false, error: { message: `${at.line} 行 ${at.column} 列の${message}`, position: start, span: { start, end } } };
  };
  const inMatch = /\(\s*\+\s*\)\s*(?:NOT\s+)?IN\b/i.exec(masked);
  if (inMatch) {
    const mark = OUTER_JOIN_MARK_RE.exec(inMatch[0])!;
    return errorAt(inMatch.index, inMatch.index + mark[0].length, '「(+)」を付けた列は IN で比べられません。外部結合は LEFT JOIN … ON で書いてください');
  }
  const underOr = findOuterJoinUnderOr(query);
  if (underOr?.sourceSpan) {
    const inside = OUTER_JOIN_MARK_RE.exec(masked.slice(underOr.sourceSpan.start, underOr.sourceSpan.end));
    const start = underOr.sourceSpan.start + (inside?.index ?? 0);
    const end = inside ? start + inside[0].length : underOr.sourceSpan.end;
    return errorAt(start, end, '「(+)」を含む条件は OR でつなげません。外部結合は LEFT JOIN … ON で書いてください');
  }
  return { success: true, query };
}

/**
 * OR の下にある (+) 付きの条件。WHERE と HAVING の条件木を、派生テーブル・サブクエリ・UNION の中までたどる。
 * 結合の条件（JoinEdge）は WHERE の条件ノードを共有するので、たどらない（OR の下かどうかが分からなくなる）
 */
function findOuterJoinUnderOr(query: ParsedQuery): ConditionNode | undefined {
  const inCondition = (node: ConditionNode | undefined, underOr: boolean): ConditionNode | undefined => {
    if (!node) return undefined;
    if (underOr && node.outerJoinSide) return node;
    for (const child of node.children ?? []) {
      const hit = inCondition(child, underOr || node.type === 'or');
      if (hit) return hit;
    }
    // サブクエリは別の問い合わせなので、OR の下かどうかを数え直す
    return node.nestedQuery ? inQuery(node.nestedQuery) : undefined;
  };
  const inQuery = (q: ParsedQuery): ConditionNode | undefined =>
    inCondition(q.where, false) ??
    inCondition(q.having, false) ??
    q.tables.map((t) => (t.derivedQuery ? inQuery(t.derivedQuery) : undefined)).find(Boolean) ??
    q.unionBranches?.map((b) => inQuery(b.query)).find(Boolean) ??
    q.ctes?.map((c) => inQuery(c.query)).find(Boolean) ??
    q.embeddedSubqueries?.map(inQuery).find(Boolean);
  return inQuery(query);
}

/** span の始まりが語（識別子・キーワード）の文字なら、終わりを語の終わりまで広げる */
function extendSpanToWordEnd(sql: string, span: SourceSpan): SourceSpan {
  if (!isWordChar(sql[span.start])) return span;
  let end = Math.max(span.end, span.start);
  while (end < sql.length && isWordChar(sql[end])) end++;
  return end === span.end ? span : { start: span.start, end };
}

const RESERVED_ALIAS_MESSAGE_RE = /^Error: "(.+)" is a reserved word, can not as alias clause$/;

/** 予約語を別名にしたエラーは位置を持たないので、`AS 予約語` を元の SQL から探してエディタで示せるようにする */
function reservedAliasSpan(sql: string, message: string): SourceSpan | undefined {
  const reserved = RESERVED_ALIAS_MESSAGE_RE.exec(message);
  if (!reserved) return undefined;
  const word = reserved[1]!.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`\\bAS\\s+(${word})(?![\\w$#])`, 'i').exec(maskNonCode(sql));
  if (!match) return undefined;
  const start = match.index + match[0].length - match[1]!.length;
  return { start, end: start + match[1]!.length };
}

/** 全角の空白と、半角に対応する全角の記号（，（）＝ など）。英数字の全角（ａ、１）は名前に使えるので含めない */
const FULL_WIDTH_SEPARATOR_RE = /[　！-／：-＠［-｀｛-～]/;

const UNCLOSED_LITERAL_LABELS: Record<string, string> = {
  "'": '文字列',
  '"': '引用識別子',
  '/*': 'コメント',
};

/**
 * パーサーのエラー位置より手前にある、本当の原因と考えられる所。
 * - 閉じていない文字列・代替引用符・引用識別子・コメント。パーサーは SQL の末尾を指し、「途中で終わっています」のエラーになる
 * - 全角の空白や記号。パーサーは全角の文字を名前の一部として読むので、`t　WHERE` は 1 つの名前になり、エラーはその先の語で出る
 */
function likelySyntaxErrorCause(
  sql: string,
  errorStart: number,
  endedEarly: boolean,
): { message: string; span: SourceSpan } | null {
  const unclosed = findUnclosedLiteral(sql);
  // `q'[abc` はパーサーが q を名前として読み、直後の `'` でエラーにする。エラーの位置が開始の記号の中にあるときも原因とみなす
  const insideOpener =
    unclosed !== null && errorStart >= unclosed.start && errorStart < unclosed.start + unclosed.opener.length;
  if (unclosed && (endedEarly || insideOpener)) {
    const at = lineColumnAt(sql, unclosed.start);
    const what = UNCLOSED_LITERAL_LABELS[unclosed.opener] ?? '文字列（代替引用符）';
    return {
      message: `${at.line} 行 ${at.column} 列の「${unclosed.opener}」で始まる${what}が閉じていません`,
      span: { start: unclosed.start, end: unclosed.start + unclosed.opener.length },
    };
  }
  const masked = maskNonCode(sql);
  const index = masked.slice(0, errorStart + 1).search(FULL_WIDTH_SEPARATOR_RE);
  if (index < 0) return missingSelectItemCause(sql, masked, errorStart);
  const ch = masked[index]!;
  const at = lineColumnAt(sql, index);
  const message =
    ch === '　'
      ? `${at.line} 行 ${at.column} 列に全角の空白があります。この解析では全角の空白を語の区切りとして読めず、前後の語とつながった名前として扱います。半角の空白にしてください`
      : `${at.line} 行 ${at.column} 列の「${ch}」は全角の文字です。SQL の記号は半角（「${String.fromCharCode(ch.charCodeAt(0) - 0xfee0)}」）で書いてください`;
  return { message, span: { start: index, end: index + 1 } };
}

/**
 * 列を書き忘れた SELECT（`SELECT FROM t`、`SELECT a, FROM t`）。パーサーは FROM を列の名前として読み、
 * その後ろの語でエラーにするので、エラーの位置だけでは原因が分からない
 */
function missingSelectItemCause(
  sql: string,
  masked: string,
  errorStart: number,
): { message: string; span: SourceSpan } | null {
  const re = /\bSELECT(\s+(?:(?:DISTINCT|UNIQUE|ALL)\s+)?)FROM\b|,(\s*)FROM\b/gi;
  let match: RegExpExecArray | null;
  while ((match = re.exec(masked)) !== null) {
    if (match.index > errorStart) break;
    const at = lineColumnAt(sql, match.index);
    if (match[0].startsWith(',')) {
      return {
        message: `${at.line} 行 ${at.column} 列の「,」の後ろに列がありません。最後の列の後ろの「,」を消してください`,
        span: { start: match.index, end: match.index + 1 },
      };
    }
    return {
      message: `${at.line} 行 ${at.column} 列の SELECT の後ろに、表示する列がありません。列の名前か * を書いてください`,
      span: { start: match.index, end: match.index + 'SELECT'.length },
    };
  }
  return null;
}

/**
 * 位置を持たない英語のエラーの文のうち、意味の分かるものを日本語にする。分からないものはそのまま返す。
 * 予約語を別名の位置に書くと、node-sql-parser は位置の無いエラーを投げる。
 * 予約語の一覧は SQL パーサー（MySQL ビルド）のもので、Oracle の予約語と同じとは限らない
 */
export function translateParserMessage(message: string): string {
  const reserved = RESERVED_ALIAS_MESSAGE_RE.exec(message);
  if (reserved) {
    return `「${reserved[1]}」はこの解析では予約語として扱うので、そのままでは別名に使えません。別名にするなら二重引用符（"）で囲んでください`;
  }
  return message;
}

/**
 * node-sql-parser（peggy）の構文エラーの文 `Expected "#", "$", ... but "x" found.` から、見つかった文字を取り出す。
 * 入力の終わりで止まったときは null、この形の文でなければ undefined を返す。
 * 文の大半は期待していた字句の一覧（数百文字の英語）で、そのまま出すと読めず、スクリーンリーダーも全部読み上げる
 */
export function syntaxErrorFound(message: string): string | null | undefined {
  const match = /^Expected .* but (end of input|"((?:[^"\\]|\\.)*)") found\.$/s.exec(message);
  if (!match) return undefined;
  if (match[1] === 'end of input') return null;
  try {
    return JSON.parse(`"${match[2]}"`) as string;
  } catch {
    return match[2];
  }
}

/** オフセットを 1 始まりの行・列に変える */
export function lineColumnAt(text: string, offset: number): { line: number; column: number } {
  const before = text.slice(0, offset);
  const lastNewline = before.lastIndexOf('\n');
  return { line: before.split('\n').length, column: offset - lastNewline };
}

/**
 * node-sql-parser の構文エラー（location 付き）を、入力 sql 上の範囲に変える。
 * location は前処理後の SQL 上のオフセットなので、対応表で入力の座標へ戻す。
 * 入力の末尾で文が途切れたときは、最後の空白でない 1 文字を範囲にする（長さ 0 だとエディタに印を描けない）
 */
function syntaxErrorSpan(
  err: unknown,
  processedToInput: number[],
  sql: string,
): SourceSpan | undefined {
  const location = (err as { location?: { start?: { offset?: unknown }; end?: { offset?: unknown } } })
    ?.location;
  const startOffset = location?.start?.offset;
  if (typeof startOffset !== 'number') return undefined;
  const endOffset = typeof location?.end?.offset === 'number' ? location.end.offset : startOffset;

  const contentEnd = sql.trimEnd().length;
  if (contentEnd === 0) return undefined;
  const toInput = (offset: number): number =>
    offset < processedToInput.length ? processedToInput[offset]! : contentEnd;

  const start = toInput(startOffset);
  if (start >= contentEnd) return { start: contentEnd - 1, end: contentEnd };
  const end = Math.min(Math.max(toInput(endOffset), start + 1), contentEnd);
  return { start, end };
}

export const SAMPLE_SQL = `SELECT /*+ LEADING(u o) USE_NL(o) */
  u.user_id,
  u.user_name,
  u.email,
  o.order_no,
  o.total_amount,
  p.product_name,
  NVL(c.category_name, '未分類') AS category_name,
  lm.metric_score,
  hot.order_cnt
FROM users u
INNER JOIN orders o ON o.user_id = u.user_id
LEFT JOIN order_items oi ON oi.order_id = o.order_id
INNER JOIN products p ON p.product_id = oi.product_id AND (p.status = 'ACTIVE' OR p.clearance_flg = 1)
LEFT JOIN line_metrics lm ON lm.user_id = u.user_id AND lm.order_id = o.order_id AND lm.product_id = p.product_id
LEFT JOIN categories c ON c.category_id = p.category_id
INNER JOIN (
  SELECT user_id, COUNT(*) AS order_cnt
  FROM orders
  GROUP BY user_id
  HAVING COUNT(*) >= 2
) hot ON hot.user_id = u.user_id
WHERE u.status = 'ACTIVE'
  AND o.created_at >= TO_DATE('2024-01-01', 'YYYY-MM-DD')
  AND (
    o.total_amount > 1000
    OR u.email LIKE '%@example.com'
  )
  AND p.category_id IN (
    SELECT c2.category_id FROM categories c2
    WHERE c2.active_flg = 1
      AND EXISTS (
        SELECT 1 FROM category_stats cs
        WHERE cs.category_id = c2.category_id AND cs.product_cnt > 0
      )
  )
  AND oi.quantity BETWEEN 1 AND 10
  AND EXISTS (
    SELECT 1 FROM payments pay
    INNER JOIN payment_methods pm ON pm.method_id = pay.method_id
    WHERE pay.order_id = o.order_id AND pay.status = 'PAID' AND pm.enabled_flg = 1
  )
  AND u.user_id NOT IN (
    SELECT bu.user_id FROM banned_users bu
    WHERE bu.banned_at >= TO_DATE('2023-01-01', 'YYYY-MM-DD')
      OR bu.reason IN (SELECT code FROM ban_reasons WHERE severity = 'HIGH')
  )
GROUP BY u.user_id, u.user_name, u.email, o.order_no, o.total_amount, p.product_name, c.category_name, lm.metric_score, hot.order_cnt
HAVING SUM(oi.quantity) > (
  SELECT AVG(item_cnt) FROM (
    SELECT COUNT(*) AS item_cnt FROM order_items GROUP BY order_id
  ) avg_items
)
ORDER BY o.created_at DESC, o.total_amount DESC NULLS LAST
FETCH FIRST 100 ROWS ONLY`;

export const UPDATE_SAMPLE_SQL = `UPDATE users u
SET
  u.status = 'INACTIVE',
  u.updated_at = SYSDATE,
  u.last_order_amount = (
    SELECT MAX(o.total_amount)
    FROM orders o
    WHERE o.user_id = u.user_id
  )
WHERE u.last_login_at < TO_DATE('2023-01-01', 'YYYY-MM-DD')
  AND (
    u.status IN ('PENDING', 'HOLD')
    OR u.email LIKE '%@deprecated.example'
  )
  AND EXISTS (
    SELECT 1
    FROM orders o
    WHERE o.user_id = u.user_id
      AND o.total_amount > 0
  )`;

export const DELETE_SAMPLE_SQL = `DELETE FROM order_items oi
WHERE oi.quantity IS NULL
  AND EXISTS (
    SELECT 1
    FROM orders o
    INNER JOIN users u ON u.user_id = o.user_id
    WHERE o.order_id = oi.order_id
      AND o.created_at < TO_DATE('2022-01-01', 'YYYY-MM-DD')
      AND u.status = 'DELETED'
  )
  AND oi.order_id NOT IN (
    SELECT s.order_id FROM shipments s WHERE s.shipped_at IS NOT NULL
  )`;

export const UNION_SAMPLE_SQL = `SELECT
  u.user_id,
  u.user_name,
  u.email,
  o.order_no,
  o.total_amount,
  'ACTIVE' AS source
FROM users u
INNER JOIN orders o ON o.user_id = u.user_id
LEFT JOIN order_items oi ON oi.order_id = o.order_id
INNER JOIN products p ON p.product_id = oi.product_id
WHERE u.status = 'ACTIVE'
  AND o.created_at >= TO_DATE('2024-01-01', 'YYYY-MM-DD')
  AND o.total_amount > (
    SELECT AVG(total_amount) FROM orders WHERE status = 'COMPLETED'
  )
GROUP BY u.user_id, u.user_name, u.email, o.order_no, o.total_amount
HAVING COUNT(oi.item_id) > 0

UNION ALL

SELECT
  au.user_id,
  au.user_name,
  au.email,
  NULL AS order_no,
  0 AS total_amount,
  'ARCHIVED' AS source
FROM archived_users au
LEFT JOIN user_profiles up ON up.user_id = au.user_id
INNER JOIN (
  SELECT user_id, MAX(archived_at) AS last_archived
  FROM audit_log
  WHERE action = 'ARCHIVE'
  GROUP BY user_id
) al ON al.user_id = au.user_id
WHERE au.archived_at IS NOT NULL

MINUS

SELECT
  g.user_id,
  g.user_name,
  g.email,
  NULL AS order_no,
  0 AS total_amount,
  'GUEST' AS source
FROM guest_users g
LEFT JOIN guest_sessions gs ON gs.guest_id = g.user_id
WHERE g.trial_ends_at < SYSDATE
  AND gs.last_seen_at < SYSDATE - 30
  AND NOT EXISTS (
    SELECT 1 FROM orders o WHERE o.user_id = g.user_id
  )`;

/** 旧式（Oracle 独自）の外部結合演算子 `(+)` を使ったサンプル */
export const LEGACY_JOIN_SAMPLE_SQL = `SELECT
  e.emp_no,
  e.emp_name,
  d.dept_name,
  m.emp_name AS manager_name,
  NVL(b.bonus_amount, 0) AS bonus_amount
FROM employees e, departments d, employees m, bonuses b
WHERE e.dept_no = d.dept_no
  AND e.manager_no = m.emp_no(+)
  AND e.emp_no = b.emp_no(+)
  AND b.fiscal_year(+) = 2024
  AND d.location IN ('TOKYO', 'OSAKA')
  AND e.hired_at >= TO_DATE('2015-04-01', 'YYYY-MM-DD')
ORDER BY d.dept_name, e.emp_no`;

/** 階層問い合わせ（CONNECT BY / START WITH）のサンプル */
export const HIERARCHICAL_SAMPLE_SQL = `SELECT
  LEVEL AS depth,
  e.emp_no,
  e.emp_name,
  e.manager_no,
  d.dept_name,
  SYS_CONNECT_BY_PATH(e.emp_name, '/') AS path
FROM employees e
INNER JOIN departments d ON d.dept_no = e.dept_no
WHERE e.retired_flg = 0
START WITH e.manager_no IS NULL
CONNECT BY NOCYCLE PRIOR e.emp_no = e.manager_no
ORDER BY LEVEL, e.emp_no
FETCH FIRST 50 ROWS ONLY`;

export { exprToString };
