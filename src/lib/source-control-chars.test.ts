import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

/**
 * ソースに制御文字（タブ・改行・復帰を除く）が無いことを確かめる。
 * シェルのヒアドキュメントや `python -c` で正規表現を書き込むと、`\b` がバックスペース（U+0008）に化けることがある。
 * 化けた正規表現はエラーにならず、何にも一致しないだけなので気づけない（ヒントの説明の正規表現 14 個が、最初のコミットから
 * どれにも一致していなかった）。エディタでも表示されない
 */
const ROOTS = ['src', 'scripts'];
const EXTENSIONS = /\.(?:ts|tsx|mjs|cjs|js|css|html|json|md)$/;
// eslint-disable-next-line no-control-regex
const CONTROL_CHAR = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === 'node_modules' ? [] : sourceFiles(path);
    return EXTENSIONS.test(name) ? [path] : [];
  });
}

describe('ソースの制御文字', () => {
  it('タブ・改行・復帰のほかに、制御文字を含むファイルが無い', () => {
    const root = process.cwd();
    const found = ROOTS.flatMap((dir) => sourceFiles(join(root, dir))).flatMap((path) =>
      readFileSync(path, 'utf8')
        .split('\n')
        .map((line, index) => ({ line, index }))
        .filter(({ line }) => CONTROL_CHAR.test(line))
        .map(({ index }) => `${relative(root, path)}:${index + 1}`),
    );
    expect(found).toEqual([]);
  });
});
