import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { THEME_STORAGE_KEY } from './theme';

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

describe('index.html の配色の先読み', () => {
  const html = readFileSync(resolve(PROJECT_ROOT, 'index.html'), 'utf8');

  it('theme.ts と同じ保存のキーを読む（ずれると、選んだ配色と最初の描画の配色が食い違う）', () => {
    expect(html).toContain(`'${THEME_STORAGE_KEY}'`);
  });

  it('app.js より前、head の中で data-theme を付ける', () => {
    const scriptAt = html.indexOf("setAttribute('data-theme'");
    expect(scriptAt).toBeGreaterThan(-1);
    expect(scriptAt).toBeLessThan(html.indexOf('</head>'));
  });
});
