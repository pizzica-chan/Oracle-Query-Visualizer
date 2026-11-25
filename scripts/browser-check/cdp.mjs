/**
 * Chrome DevTools Protocol（CDP）で、ヘッドレスの Chrome を操作する小さなドライバ。
 * 依存パッケージは使わず、Node 22 の組み込みの fetch と WebSocket だけで動く。
 * 通信先は、このスクリプトが起動した Chrome のデバッグ用ポート（127.0.0.1）だけ
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
];

export function findChrome() {
  const found = CHROME_CANDIDATES.find((path) => path && existsSync(path));
  if (!found) {
    throw new Error('Chrome が見つかりません。環境変数 CHROME_PATH に実行ファイルのパスを入れてください');
  }
  return found;
}

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function launch({ width = 1400, height = 820, dark = false } = {}) {
  const profile = mkdtempSync(join(tmpdir(), 'oqv-browser-check-'));
  const port = 9300 + Math.floor(Math.random() * 500);
  const args = [
    '--headless=new',
    '--disable-gpu',
    '--hide-scrollbars',
    '--no-first-run',
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    `--window-size=${width},${height}`,
  ];
  if (dark) args.push('--force-dark-mode');
  args.push('about:blank');
  const proc = spawn(findChrome(), args, { stdio: 'ignore' });
  const cleanup = async () => {
    proc.kill();
    await sleep(500);
    rmSync(profile, { recursive: true, force: true });
  };

  let ws;
  try {
    // 起動直後はデバッグ用ポートが開いていないか、ページの一覧が空のことがある。約 10 秒まで待つ
    let page;
    for (let i = 0; i < 50 && !page; i++) {
      try {
        const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
        page = targets.find((t) => t.type === 'page');
      } catch {
        // まだポートが開いていない
      }
      if (!page) await sleep(200);
    }
    if (!page) throw new Error('Chrome のページに接続できませんでした');

    ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      ws.addEventListener('open', resolve, { once: true });
      ws.addEventListener('error', () => reject(new Error('Chrome の WebSocket に接続できませんでした')), { once: true });
    });
  } catch (error) {
    // 接続に失敗しても、起動した Chrome と一時プロファイルを残さない
    await cleanup();
    throw error;
  }
  let nextId = 0;
  const pending = new Map();
  const events = [];
  ws.addEventListener('message', (event) => {
    const msg = JSON.parse(event.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(JSON.stringify(msg.error)));
      else resolve(msg.result);
    } else if (msg.method) {
      events.push(msg);
    }
  });
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = ++nextId;
      pending.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params }));
    });
  await send('Page.enable');
  await send('Runtime.enable');
  await send('Log.enable');

  const browser = {
    send,
    async goto(url, waitMs = 1500) {
      await send('Page.navigate', { url });
      await sleep(waitMs);
    },
    async eval(expression) {
      const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
      if (result.exceptionDetails) {
        const detail = result.exceptionDetails.exception?.description ?? result.exceptionDetails.text;
        throw new Error(`ページ内の式が失敗しました: ${detail}`);
      }
      return result.result.value;
    },
    async key(key, { code = key, keyCode = 0, modifiers = 0 } = {}) {
      await send('Input.dispatchKeyEvent', { type: 'keyDown', key, code, windowsVirtualKeyCode: keyCode, modifiers });
      await send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: keyCode, modifiers });
    },
    async click(selector) {
      const point = await browser.eval(`(() => {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
      })()`);
      if (!point) throw new Error(`要素が見つかりません: ${selector}`);
      for (const type of ['mousePressed', 'mouseReleased']) {
        await send('Input.dispatchMouseEvent', { type, x: point.x, y: point.y, button: 'left', clickCount: 1 });
      }
    },
    async screenshot(path, clip) {
      const result = await send('Page.captureScreenshot', { format: 'png', ...(clip ? { clip } : {}) });
      writeFileSync(path, Buffer.from(result.data, 'base64'));
    },
    /** ページで起きた例外と、コンソールのエラー・警告 */
    errors() {
      return events
        .filter(
          (e) =>
            e.method === 'Runtime.exceptionThrown' ||
            (e.method === 'Runtime.consoleAPICalled' && ['error', 'warning'].includes(e.params.type)) ||
            (e.method === 'Log.entryAdded' && e.params.entry.level === 'error'),
        )
        .map(
          (e) =>
            e.params.exceptionDetails?.exception?.description ??
            e.params.args?.map((a) => a.value ?? a.description).join(' ') ??
            e.params.entry?.text,
        );
    },
    async close() {
      try {
        await send('Browser.close');
      } catch {
        // すでに閉じていてもよい
      }
      await cleanup();
    },
  };
  return browser;
}
