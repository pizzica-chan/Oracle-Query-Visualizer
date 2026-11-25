/**
 * 入力の保存（localStorage）と、SQL を URL のフラグメント（# 以降）に入れた共有リンク。
 *
 * どちらもブラウザの中で完結し、外部へは何も送らない。
 * フラグメントは HTTP リクエストに含まれないので、Cloudflare などで公開していてもサーバーに SQL は届かない。
 */

export interface PersistedAppState {
  sql: string;
  resolveAliases: boolean;
}

export const STORAGE_KEY = 'oracle-query-visualizer:state:v1';

type ReadableStorage = Pick<Storage, 'getItem'>;
type WritableStorage = Pick<Storage, 'setItem'>;

/**
 * localStorage を取り出す。プライベートウィンドウやサイトデータの無効化で、
 * アクセスしただけで例外になる環境があるので、そのときは null を返す
 */
export function safeLocalStorage(): Storage | null {
  try {
    return typeof window !== 'undefined' ? window.localStorage : null;
  } catch {
    return null;
  }
}

/** 保存値を検証し、型の合う項目だけを返す。壊れた値や古い形式は無視する */
function sanitizeState(raw: unknown): Partial<PersistedAppState> {
  if (!raw || typeof raw !== 'object') return {};
  const record = raw as Record<string, unknown>;
  const state: Partial<PersistedAppState> = {};
  if (typeof record.sql === 'string') state.sql = record.sql;
  if (typeof record.resolveAliases === 'boolean') state.resolveAliases = record.resolveAliases;
  return state;
}

export function readStoredState(storage: ReadableStorage | null): Partial<PersistedAppState> {
  if (!storage) return {};
  try {
    const text = storage.getItem(STORAGE_KEY);
    return text ? sanitizeState(JSON.parse(text)) : {};
  } catch {
    return {};
  }
}

/** 書き込みに失敗しても（容量超過・無効化）画面の操作は続けられるので、例外は握りつぶす */
export function writeStoredState(storage: WritableStorage | null, state: PersistedAppState): void {
  if (!storage) return;
  try {
    storage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // 保存できなくても解析には影響しない
  }
}

// ── 共有リンク ─────────────────────────────────────────

export interface SharePayload {
  sql: string;
}

/** フラグメントのキー。`#q=` の後ろに形式の印（1 文字）と base64url の本体が続く */
const SHARE_KEY = 'q=';
/** d: deflate-raw で圧縮、r: 圧縮なし（CompressionStream が無いブラウザ向け） */
type ShareFormat = 'd' | 'r';

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]!);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64UrlToBytes(text: string): Uint8Array {
  const base64 = text.replace(/-/g, '+').replace(/_/g, '/');
  const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/**
 * 共有リンクから読み込む中身の上限（展開したあとの大きさ）。deflate は 1000 倍近くまで縮むので、
 * 上限が無いと、細工したリンクを開いただけで展開に数 GB のメモリを使い、タブが固まる
 */
export const MAX_SHARE_PAYLOAD_BYTES = 8 * 1024 * 1024;

/** 変換した結果を返す。limit を超えたら読むのをやめて null を返す */
async function pipeThrough(
  bytes: Uint8Array,
  transform: GenericTransformStream,
  limit = Infinity,
): Promise<Uint8Array | null> {
  const reader = new Blob([bytes as BlobPart]).stream().pipeThrough(transform).getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

function canCompress(): boolean {
  return typeof CompressionStream !== 'undefined' && typeof DecompressionStream !== 'undefined';
}

function sanitizeSharePayload(raw: unknown): SharePayload | null {
  if (!raw || typeof raw !== 'object') return null;
  const record = raw as Record<string, unknown>;
  return typeof record.sql === 'string' ? { sql: record.sql } : null;
}

/** フラグメント（先頭の # はあってもなくてもよい）が共有リンクの形（`q=` で始まる）か。中身が読めるかは見ない */
export function isShareFragment(fragment: string): boolean {
  return fragment.replace(/^#/, '').startsWith(SHARE_KEY);
}

/** 共有リンクのフラグメント（先頭の # を除く）を作る */
export async function encodeSharePayload(payload: SharePayload): Promise<string> {
  const json = new TextEncoder().encode(JSON.stringify(payload));
  if (canCompress()) {
    try {
      const compressed = await pipeThrough(json, new CompressionStream('deflate-raw'));
      if (compressed) return `${SHARE_KEY}d${bytesToBase64Url(compressed)}`;
    } catch {
      // 圧縮に失敗したら圧縮なしで作る
    }
  }
  return `${SHARE_KEY}r${bytesToBase64Url(json)}`;
}

/** フラグメント（先頭の # はあってもなくてもよい）から共有された SQL を取り出す。共有リンクでなければ null */
export async function decodeSharePayload(fragment: string): Promise<SharePayload | null> {
  if (!isShareFragment(fragment)) return null;
  const body = fragment.replace(/^#/, '');
  const format = body.charAt(SHARE_KEY.length) as ShareFormat;
  const encoded = body.slice(SHARE_KEY.length + 1);
  try {
    let bytes: Uint8Array | null = base64UrlToBytes(encoded);
    if (format === 'd') {
      if (!canCompress()) return null;
      bytes = await pipeThrough(bytes, new DecompressionStream('deflate-raw'), MAX_SHARE_PAYLOAD_BYTES);
    } else if (format !== 'r') {
      return null;
    }
    if (!bytes || bytes.byteLength > MAX_SHARE_PAYLOAD_BYTES) return null;
    return sanitizeSharePayload(JSON.parse(new TextDecoder().decode(bytes)));
  } catch {
    return null;
  }
}
