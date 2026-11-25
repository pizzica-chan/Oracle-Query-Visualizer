import { describe, expect, it } from 'vitest';
import {
  MAX_SHARE_PAYLOAD_BYTES,
  STORAGE_KEY,
  decodeSharePayload,
  encodeSharePayload,
  readStoredState,
  writeStoredState,
} from './app-persistence';

function memoryStorage(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  return {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => void data.set(key, value),
    data,
  };
}

describe('入力の保存', () => {
  it('書いた状態をそのまま読み戻せる', () => {
    const storage = memoryStorage();
    const state = { sql: 'SELECT 1 FROM dual', resolveAliases: true };
    writeStoredState(storage, state);
    expect(readStoredState(storage)).toEqual(state);
  });

  it('壊れた JSON や型の違う項目は無視する', () => {
    expect(readStoredState(memoryStorage({ [STORAGE_KEY]: '{not json' }))).toEqual({});
    expect(
      readStoredState(memoryStorage({ [STORAGE_KEY]: JSON.stringify({ sql: 1, resolveAliases: true }) })),
    ).toEqual({ resolveAliases: true });
  });

  it('ストレージが無い・例外を投げるときも、空の状態で続けられる', () => {
    expect(readStoredState(null)).toEqual({});
    const throwing = {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('quota');
      },
    };
    expect(readStoredState(throwing)).toEqual({});
    expect(() => writeStoredState(throwing, { sql: '', resolveAliases: false })).not.toThrow();
  });
});

describe('共有リンク', () => {
  it('SQL を往復できる（日本語や記号を含む）', async () => {
    const payload = { sql: "SELECT * FROM t WHERE name = '山田' -- #&?=" };
    expect(await decodeSharePayload(`#${await encodeSharePayload(payload)}`)).toEqual(payload);
  });

  it('URL に入れられる文字だけで作る', async () => {
    const fragment = await encodeSharePayload({ sql: 'SELECT /*+ FULL(t) */ 1 FROM t' });
    expect(fragment).toMatch(/^q=[dr][A-Za-z0-9_-]+$/);
  });

  it('圧縮なしの形式も読める', async () => {
    const json = JSON.stringify({ sql: 'SELECT 1 FROM dual' });
    const raw = btoa(json).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    expect(await decodeSharePayload(`#q=r${raw}`)).toEqual({ sql: 'SELECT 1 FROM dual' });
  });

  it('共有リンクでないフラグメントや壊れた値は null', async () => {
    expect(await decodeSharePayload('#section-1')).toBeNull();
    expect(await decodeSharePayload('#q=d!!!')).toBeNull();
    expect(await decodeSharePayload('#q=x' + btoa('{}'))).toBeNull();
    const wrongShape = btoa(JSON.stringify({ sqlA: 'a' }));
    expect(await decodeSharePayload(`#q=r${wrongShape}`)).toBeNull();
  });

  it('展開すると上限を超える共有リンクは、展開を途中でやめて null を返す', async () => {
    const sql = 'a'.repeat(MAX_SHARE_PAYLOAD_BYTES);
    const fragment = await encodeSharePayload({ sql });
    // 同じ文字の並びはよく縮むので、リンクそのものは短い
    expect(fragment.length).toBeLessThan(100_000);
    expect(await decodeSharePayload(fragment)).toBeNull();

    const withinLimit = { sql: 'a'.repeat(1_000_000) };
    expect(await decodeSharePayload(await encodeSharePayload(withinLimit))).toEqual(withinLimit);
  });
});
