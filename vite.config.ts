import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';

/** 配布物は file:// 直開きと Cloudflare の両方で動く相対パス */
const base = './';

function assetRelativePath(href: string): string {
  const assetsIndex = href.indexOf('assets/');
  if (assetsIndex >= 0) return href.slice(assetsIndex);
  return href.replace(/^\.\//, '');
}

/** 配布向け HTML 調整 — CSS インライン化、classic script を #root の後ろへ */
function fixDistHtml(): Plugin {
  return {
    name: 'fix-dist-html',
    closeBundle() {
      const distDir = resolve(process.cwd(), 'dist');
      const htmlPath = resolve(distDir, 'index.html');
      let html = readFileSync(htmlPath, 'utf8');

      const cssLinkRe = /<link[^>]*href="([^"]*assets\/[^"]+\.css)"[^>]*>\s*/i;
      const cssMatch = html.match(cssLinkRe);
      if (!cssMatch) {
        throw new Error('[fix-dist-html] dist/index.html に CSS 参照が見つかりません');
      }

      const cssPath = resolve(distDir, assetRelativePath(cssMatch[1]!));
      const css = readFileSync(cssPath, 'utf8');
      html = html.replace(cssLinkRe, `<style>${css}</style>\n    `);

      const scriptRe = /<script[^>]*\ssrc="([^"]*assets\/[^"]+\.js)"[^>]*>\s*<\/script>/i;
      const scriptMatch = html.match(scriptRe);
      if (!scriptMatch) {
        throw new Error('[fix-dist-html] dist/index.html に JS 参照が見つかりません');
      }

      const scriptSrc = './assets/app.js';
      const scriptTag = `<script defer src="${scriptSrc}"></script>`;
      html = html.replace(scriptMatch[0], '');
      html = html.replace(/<div id="root"><\/div>/, `<div id="root"></div>\n    ${scriptTag}`);

      writeFileSync(htmlPath, html);
    },
  };
}

export default defineConfig({
  base,
  plugins: [react(), fixDistHtml()],
  build: {
    cssCodeSplit: false,
    target: 'es2015',
    rollupOptions: {
      output: {
        format: 'iife',
        inlineDynamicImports: true,
        entryFileNames: 'assets/app.js',
        assetFileNames: 'assets/app[extname]',
      },
    },
  },
  test: {
    globals: false,
    environment: 'node',
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
  },
});
