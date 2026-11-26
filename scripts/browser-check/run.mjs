/**
 * 配布物（dist/index.html）を実際の Chrome で file:// から開いて操作し、画面の動きを確かめる。
 * happy-dom のテストでは確かめられないもの（Tab での字下げと Ctrl+Z、日本語の変換中の Tab、
 * クリップボード、同じタブで共有リンクを開く hashchange、行番号と文字の位置合わせ）を見る。
 *
 * 使い方: npm run check:browser（ビルドしてから実行する）
 *   スクリーンショットは一時フォルダに保存し、最後にその場所を表示する
 *   Chrome の場所は自動で探す。見つからなければ環境変数 CHROME_PATH で指定する
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { launch, sleep } from './cdp.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const APP_URL = pathToFileURL(join(root, 'dist/index.html')).href;
const STATE_KEY = 'oracle-query-visualizer:state:v1';
const outDir = mkdtempSync(join(tmpdir(), 'oqv-screens-'));

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${name}${detail && !ok ? ` — ${detail}` : ''}`);
}

/** 見えているタブ（非表示の JOIN 図を除く）の矢印マーカーで、参照先が見つからないもの */
const MISSING_MARKERS = `(() => [...document.querySelectorAll('.react-flow__edge-path')]
  .filter((p) => !p.closest('.tab-pane--hidden'))
  .map((p) => {
    const ref = p.getAttribute('marker-end');
    if (!ref) return null;
    const id = ref.replace(/^url\\(['"]?#/, '').replace(/['"]?\\)$/, '');
    return document.getElementById(id) ? null : id;
  })
  .filter(Boolean))()`;

const textarea = (index = 0) => `document.querySelectorAll('textarea')[${index}]`;

async function replaceText(b, text, index = 0) {
  await b.eval(`(() => { const t = ${textarea(index)}; t.focus(); t.select(); })()`);
  await b.send('Input.insertText', { text });
}

async function clickTab(b, label) {
  await b.eval(`[...document.querySelectorAll('.tab')].find((t) => t.textContent.includes(${JSON.stringify(label)}))?.click()`);
  await sleep(700);
}

