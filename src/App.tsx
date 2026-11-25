import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AnalysisResult, type TabId } from './components/AnalysisResult';
import { IconLink, IconMonitor, IconMoon, IconSpinner, IconSun, LogoMark } from './components/Icons';
import { SqlEditor, type EditorStatus } from './components/SqlEditor';
import { WelcomePanel } from './components/WelcomePanel';
import { useCaretSourceLink } from './hooks/useCaretSourceLink';
import { useThemePreference } from './hooks/useTheme';
import { applyAliasResolution } from './lib/alias-resolver';
import {
  decodeSharePayload,
  encodeSharePayload,
  isShareFragment,
  readStoredState,
  safeLocalStorage,
  writeStoredState,
  type PersistedAppState,
  type SharePayload,
} from './lib/app-persistence';
import {
  SAMPLE_SQL,
  UPDATE_SAMPLE_SQL,
  DELETE_SAMPLE_SQL,
  UNION_SAMPLE_SQL,
  LEGACY_JOIN_SAMPLE_SQL,
  HIERARCHICAL_SAMPLE_SQL,
  parseOracleQuery,
} from './lib/parser';
import { collectSubqueryRefsExcludingUnionBranches, type SubqueryRef } from './lib/query-utils';
import { setThemePreference, type ThemePreference } from './lib/theme';
import type { ParseError, ParsedQuery, SourceSpan } from './lib/types';
import type { OnSourceSpanSelect } from './lib/source-link';

const BASE_TABS: { id: TabId; label: string }[] = [
  { id: 'structure', label: 'SQL構造' },
  { id: 'narrative', label: '作用説明' },
  { id: 'joins', label: 'JOIN 図' },
];

const THEME_OPTIONS: { value: ThemePreference; label: string; icon: typeof IconSun }[] = [
  { value: 'system', label: '自動（OS の設定に従う）', icon: IconMonitor },
  { value: 'light', label: 'ライト', icon: IconSun },
  { value: 'dark', label: 'ダーク', icon: IconMoon },
];

/** 入力から解析までの待ち時間 */
const PARSE_DEBOUNCE_MS = 400;
/** 入力を localStorage へ書くまでの待ち時間。キー入力のたびに書かないようにする */
const SAVE_DEBOUNCE_MS = 300;
/** 共有リンクのコピー結果を表示しておく時間 */
const SHARE_STATUS_MS = 4000;

interface ParseOutcome {
  /** 解析した SQL。入力と一致するときだけ結果を使う（デバウンス中の stale 防止） */
  from: string;
  query: ParsedQuery | null;
  error?: ParseError;
}

const EMPTY_OUTCOME: ParseOutcome = { from: '', query: null };

/** エディタの下のステータスバーに出す解析の状態 */
function editorStatus(sql: string, outcome: ParseOutcome): EditorStatus {
  if (!sql.trim()) return 'empty';
  if (outcome.from !== sql) return 'pending';
  return outcome.error ? 'error' : 'ok';
}

/** 未入力は解析エラーではない。エラーにすると、サンプル読み込みの案内が「解析エラー」に置き換わる */
function parseOutcome(sql: string): ParseOutcome {
  if (!sql.trim()) return EMPTY_OUTCOME;
  const result = parseOracleQuery(sql);
  return result.success
    ? { from: sql, query: result.query }
    : { from: sql, query: null, error: result.error };
}

