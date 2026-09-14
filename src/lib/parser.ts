/* eslint-disable @typescript-eslint/no-explicit-any */
// node-sql-parser には Oracle 専用ビルドが無い。Oracle 構文のカバー率と
// 位置情報（loc）の両方を実測で比べた結果、MySQL ビルドが最良だったため
// これを土台にし、Oracle 固有構文は sql-preprocess.ts で吸収している。
// 既定エントリ（ルート）は全方言を同梱するので、専用ビルドを直接読む
// （オフライン配布の JS を大幅に軽くする）
import { Parser } from 'node-sql-parser/build/mysql';
import { normalizeConditionTree } from './condition-tree-normalize';
import { formatJoinConditionLabel } from './join-condition';
import {
  maskNonCode,
  preprocessSqlForParser,
  remapParsedQuerySpans,
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

function resolveFunctionName(nameField: unknown): string {
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

function unescapeSqlSingleQuotedValue(value: string): string {
  return value.replace(/''/g, "'");
}

function formatSingleQuotedString(value: string): string {
  const unescaped = unescapeSqlSingleQuotedValue(value);
  return `'${unescaped.replace(/'/g, "''")}'`;
}

function formatDoubleQuotedString(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function formatQuotedLiteral(node: any): string {
  if (typeof node.raw === 'string' && node.raw.length > 0) {
    const raw = node.raw;
    if (raw.startsWith("'") || raw.startsWith('"')) return raw;
  }
  if (node.type === 'double_quote_string') return formatDoubleQuotedString(String(node.value));
  return formatSingleQuotedString(String(node.value));
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
    const text = exprToString(arg);
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

/** 分析関数の OVER 句。落とすと同じ関数呼び出しに見えてしまう */
function formatOverClause(over: any): string {
  const spec = over?.as_window_specification?.window_specification;
  if (!spec) return over?.as_window_specification?.name ? ` OVER ${over.as_window_specification.name}` : '';

  const parts: string[] = [];
  const partitionBy = toArray<any>(spec.partitionby)
    .map((p: any) => exprToString(p?.expr ?? p))
    .filter(Boolean);
  if (partitionBy.length > 0) parts.push(`PARTITION BY ${partitionBy.join(', ')}`);

  const orderBy = toArray<any>(spec.orderby)
    .map((o: any) => `${exprToString(o?.expr ?? o)}${o?.type ? ` ${o.type}` : ''}`)
    .filter((text) => text.trim().length > 0);
  if (orderBy.length > 0) parts.push(`ORDER BY ${orderBy.join(', ')}`);

  return ` OVER (${parts.join(' ')})`;
}

function exprToString(node: any): string {
  if (!node) return '';

  // 元 SQL の括弧を落とすと (a + b) * 2 が a + b * 2 になり、表示が別の意味になる
  const wrap = (text: string): string => (node.parentheses ? `(${text})` : text);

  switch (node.type) {
    case 'column_ref': {
      const parts: string[] = [];
      if (node.table) parts.push(formatIdentifier(node.table));
      if (node.column) parts.push(formatIdentifier(node.column));
      return parts.join('.') || '*';
    }
    case 'number':
    case 'bool':
      return String(node.value);
    case 'string':
    case 'single_quote_string':
    case 'double_quote_string':
      return formatQuotedLiteral(node);
    case 'null':
      return 'NULL';
    case 'star':
      return node.table ? `${node.table}.*` : '*';
    case 'expr_list':
      return toArray(node.value)
        .map((a: any) => exprToString(a))
        .join(', ');
    case 'binary_expr': {
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
      const args = formatFunctionArgs(extractFunctionArgs(node));
      return `${fnName}(${args})${formatOverClause(node.over)}`;
    }
    case 'aggr_func': {
      const rawArgs = node.args?.expr ?? node.args?.value ?? node.args;
      const distinctPrefix = node.args?.distinct ? 'DISTINCT ' : '';
      const args = toArray<any>(rawArgs)
        .map((a: any) => exprToString(a))
        .join(', ');
      return `${node.name}(${distinctPrefix}${args})${formatOverClause(node.over)}`;
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
      return `CAST(${exprToString(node.expr)} AS ${formatCastTarget(node.target)})`;
    }
    case 'subquery': {
      const inner = node.subquery?.ast ?? node.subquery ?? node.ast;
      if (inner?.type === 'select') {
        return summarizeSelect(inner);
      }
      return '(subquery)';
    }
    default: {
      // `SET col = (SELECT …)` のように、型を持たず ast だけを抱えたノードが来る
      const inner = extractSubquerySelectAst(node);
      if (inner) return summarizeSelect(inner);
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
  const table = first?.table ?? '?';
  const cols = toArray<any>(ast.columns).length;
  return `(SELECT ${cols}列 FROM ${table})`;
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
      const inner = selectRange(node);
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
function nullsOrderTextFor(entry: any): string {
  const end = entry?.expr?.loc?.end?.offset;
  if (typeof end !== 'number' || nullsOrders.length === 0) return '';
  const found = nullsOrders.find((info) => {
    if (info.processedPos < end) return false;
    const between = processedSql.slice(end, info.processedPos);
    return /^[\s]*(?:ASC|DESC)?[\s]*$/i.test(between);
  });
  return found ? ` NULLS ${found.position}` : '';
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
        ? buildSelectParsed(innerAst)
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
        nestedQuery: buildSelectParsed(subAst),
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
              nestedQuery: buildSelectParsed(subAst),
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
          nestedQuery: subAst ? buildSelectParsed(subAst) : undefined,
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
            nestedQuery: subAst ? buildSelectParsed(subAst) : undefined,
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
            nestedQuery: subAst ? buildSelectParsed(subAst) : undefined,
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

function buildTableRef(entry: any, index: number): TableRef {
  const sourceSpan = toSourceSpan(entry.loc);

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
    const alias = entry.as ?? entry.alias ?? `derived_${index}`;
    const derivedQuery = buildSelectParsed(entry.expr.ast);
    const span = toSourceSpan(entry.expr?.loc) ?? derivedQuery.sourceSpan;
    return {
      id: nextId('tbl'),
      table: alias,
      alias,
      displayName: `${alias} (派生テーブル)`,
      isDerived: true,
      derivedQuery: span ? { ...derivedQuery, sourceSpan: span } : derivedQuery,
      sourceSpan,
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
  if (!on) return { condition: '(no condition)' };

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
  if (columns.length === 0) return { condition: '(no condition)' };

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

    if (isNatural && condition === '(no condition)') {
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
  const groups = groupJoinConditions(collectAndedConditions(where), tables, eligible);
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
      condition: '(no condition)',
      fromWhereClause: true,
    });
  }

  return joins;
}

function buildSelectParsed(ast: any): ParsedQuery {
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

  const orderBy: SqlFragment[] = toArray<any>(ast.orderby).map((o: any) => ({
    text: `${exprToString(o.expr)}${o.type ? ` ${o.type}` : ''}${nullsOrderTextFor(o)}`,
    sourceSpan: orderByEntrySourceSpan(o),
  }));

  const hints = hintsForAst(ast);

  return {
    rawSql: '',
    sourceSpan: toSourceSpan(ast?.loc),
    statementType: 'SELECT',
    tables,
    joins: [...joins, ...derivedJoins],
    where,
    having,
    columns: parseColumns(ast.columns),
    groupBy,
    orderBy,
    ...rowLimitForAst(ast),
    distinct: Boolean(ast.distinct),
    hints,
    hintSpan: hints?.[0]?.sourceSpan,
    hierarchical: hierarchicalForAst(ast),
  };
}

function parseSelectQuery(ast: any, rawSql: string): ParsedQuery {
  const ctes = parseWithClause(ast.with);
  const branches = collectUnionBranches(ast);
  let main = applyCtesToQuery(buildSelectParsed(branches[0].ast), ctes);
  main.rawSql = rawSql;

  if (branches.length > 1) {
    // Oracle では ORDER BY / 行制限句は集合演算の結果全体に効く。
    // パーサは最後のブランチに載せるので、文レベルへ引き上げる
    const last = buildSelectParsed(branches[branches.length - 1]!.ast);
    if (main.orderBy.length === 0 && last.orderBy.length > 0) main.orderBy = last.orderBy;
    if (main.limit == null && main.offset == null && (last.limit != null || last.offset != null)) {
      main.limit = last.limit;
      main.limitSpan = last.limitSpan;
      main.offset = last.offset;
      main.offsetSpan = last.offsetSpan;
      main.rowLimitPercent = last.rowLimitPercent;
      main.rowLimitWithTies = last.rowLimitWithTies;
      main.rowLimitSpan = last.rowLimitSpan;
    }

    main.unionBranches = branches.map((branch, index) => {
      const branchQuery = applyCtesToQuery(buildSelectParsed(branch.ast), ctes);
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
    const name = entry.table ?? entry.as ?? '';
    const matched = tables.find(
      (t) => t.alias === name || t.table === name || t.displayName === name,
    );
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

  try {
    const preprocessResult = preprocessSqlForParser(trimmed);
    const preprocessed = preprocessResult.sql;
    const processedToOriginal = preprocessResult.processedToOriginal;
    naturalJoinStarts = preprocessResult.naturalJoinStarts;
    outerJoinMarkers = preprocessResult.outerJoinMarkers;
    hierarchicalClauses = preprocessResult.hierarchicalClauses;
    rowLimits = preprocessResult.rowLimits;
    optimizerHints = preprocessResult.hints;
    nullsOrders = preprocessResult.nullsOrders;
    processedSql = preprocessed;
    const ast = parser.astify(preprocessed, {
      database: 'MySQL',
      parseOptions: { includeLocations: true },
    });
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

    const remap = (query: ParsedQuery) => remapParsedQuerySpans(processedToOriginal, query, trimmed);

    if (first.type === 'select') {
      const query = parseSelectQuery(first, trimmed);
      return { success: true, query: remap(query) };
    }

    if (first.type === 'update') {
      const query = parseUpdateAst(first, trimmed);
      return { success: true, query: remap(query) };
    }

    if (first.type === 'delete') {
      const query = parseDeleteAst(first, trimmed);
      return { success: true, query: remap(query) };
    }

    return {
      success: false,
      error: {
        message: `現在 SELECT / UPDATE / DELETE 文のみ対応しています（検出: ${first.type?.toUpperCase() ?? 'unknown'}）`,
      },
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : 'SQLの解析に失敗しました';
    return { success: false, error: { message } };
  }
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