async function editorChecks(b) {
  await b.goto(APP_URL);
  check('初期表示で例外が出ない', b.errors().length === 0, b.errors().join(' | '));

  await b.click('.welcome-state .sample-load-btn');
  await sleep(800);
  check('SELECT のサンプルを解析して表示する', await b.eval(`!!document.querySelector('.tab-bar')`));

  const lines = await b.eval(`({ lines: ${textarea()}.value.split('\\n').length, numbers: document.querySelectorAll('.sql-line').length })`);
  check('行番号の数が行数と一致する', lines.lines === lines.numbers, JSON.stringify(lines));
  const heights = await b.eval(`({ textarea: ${textarea()}.scrollHeight, layer: document.querySelector('.sql-highlight-layer').scrollHeight })`);
  check('textarea とハイライト層の内容の高さが一致する（折り返しを含む）', Math.abs(heights.textarea - heights.layer) <= 2, JSON.stringify(heights));

  // 位置合わせは目で確かめる。隠している textarea の文字を赤で見せ、ハイライト層の文字と重なるかを撮る
  await b.eval(`(() => { const t = ${textarea()}; t.style.webkitTextFillColor = 'rgba(255,0,0,0.6)'; t.scrollTop = 200; t.dispatchEvent(new Event('scroll')); })()`);
  await sleep(200);
  const box = await b.eval(`(() => { const r = document.querySelector('.sql-editor-body').getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: Math.min(r.height, 400), scale: 1.5 }; })()`);
  await b.screenshot(join(outDir, 'editor-overlay.png'), box);
  await b.eval(`(() => { const t = ${textarea()}; t.style.webkitTextFillColor = ''; t.scrollTop = 0; t.dispatchEvent(new Event('scroll')); })()`);

  // Tab / Ctrl+Z / Shift+Tab / Esc → Tab
  const original = await b.eval(`${textarea()}.value`);
  await b.eval(`(() => { const t = ${textarea()}; t.focus(); t.setSelectionRange(6, 6); })()`);
  await b.key('Tab', { keyCode: 9 });
  await sleep(100);
  const afterTab = await b.eval(`({ value: ${textarea()}.value, caret: ${textarea()}.selectionStart, focus: document.activeElement === ${textarea()} })`);
  check('Tab でカーソル位置に空白 2 つを入れ、フォーカスは残る', afterTab.value === `${original.slice(0, 6)}  ${original.slice(6)}` && afterTab.caret === 8 && afterTab.focus);
  await b.key('z', { code: 'KeyZ', keyCode: 90, modifiers: 2 });
  await sleep(100);
  check('Ctrl+Z で字下げを取り消せる', (await b.eval(`${textarea()}.value`)) === original);

  await b.eval(`(() => { const t = ${textarea()}; t.focus(); t.setSelectionRange(0, t.value.indexOf('\\n', t.value.indexOf('\\n') + 1)); })()`);
  await b.key('Tab', { keyCode: 9 });
  await sleep(100);
  const indented = await b.eval(`${textarea()}.value.split('\\n').slice(0, 3)`);
  check('複数行を選んだ Tab で、選んだ行だけを字下げする', indented[0].startsWith('  ') && indented[1].startsWith('    ') && indented[2] === original.split('\n')[2], JSON.stringify(indented));
  await b.key('Tab', { keyCode: 9, modifiers: 8 });
  await sleep(100);
  check('Shift+Tab で字下げを戻す', (await b.eval(`${textarea()}.value`)) === original);

  await b.eval(`${textarea()}.focus()`);
  await b.key('Escape', { keyCode: 27 });
  await b.key('Tab', { keyCode: 9 });
  await sleep(100);
  const escaped = await b.eval(`({ moved: document.activeElement !== ${textarea()}, value: ${textarea()}.value })`);
  check('Esc のあとの Tab は字下げせず、次の項目へフォーカスを移す', escaped.moved && escaped.value === original);

  // カーソル位置 → 右側の枠
  const offset = original.indexOf('order_items') + 3;
  await b.eval(`(() => { const t = ${textarea()}; t.focus(); t.setSelectionRange(${offset}, ${offset}); })()`);
  await b.key('ArrowRight', { keyCode: 39 });
  await sleep(300);
  check('カーソルを置いた語に対応する要素に枠が付く', await b.eval(`!!document.querySelector('.source-selectable--caret')`));

  // 右側のクリック → エディタの強調
  const target = await b.eval(`(() => {
    const el = [...document.querySelectorAll('.tab-content [data-span-start]')].find((e) => !e.closest('.tab-pane--hidden'));
    el.scrollIntoView({ block: 'center' });
    return el.dataset.spanStart;
  })()`);
  await b.click(`.tab-content [data-span-start="${target}"]`);
  await sleep(300);
  check('右側の要素をクリックすると、エディタの該当箇所を強調する', await b.eval(`!!document.querySelector('.sql-hl--focus')`));

  // 日本語の変換中の Tab
  await replaceText(b, 'SELECT a FROM t');
  await b.eval(`(() => { const t = ${textarea()}; t.setSelectionRange(15, 15); })()`);
  await b.send('Input.imeSetComposition', { text: 'てすと', selectionStart: 3, selectionEnd: 3 });
  await b.key('Tab', { keyCode: 9 });
  await sleep(100);
  check('日本語の変換中の Tab では空白を入れない', !(await b.eval(`${textarea()}.value`)).includes('  '));
  await b.send('Input.insertText', { text: '' });

  // 構文エラーと「該当箇所へ移動」
  await replaceText(b, 'SELECT a,\nFROM t\nWHERE x = 1');
  await sleep(800);
  const error = await b.eval(`({ line: document.querySelector('.sql-line--error')?.dataset.line, mark: !!document.querySelector('.sql-hl--error') })`);
  check('構文エラーの行番号を赤くし、該当箇所に印を付ける', error.line === '2' && error.mark, JSON.stringify(error));
  await b.click('.parse-error-jump');
  await sleep(200);
  const selection = await b.eval(`[${textarea()}.selectionStart, ${textarea()}.selectionEnd, document.activeElement === ${textarea()}]`);
  check('「該当箇所へ移動」でエラーの範囲を選ぶ', selection[2] && selection[0] < selection[1], JSON.stringify(selection));

  // Ctrl+Enter
  await replaceText(b, 'SELECT id FROM users');
  await b.key('Enter', { keyCode: 13, modifiers: 2 });
  await sleep(100);
  check('Ctrl+Enter で待たずに解析し、改行は入れない', (await b.eval(`!!document.querySelector('.tab-bar')`)) && (await b.eval(`${textarea()}.value`)) === 'SELECT id FROM users');

  // サンプルのボタンは入力中の SQL を置き換える。誤って押しても、前の SQL を取り戻せること
  await b.eval(`(() => { const x = [...document.querySelectorAll('.sql-editor .sample-load-btn')].find((x) => x.textContent.trim() === 'UPDATE'); x.focus(); x.click(); })()`);
  await sleep(500);
  const replaced = await b.eval(`({ value: ${textarea()}.value, notice: !!document.querySelector('.sql-editor-notice'), focusOnButton: document.activeElement.classList.contains('sample-load-btn'), ctrlZ: document.querySelector('.sql-editor-notice')?.textContent.includes('Ctrl+Z') })`);
  check('サンプルで置き換えたら「元に戻す」と Ctrl+Z の案内を出し、フォーカスはボタンに残す', replaced.value.startsWith('UPDATE') && replaced.notice && replaced.ctrlZ && replaced.focusOnButton, JSON.stringify(replaced).slice(0, 120));
  await b.eval(`${textarea()}.focus()`);
  await b.key('z', { code: 'KeyZ', keyCode: 90, modifiers: 2 });
  await sleep(500);
  check('サンプルで置き換えたあと、Ctrl+Z で前の SQL に戻せる', (await b.eval(`${textarea()}.value`)) === 'SELECT id FROM users' && !(await b.eval(`!!document.querySelector('.sql-editor-notice')`)));
}

