export interface SourceSpan {
  start: number;
  end: number;
}

export interface LocRange {
  start?: { offset?: number };
  end?: { offset?: number };
}

export function toSourceSpan(loc: LocRange | undefined | null): SourceSpan | undefined {
  const start = loc?.start?.offset;
  const end = loc?.end?.offset;
  if (start === undefined || end === undefined || end <= start) return undefined;
  return { start, end };
}

export function spansEqual(a: SourceSpan | null | undefined, b: SourceSpan | null | undefined): boolean {
  if (!a || !b) return false;
  return a.start === b.start && a.end === b.end;
}

export function columnEntrySourceSpan(col: any): SourceSpan | undefined {
  return toSourceSpan(col?.expr?.loc) ?? toSourceSpan(col?.loc);
}

export function orderByEntrySourceSpan(entry: any): SourceSpan | undefined {
  const exprSpan = toSourceSpan(entry?.expr?.loc);
  if (!exprSpan) return undefined;
  if (!entry?.type) return exprSpan;
  const suffix = ` ${entry.type}`;
  return { start: exprSpan.start, end: exprSpan.end + suffix.length };
}

export function limitOffsetSourceSpans(ast: any): {
  limitSpan?: SourceSpan;
  offsetSpan?: SourceSpan;
} {
  if (!ast?.limit) return {};
  const whole = toSourceSpan(ast.limit.loc);
  const values = ast.limit.value;
  if (!Array.isArray(values) || values.length === 0) {
    return whole ? { limitSpan: whole } : {};
  }

  const limitSpan = toSourceSpan(values[0]?.loc);
  const offsetSpan = values[1] ? toSourceSpan(values[1]?.loc) : undefined;
  if (limitSpan || offsetSpan) {
    return { limitSpan, offsetSpan };
  }
  return whole ? { limitSpan: whole } : {};
}