export default function App() {
  // 前回の入力を復元する。保存できない環境では空から始まる
  const [initialState] = useState(() => readStoredState(safeLocalStorage()));

  const [sql, setSql] = useState(initialState.sql ?? '');
  // 復元した SQL は最初の描画の前に解析する。解析の待ち時間（400ms）を待つと、SQL が入っているのに
  // 右側に「SQL を入力して解析を始めましょう」が一瞬出る
  const [single, setSingle] = useState<ParseOutcome>(() => parseOutcome(initialState.sql ?? ''));
  const [activeTab, setActiveTab] = useState<TabId>('structure');
  const [resolveAliases, setResolveAliases] = useState(initialState.resolveAliases ?? false);
  const [activeSourceSpan, setActiveSourceSpan] = useState<SourceSpan | null>(null);
  const [caretOffset, setCaretOffset] = useState<number | null>(null);

  const [shareStatus, setShareStatus] = useState<string | null>(null);
  /** クリップボードに書けなかったときに、手でコピーしてもらう URL */
  const [shareFallbackUrl, setShareFallbackUrl] = useState<string | null>(null);
  const themePreference = useThemePreference();

  const outputRef = useRef<HTMLElement>(null);
  /**
   * 共有リンクを読み込んだ直後の、保存する値の全体。今の値がこれと同じあいだ（利用者が何も変えていないあいだ）は保存を止める。
   * SQL だけで比べると、表示の切り替えが保存されなくなる
   */
  const sharedSnapshotRef = useRef<PersistedAppState | null>(null);
  /** 保存する入力の最新の値。イベントの処理の中から、描画を待たずに保存するのに使う */
  const latestStateRef = useRef<PersistedAppState>({ sql, resolveAliases });
  latestStateRef.current = { sql, resolveAliases };

  const parsed = single.query;
  const error = single.error;

  const handleSourceSpanSelect: OnSourceSpanSelect = useCallback((span) => {
    setActiveSourceSpan(span ?? null);
  }, []);

  // 自己結合の別名は残す。u1 / u2 を同じ実テーブル名へ潰すと
  // 「users の行をすべて残し users を LEFT JOIN」のように説明が意味をなさなくなる。
  // どの実テーブルかはテーブルラベル（users（u1））が併記するので情報は失われない
  const displayQuery = useMemo(
    () =>
      parsed ? applyAliasResolution(parsed, resolveAliases, { keepSelfJoinAliases: true }) : null,
    [parsed, resolveAliases],
  );

  const nestedInfo = useMemo(() => {
    if (!displayQuery) return { showTab: false, subqueries: [] as SubqueryRef[] };
    const subqueries = collectSubqueryRefsExcludingUnionBranches(displayQuery);
    return {
      showTab: subqueries.length > 0,
      subqueries,
    };
  }, [displayQuery]);

  const tabs = useMemo(() => {
    if (!nestedInfo.showTab) return BASE_TABS;
    return [
      ...BASE_TABS,
      { id: 'nested' as const, label: 'サブクエリ' },
    ];
  }, [nestedInfo.showTab]);

  // 解析済みの SQL と同じなら解析し直さない。Ctrl+Enter で解析したあとや、起動時に復元した SQL を解析したあとにも、
  // 入力の待ち時間（400ms）が過ぎるとまた解析するので、同じ SQL を 2 回解析することになる
  const runParse = useCallback(() => setSingle((prev) => (prev.from === sql ? prev : parseOutcome(sql))), [sql]);

  useEffect(() => {
    const timer = setTimeout(runParse, PARSE_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [sql, runParse]);

  useEffect(() => {
    setActiveSourceSpan(null);
  }, [sql]);

  useEffect(() => {
    if (activeTab === 'nested' && !nestedInfo.showTab) {
      setActiveTab('structure');
    }
  }, [activeTab, nestedInfo.showTab]);

  // 入力を保存し、リロードしても続きから使えるようにする
  useEffect(() => {
    // 共有リンクで読み込んだ SQL は、編集されるまで保存しない。
    // 開いただけで保存すると、利用者が保存していた自分の SQL が他人の SQL に置き換わって戻せなくなる
    const snapshot = sharedSnapshotRef.current;
    if (snapshot) {
      const untouched = sql === snapshot.sql && resolveAliases === snapshot.resolveAliases;
      if (untouched) return;
      sharedSnapshotRef.current = null;
    }
    const timer = setTimeout(() => {
      writeStoredState(safeLocalStorage(), { sql, resolveAliases });
    }, SAVE_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [sql, resolveAliases]);

  // 共有リンク（#q=...）で開かれたら、その SQL を読み込む。保存してあった入力より優先して表示する。
  // 起動時のほか、アプリを開いたタブでリンクを開いたときも読む。同じページで # 以降だけが変わる移動は
  // ページを読み込み直さず hashchange だけが起きるので、起動時に 1 回読むだけではリンクを無視してしまう
  useEffect(() => {
    if (typeof window === 'undefined') return;
    let cancelled = false;
    const loadFromHash = () => {
      const hash = window.location.hash;
      if (!hash) return;
      void decodeSharePayload(hash).then((payload) => {
        if (cancelled) return;
        if (payload) {
          applySharedPayload(payload);
        } else if (isShareFragment(hash)) {
          // 何も出さないと、リンクを開いたのに前の SQL のままになっている理由が分からない
          setShareStatus('共有リンクの SQL を読み込めませんでした。リンクの一部が欠けているか、このブラウザでは開けない形式です');
        }
      });
    };
    const applySharedPayload = (payload: SharePayload) => {
      // 入力の保存は 300ms 待ってから書くので、その間に差し替えると直前の編集が保存されない。先に書いておく
      if (!sharedSnapshotRef.current) writeStoredState(safeLocalStorage(), latestStateRef.current);
      sharedSnapshotRef.current = { ...latestStateRef.current, sql: payload.sql };
      setSql(payload.sql);
      setShareStatus('共有リンクの SQL を読み込みました（編集するまで保存しません）');
      // フラグメントを消す。残すと、編集してからリロードしたときに共有時の SQL に戻ってしまう
      try {
        window.history.replaceState(null, '', window.location.pathname + window.location.search);
      } catch {
        // file:// などで履歴を書き換えられなくても、読み込みはできている
      }
    };
    loadFromHash();
    window.addEventListener('hashchange', loadFromHash);
    return () => {
      cancelled = true;
      window.removeEventListener('hashchange', loadFromHash);
    };
  }, []);

  useEffect(() => {
    if (!shareStatus) return;
    const timer = setTimeout(() => setShareStatus(null), SHARE_STATUS_MS);
    return () => clearTimeout(timer);
  }, [shareStatus]);

  // 入力が変わったら、手でコピーする用の URL を消す。古い SQL の URL をコピーさせないため
  useEffect(() => {
    setShareFallbackUrl(null);
  }, [sql]);

  // カーソル位置に対応する右側の要素を枠で囲む。入力中は解析結果の位置が古いので、解析結果が今の入力と一致するときだけにする
  useCaretSourceLink(outputRef, single.from === sql ? caretOffset : null);

  const canShare = sql.trim().length > 0;

  const handleShare = useCallback(async () => {
    const fragment = await encodeSharePayload({ sql });
    const url = `${window.location.href.split('#')[0]}#${fragment}`;
    try {
      await navigator.clipboard.writeText(url);
      setShareFallbackUrl(null);
      setShareStatus('SQL 入りのリンクをコピーしました');
    } catch {
      // クリップボードを使えない環境（file:// の一部のブラウザなど）では、URL を表示して手でコピーしてもらう
      setShareFallbackUrl(url);
      setShareStatus(null);
    }
  }, [sql]);

  return (
    <div className="app">
      <header className="app-header">
        <div className="app-header-inner">
          <div className="app-brand">
            <LogoMark size={30} />
            <div className="app-brand-text">
              <h1 className="app-title">Oracle Query Visualizer</h1>
              <p className="app-tagline">Oracle Database の SQL の構造・JOIN・作用を、ブラウザの中だけで解析</p>
            </div>
          </div>
          <div className="app-header-actions">
            <div className="app-header-tools">
              {shareStatus && (
                <span className="app-share-status" role="status">
                  {shareStatus}
                </span>
              )}
              {shareFallbackUrl && (
                <input
                  className="app-share-fallback"
                  readOnly
                  value={shareFallbackUrl}
                  aria-label="共有リンク（選択してコピーしてください）"
                  onFocus={(e) => e.currentTarget.select()}
                  autoFocus
                />
              )}
              <button
                type="button"
                className="btn btn--ghost btn--small app-share-btn"
                onClick={() => void handleShare()}
                disabled={!canShare}
                title="入力中の SQL を URL の # 以降に入れたリンクを作ります。# 以降はサーバーに送られません"
              >
                <IconLink size={14} />
                リンクをコピー
              </button>
              <div className="app-theme-switch" role="group" aria-label="配色">
                {THEME_OPTIONS.map(({ value, label, icon: ThemeIcon }) => (
                  <button
                    key={value}
                    type="button"
                    aria-pressed={themePreference === value}
                    aria-label={`配色: ${label}`}
                    title={`配色: ${label}`}
                    data-theme-value={value}
                    className={`app-theme-btn${themePreference === value ? ' app-theme-btn--active' : ''}`}
                    onClick={() => setThemePreference(value)}
                  >
                    <ThemeIcon size={15} />
                  </button>
                ))}
              </div>
            </div>
          </div>
        </div>
      </header>

      <main className="app-main">
        <section className="panel panel--input">
          <SqlEditor
            value={sql}
            onChange={setSql}
            error={error?.message}
            errorSpan={single.from === sql ? error?.span : undefined}
            focusSpan={activeSourceSpan}
            onCaretChange={setCaretOffset}
            onRunNow={runParse}
            status={editorStatus(sql, single)}
          />
        </section>

        <section className="panel panel--output" ref={outputRef}>
          {/*
            解析前の案内は SQL が空のときだけ出す。「解析結果もエラーも無い」で判断すると、
            入力し始めた直後の解析待ち（400ms）にも案内が一瞬出る
          */}
          {!parsed && !error && !sql.trim() && (
            <WelcomePanel
              onSelect={() => setSql(SAMPLE_SQL)}
              onUpdate={() => setSql(UPDATE_SAMPLE_SQL)}
              onUnion={() => setSql(UNION_SAMPLE_SQL)}
              onDelete={() => setSql(DELETE_SAMPLE_SQL)}
              onLegacyJoin={() => setSql(LEGACY_JOIN_SAMPLE_SQL)}
              onHierarchical={() => setSql(HIERARCHICAL_SAMPLE_SQL)}
            />
          )}
          {!parsed && !error && sql.trim() && (
            <div className="pending-state" role="status">
              <IconSpinner size={18} />
              解析中…
            </div>
          )}

          {parsed && displayQuery && (
            <AnalysisResult
              query={displayQuery}
              tabs={tabs}
              activeTab={activeTab}
              onTabChange={setActiveTab}
              subqueries={nestedInfo.subqueries}
              resolveAliases={resolveAliases}
              onResolveAliasesChange={setResolveAliases}
              activeSourceSpan={activeSourceSpan}
              onSourceSpanSelect={handleSourceSpanSelect}
            />
          )}

          {error && !parsed && (
            <div className="error-state">
              <h2>解析エラー</h2>
              <p className="error-message">{error.message}</p>
              {error.detail && (
                <details className="error-detail">
                  <summary>パーサーの詳細（期待していた字句の一覧）</summary>
                  <code>{error.detail}</code>
                </details>
              )}
              <p className="error-hint">
                Oracle 形式の SELECT / UPDATE / DELETE 文を入力してください。INSERT / MERGE など上記以外の文種は未対応です。
              </p>
            </div>
          )}
        </section>
      </main>
    </div>
  );
}