async function samplesAndThemeChecks(b) {
  for (const label of ['SELECT', 'UNION', 'UPDATE', 'DELETE', '(+) 結合', 'CONNECT BY']) {
    await b.eval(`[...document.querySelectorAll('.sql-editor .sample-load-btn')].find((x) => x.textContent.trim() === '${label}').click()`);
    await sleep(900);
    for (const tab of ['SQL構造', '作用説明', 'JOIN', 'サブクエリ']) await clickTab(b, tab);
    check(`${label} のサンプルで全タブを表示する`, await b.eval(`!!document.querySelector('.tab-bar') && !document.querySelector('.error-state')`));
  }

  await b.eval(`[...document.querySelectorAll('.sql-editor .sample-load-btn')].find((x) => x.textContent.trim() === 'SELECT').click()`);
  await sleep(900);
  await clickTab(b, '作用説明');
  check('作用説明の別名に実テーブル名のツールチップがある', await b.eval(`document.querySelectorAll('.effect-hl--alias[title]').length > 0`));

  // タブは WAI-ARIA のタブの形。選んでいるタブから → で次のタブへ移り、フォーカスもそのタブへ移る
  await b.eval(`document.querySelector('.tab-list [aria-selected="true"]').focus()`);
  await b.key('ArrowRight', { code: 'ArrowRight', keyCode: 39 });
  await sleep(300);
  const tabKeys = await b.eval(`({ selected: document.querySelector('.tab-list [aria-selected="true"]')?.textContent, focused: document.activeElement?.textContent })`);
  check('解析結果のタブを → で切り替え、フォーカスも移る', tabKeys.selected === 'JOIN 図' && tabKeys.focused === 'JOIN 図', JSON.stringify(tabKeys));

  await clickTab(b, 'JOIN');
  await sleep(600);
  check('JOIN 図の矢印マーカーの参照先がある（ライト）', (await b.eval(MISSING_MARKERS)).length === 0);
  const minimapFill = await b.eval(`getComputedStyle(document.querySelector('.join-minimap .react-flow__minimap-node')).fill`);
  check('ライトテーマのミニマップのノードは濃い色で描く', !minimapFill.includes('107, 159, 212') && !minimapFill.includes('212, 176, 106'), minimapFill);
  await b.screenshot(join(outDir, 'join-light.png'));
  const lightStroke = await b.eval(`getComputedStyle(document.querySelector('.react-flow__edge-path')).stroke`);

  // カーソルをテーブル名に置いて JOIN 図のノードに枠を付ける
  const usersAt = await b.eval(`${textarea()}.value.indexOf('FROM users u') + 6`);
  await b.eval(`(() => { const t = ${textarea()}; t.focus(); t.setSelectionRange(${usersAt}, ${usersAt}); })()`);
  await b.key('ArrowRight', { keyCode: 39 });
  await sleep(300);
  const caretNode = await b.eval(`document.querySelector('.table-node.source-selectable--caret')?.textContent ?? null`);
  check('カーソルを置いたテーブルの JOIN 図のノードに枠が付く', caretNode !== null, String(caretNode));
  // 枠の付いたノードそのものをクリックして、JOIN 図でそのノードを選んだ状態にする（このクリックは App の状態も変える）。
  // 選ぶと className に強調のクラスが付き、選択を外すと消えるので、そのノードの className が付け直される
  await b.eval(`document.querySelector('.table-node.source-selectable--caret').click()`);
  await sleep(300);
  check('JOIN 図でノードを選ぶと、そのノードを強調する', await b.eval(`!!document.querySelector('.join-diagram--has-focus .table-node.source-selectable--caret[class*="join-focus"]')`));
  // 図の空き部分（左上の隅）をクリックして選択を外す。変わるのは JOIN 図の中の状態だけで、App は描き直さない。
  // ノードの className が付け直されても、カーソル連動の枠が消えないことを確かめる
  const pane = await b.eval(`(() => { const r = document.querySelector('.tab-pane:not(.tab-pane--hidden) .react-flow__pane').getBoundingClientRect(); return { x: r.x + 12, y: r.y + 12 }; })()`);
  for (const type of ['mousePressed', 'mouseReleased']) {
    await b.send('Input.dispatchMouseEvent', { type, x: pane.x, y: pane.y, button: 'left', clickCount: 1 });
  }
  await sleep(300);
  check('JOIN 図の中だけが描き直しても、カーソル連動の枠が残る', await b.eval(`!document.querySelector('.join-diagram--has-focus') && !!document.querySelector('.table-node.source-selectable--caret')`));

  await b.eval(`(() => { document.querySelector('.app-theme-btn[data-theme-value="dark"]').click(); })()`);
  await sleep(500);
  const darkStroke = await b.eval(`getComputedStyle(document.querySelector('.react-flow__edge-path')).stroke`);
  check('配色をダークに切り替えると、JOIN 図の線の色も変わる', (await b.eval(`document.documentElement.dataset.theme`)) === 'dark' && darkStroke !== lightStroke);
  check('JOIN 図の矢印マーカーの参照先がある（ダーク）', (await b.eval(MISSING_MARKERS)).length === 0);
  await b.screenshot(join(outDir, 'join-dark.png'));

  await b.goto(APP_URL);
  const restored = await b.eval(`({ theme: document.documentElement.dataset.theme, sql: !!${textarea()}?.value })`);
  check('リロードで SQL と配色を復元する', restored.theme === 'dark' && restored.sql, JSON.stringify(restored));
}

