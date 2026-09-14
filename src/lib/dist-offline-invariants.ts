import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export const GITHUB_PAGES_BASE = '/Oracle-Query-Visualizer/';

/**
 * dist/ が file:// 直開き（HTTP サーバー不要）向けか検証する。
 * @returns エラーメッセージの配列（空なら OK）
 */
export function validateDistOfflineInvariants(distDir: string): string[] {
  const errors: string[] = [];
  const htmlPath = join(distDir, 'index.html');

  if (!existsSync(htmlPath)) {
    return ['dist/index.html が存在しません'];
  }

  const html = readFileSync(htmlPath, 'utf8');

  if (/<script[^>]+type="module"/i.test(html)) {
    errors.push('ES module の script があります（file:// では外部 module が読めません）');
  }
  if (/<link[^>]+href=["'][^"']*assets\/[^"']+\.css["']/i.test(html)) {
    errors.push('外部 CSS の link があります（index.html へのインライン化が必要です）');
  }
  if (!/<style>[\s\S]+<\/style>/i.test(html)) {
    errors.push('CSS が index.html にインライン化されていません');
  }
  if (html.includes(GITHUB_PAGES_BASE)) {
    errors.push(
      `GitHub Pages 向け base パス (${GITHUB_PAGES_BASE}) が含まれています。` +
        'リポジトリ同梱の dist/ は通常の npm run build（GITHUB_PAGES 未設定）で生成してください',
    );
  }
  if (!/<script defer src="\.\/assets\/app\.js"><\/script>/.test(html)) {
    errors.push('script は <script defer src="./assets/app.js"></script> である必要があります');
  }

  const rootIdx = html.indexOf('id="root"');
  const scriptIdx = html.indexOf('<script defer src="./assets/app.js">');
  if (rootIdx === -1 || scriptIdx === -1 || scriptIdx <= rootIdx) {
    errors.push('#root 要素の後ろに app.js の script を配置してください');
  }

  const jsPath = join(distDir, 'assets/app.js');
  if (!existsSync(jsPath)) {
    errors.push('dist/assets/app.js が存在しません');
  } else {
    const js = readFileSync(jsPath, 'utf8');
    if (js.includes(GITHUB_PAGES_BASE)) {
      errors.push(`app.js に GitHub Pages 向け base パス (${GITHUB_PAGES_BASE}) が含まれています`);
    }
  }

  return errors;
}

export function assertDistOfflineInvariants(distDir: string): void {
  const errors = validateDistOfflineInvariants(distDir);
  if (errors.length > 0) {
    throw new Error(
      `dist/ は file:// オフライン配布向けではありません:\n${errors.map((e) => `  - ${e}`).join('\n')}`,
    );
  }
}
