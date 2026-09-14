import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

/** 実行時ソース（ビルドに含まれるファイル）の監査対象 */
export const RUNTIME_SOURCE_ROOTS = ['index.html', 'src'] as const;

/** dist が存在するときのみ監査（npm run build 後） */
export const DIST_ROOT = 'dist';

const RUNTIME_EXTENSIONS = new Set(['.html', '.ts', '.tsx', '.css']);
const DIST_EXTENSIONS = new Set(['.html', '.js', '.css']);

/** テストコード内の例示文字列を除外 */
const EXCLUDED_RELATIVE_PATHS = [
  /(?:^|\/)src\/lib\/offline\.test\.ts$/,
  /(?:^|\/)src\/lib\/fixtures\/offline-audit\.ts$/,
];

export interface OfflineViolation {
  file: string;
  line: number;
  rule: string;
  snippet: string;
}

interface ForbiddenRule {
  id: string;
  pattern: RegExp;
}

/** 実行時に禁止する通信・外部参照パターン（ソースコード用・行単位） */
export const FORBIDDEN_RUNTIME_RULES: ForbiddenRule[] = [
  { id: 'external-url', pattern: /https?:\/\//i },
  { id: 'fetch-call', pattern: /\bfetch\s*\(/ },
  { id: 'xhr', pattern: /\bXMLHttpRequest\b/ },
  { id: 'websocket', pattern: /\bnew\s+WebSocket\b/ },
  { id: 'event-source', pattern: /\bnew\s+EventSource\b/ },
  { id: 'send-beacon', pattern: /\bsendBeacon\s*\(/ },
  { id: 'external-script', pattern: /<script[^>]+src\s*=\s*['"]https?:/i },
  { id: 'external-link', pattern: /<link[^>]+href\s*=\s*['"]https?:/i },
  { id: 'external-css-import', pattern: /@import\s+url\s*\(\s*['"]?https?:/i },
  { id: 'external-css-url', pattern: /url\s*\(\s*['"]?https?:/i },
];

/** dist 成果物用 — 実際の外部リソース読み込み・通信のみ（React エラーメッセージ内 URL 等は除外） */
export const FORBIDDEN_DIST_RULES: ForbiddenRule[] = [
  { id: 'fetch-external', pattern: /\bfetch\s*\(\s*['"`]https?:\/\//i },
  { id: 'dynamic-import-external', pattern: /\bimport\s*\(\s*['"`]https?:\/\//i },
  { id: 'static-import-external', pattern: /\bimport\s+['"`]https?:\/\//i },
  { id: 'external-script-tag', pattern: /<script[^>]+src=['"`]https?:\/\//i },
  { id: 'external-link-tag', pattern: /<link[^>]+href=['"`]https?:\/\//i },
  { id: 'external-css-url', pattern: /url\s*\(\s*['"`]?https?:\/\//i },
  { id: 'websocket-external', pattern: /\bnew\s+WebSocket\s*\(\s*['"`]https?:\/\//i },
];

function shouldSkipRelativePath(relativePath: string): boolean {
  if (/\.test\.(ts|tsx)$/.test(relativePath)) return true;
  return EXCLUDED_RELATIVE_PATHS.some((re) => re.test(relativePath.replace(/\\/g, '/')));
}

function collectFiles(
  absoluteDir: string,
  projectRoot: string,
  extensions: Set<string>,
): string[] {
  const results: string[] = [];

  function walk(current: string): void {
    for (const entry of readdirSync(current)) {
      const absolute = join(current, entry);
      const rel = relative(projectRoot, absolute).replace(/\\/g, '/');
      if (shouldSkipRelativePath(rel)) continue;

      const stat = statSync(absolute);
      if (stat.isDirectory()) {
        walk(absolute);
        continue;
      }

      const dot = entry.lastIndexOf('.');
      const ext = dot >= 0 ? entry.slice(dot) : '';
      if (extensions.has(ext)) {
        results.push(absolute);
      }
    }
  }

  walk(absoluteDir);
  return results;
}

export function auditSourceText(content: string, rules = FORBIDDEN_RUNTIME_RULES): OfflineViolation[] {
  const violations: OfflineViolation[] = [];
  const lines = content.split(/\r?\n/);

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    const trimmed = line.trim();
    if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) {
      continue;
    }

    for (const rule of rules) {
      if (rule.pattern.test(line)) {
        violations.push({
          file: '',
          line: i + 1,
          rule: rule.id,
          snippet: line.trim().slice(0, 120),
        });
        rule.pattern.lastIndex = 0;
      }
    }
  }

  return violations;
}

/** dist 等の minified ファイル向け — ファイル全体を走査 */
export function auditBundledText(
  content: string,
  rules = FORBIDDEN_DIST_RULES,
): OfflineViolation[] {
  const violations: OfflineViolation[] = [];

  for (const rule of rules) {
    const flags = rule.pattern.flags.includes('g') ? rule.pattern.flags : `${rule.pattern.flags}g`;
    const pattern = new RegExp(rule.pattern.source, flags);
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(content)) !== null) {
      violations.push({
        file: '',
        line: 1,
        rule: rule.id,
        snippet: match[0].slice(0, 120),
      });
    }
  }

  return violations;
}

export function auditFile(absolutePath: string, projectRoot: string): OfflineViolation[] {
  const rel = relative(projectRoot, absolutePath).replace(/\\/g, '/');
  if (shouldSkipRelativePath(rel)) return [];

  const content = readFileSync(absolutePath, 'utf8');
  const isDistBundle = rel.startsWith('dist/');
  const violations = isDistBundle
    ? auditBundledText(content)
    : auditSourceText(content);
  return violations.map((v) => ({ ...v, file: rel }));
}

export function auditProjectTree(
  projectRoot: string,
  roots: readonly string[],
  extensions: Set<string>,
): OfflineViolation[] {
  const violations: OfflineViolation[] = [];

  for (const root of roots) {
    const absolute = join(projectRoot, root);
    if (!existsSync(absolute)) continue;

    const stat = statSync(absolute);
    const files = stat.isDirectory()
      ? collectFiles(absolute, projectRoot, extensions)
      : [absolute];

    for (const file of files) {
      violations.push(...auditFile(file, projectRoot));
    }
  }

  return violations;
}

export function auditRuntimeSources(projectRoot: string): OfflineViolation[] {
  return auditProjectTree(projectRoot, RUNTIME_SOURCE_ROOTS, RUNTIME_EXTENSIONS);
}

export function auditDistBundle(projectRoot: string): OfflineViolation[] | null {
  const distDir = join(projectRoot, DIST_ROOT);
  if (!existsSync(distDir)) return null;
  return auditProjectTree(projectRoot, [DIST_ROOT], DIST_EXTENSIONS);
}

/** テスト用 — 外部通信 API が呼ばれたら throw する */
export function installOfflineGuard(): () => string[] {
  const errors: string[] = [];

  const fetchImpl = globalThis.fetch;
  const xhrOpen =
    typeof XMLHttpRequest !== 'undefined' ? XMLHttpRequest.prototype.open : undefined;
  const wsConstructor = globalThis.WebSocket;

  globalThis.fetch = ((...args: Parameters<typeof fetch>) => {
    errors.push(`fetch(${String(args[0])})`);
    throw new Error(`offline guard: fetch(${String(args[0])})`);
  }) as typeof fetch;

  if (xhrOpen) {
    XMLHttpRequest.prototype.open = function (
      _method: string,
      url: string | URL,
      _async?: boolean,
      _username?: string | null,
      _password?: string | null,
    ) {
      errors.push(`XMLHttpRequest.open(${String(url)})`);
      throw new Error(`offline guard: XMLHttpRequest.open(${String(url)})`);
    };
  }

  if (typeof wsConstructor === 'function') {
    globalThis.WebSocket = function (url: string | URL, _protocols?: string | string[]) {
      errors.push(`WebSocket(${String(url)})`);
      throw new Error(`offline guard: WebSocket(${String(url)})`);
    } as unknown as typeof WebSocket;
  }

  return () => {
    globalThis.fetch = fetchImpl;
    if (xhrOpen) {
      XMLHttpRequest.prototype.open = xhrOpen;
    }
    if (typeof wsConstructor === 'function') {
      globalThis.WebSocket = wsConstructor;
    }
    return errors;
  };
}