async function shareChecks(b) {
  await replaceText(b, 'SELECT id FROM users WHERE x = 1');
  await b.key('Enter', { keyCode: 13, modifiers: 2 });
  await sleep(300);
  await b.click('.app-share-btn');
  await sleep(500);
  const link = await b.eval(`navigator.clipboard.readText().catch((e) => 'ERR ' + e.message)`);
  check('「リンクをコピー」で共有リンクをクリップボードに入れる', link.includes('#q='), link.slice(0, 80));
  if (!link.includes('#q=')) return;

  // 自分の SQL を入れ、保存の待ち時間を待たずに同じタブでリンクを開く（hashchange）
  await replaceText(b, 'SELECT mine FROM t');
  await b.goto(link, 800);
  const opened = await b.eval(`({ sql: ${textarea()}?.value, hash: location.hash })`);
  check('同じタブで共有リンクを開くと、その SQL を読み込んで # を消す', opened.sql === 'SELECT id FROM users WHERE x = 1' && opened.hash === '', JSON.stringify(opened));
  const saved = await b.eval(`JSON.parse(localStorage.getItem('${STATE_KEY}'))`);
  check('リンクを開く直前の自分の入力を保存している', saved.sql === 'SELECT mine FROM t', JSON.stringify(saved));
  await b.goto(APP_URL);
  check('リロードすると自分の SQL に戻る', (await b.eval(`${textarea()}.value`)) === 'SELECT mine FROM t');
}

async function joinSpanChecks(b) {
  // テーブルや結合の形が変わらない編集では JOIN 図の配置を作り直さない。そのあいだもノードが指す SQL の範囲は新しくする
  await replaceText(b, 'SELECT mine FROM t');
  await b.key('Enter', { keyCode: 13, modifiers: 2 });
  await clickTab(b, 'JOIN');
  await replaceText(b, 'SELECT shared, edited FROM t');
  await b.key('Enter', { keyCode: 13, modifiers: 2 });
  await sleep(500);
  const span = await b.eval(`(() => { const n = document.querySelector('.tab-pane:not(.tab-pane--hidden) .table-node[data-span-start]'); return n ? [Number(n.dataset.spanStart), Number(n.dataset.spanEnd)] : null; })()`);
  const sql = 'SELECT shared, edited FROM t';
  check('SQL を編集したあとも、JOIN 図のノードは新しい SQL のテーブルの位置を指す', span !== null && sql.slice(span[0], span[1]) === 't', JSON.stringify(span));
}

async function layoutChecks(b) {
  await b.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 800, deviceScaleFactor: 1, mobile: true });
  await sleep(500);
  const width = await b.eval(`({ page: document.documentElement.scrollWidth, window: window.innerWidth })`);
  check('幅 390px で横にはみ出さない', width.page <= width.window + 1, JSON.stringify(width));
  // 幅が足りないとき、タブの並びの表示オプションが縮み、1 文字ごとに改行して表示されていた
  const option = await b.eval(`(() => { const el = document.querySelector('.tab-bar-options span'); return el ? { height: el.getBoundingClientRect().height, lineHeight: parseFloat(getComputedStyle(el).lineHeight) } : null; })()`);
  check('幅 390px でも、タブの並びの表示オプションは 1 行で出す', option !== null && option.height <= option.lineHeight * 1.5, JSON.stringify(option));
  await b.screenshot(join(outDir, 'mobile.png'));
}

const b = await launch();
try {
  await b.send('Browser.grantPermissions', { permissions: ['clipboardReadWrite', 'clipboardSanitizedWrite'] });
  await editorChecks(b);
  await samplesAndThemeChecks(b);
  await shareChecks(b);
  await joinSpanChecks(b);
  await layoutChecks(b);
  check('操作の全体を通して例外とコンソールのエラーが出ない', b.errors().length === 0, b.errors().slice(0, 5).join(' | '));
} catch (error) {
  check('シナリオを最後まで実行する', false, error.stack);
} finally {
  await b.close();
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length} / ${results.length} 件 OK`);
console.log(`スクリーンショット: ${outDir}`);
process.exit(failed.length > 0 ? 1 : 0);
