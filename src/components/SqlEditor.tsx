import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from 'react';
import { computeIndentEdit, type IndentEdit } from '../lib/editor-indent';
import {
  DELETE_SAMPLE_SQL,
  HIERARCHICAL_SAMPLE_SQL,
  LEGACY_JOIN_SAMPLE_SQL,
  SAMPLE_SQL,
  UNION_SAMPLE_SQL,
  UPDATE_SAMPLE_SQL,
  lineColumnAt,
} from '../lib/parser';
import { IconAlert, IconCheckCircle, IconSpinner } from './Icons';
import { highlightSqlToLineHtml } from '../lib/sql-highlight';
import type { SourceSpan } from '../lib/types';
import { SampleLoadButtons } from './SampleLoadButtons';

interface SqlEditorProps {
  value: string;
  onChange: (value: string) => void;
  error?: string;
  /** 構文エラーの範囲。該当箇所に波線を引き、行番号を赤くする */
  errorSpan?: SourceSpan;
  focusSpan?: SourceSpan | null;
  /** エディタ上部のラベル */
  label?: string;
  /** サンプル読込ボタンを表示するか（デフォルト true） */
  showSamples?: boolean;
  /** カーソル位置（選択の始点）が動いたとき */
  onCaretChange?: (offset: number | null) => void;
  /** Ctrl+Enter（Mac は Cmd+Enter）で、入力の待ち時間を待たずに解析する */
  onRunNow?: () => void;
  /** 解析の状態。エディタの下のステータスバーに出す */
  status?: EditorStatus;
}

export type EditorStatus = 'empty' | 'pending' | 'ok' | 'error';

const MODIFIER_KEYS = new Set(['Shift', 'Control', 'Alt', 'Meta']);

const STATUS_LABELS: Record<EditorStatus, string> = {
  empty: '未入力',
  pending: '解析中…',
  ok: '解析済み',
  error: '構文エラー',
};

function lineIndexAt(text: string, offset: number): number {
  return text.slice(0, offset).split('\n').length - 1;
}

export function SqlEditor({
  value,
  onChange,
  error,
  errorSpan,
  focusSpan = null,
  label,
  showSamples = true,
  onCaretChange,
  onRunNow,
  status,
}: SqlEditorProps) {
  const [caret, setCaret] = useState({ line: 1, column: 1 });
  const highlightRef = useRef<HTMLPreElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  /** onChange で値を差し替えたあと、描画が終わってから戻す選択範囲 */
  const pendingSelectionRef = useRef<{ start: number; end: number } | null>(null);
  /** Esc の直後の Tab だけは字下げせず、通常どおりフォーカスを移す（キーボードだけで抜けられるように） */
  const tabReleasedRef = useRef(false);
  /**
   * サンプルで置き換える前の SQL。「元に戻す」を出しているあいだだけ持つ。
   * nativeUndo は、ブラウザの「元に戻す」（Ctrl+Z）の履歴に残せたか
   */
  const [replaced, setReplaced] = useState<{ previous: string; inserted: string; nativeUndo: boolean } | null>(
    null,
  );
  const hintId = useId();
  const errorId = useId();

  const lines = useMemo(
    () => highlightSqlToLineHtml(value, { focus: focusSpan ?? undefined, error: errorSpan }),
    [value, focusSpan, errorSpan],
  );
  const errorLine = errorSpan ? lineIndexAt(value, errorSpan.start) : -1;

  const syncScroll = useCallback((target: HTMLTextAreaElement) => {
    const layer = highlightRef.current;
    if (!layer) return;
    layer.scrollTop = target.scrollTop;
    layer.scrollLeft = target.scrollLeft;
  }, []);

  /**
   * offset の行がエディタの上から 35% あたりに来るようにスクロールする。
   * 行の高さは折り返しで変わるので、ハイライト層の行要素の位置を実測する
   */
  const scrollToOffset = useCallback(
    (offset: number) => {
      const textarea = textareaRef.current;
      if (!textarea) return;
      const line = lineIndexAt(textarea.value, offset);
      const lineEl = highlightRef.current?.querySelector<HTMLElement>(`[data-line="${line + 1}"]`);
      const lineHeight = parseFloat(getComputedStyle(textarea).lineHeight) || 22;
      const lineTop = lineEl ? lineEl.offsetTop : line * lineHeight;
      textarea.scrollTop = Math.max(0, lineTop - textarea.clientHeight * 0.35);
      syncScroll(textarea);
    },
    [syncScroll],
  );

  useEffect(() => {
    if (focusSpan) scrollToOffset(focusSpan.start);
  }, [focusSpan, scrollToOffset]);

  useLayoutEffect(() => {
    const pending = pendingSelectionRef.current;
    const textarea = textareaRef.current;
    if (!pending || !textarea) return;
    pendingSelectionRef.current = null;
    textarea.setSelectionRange(pending.start, pending.end);
  }, [value]);

  // 値が変わったら、カーソル位置を読み直す。サンプルの読み込みや共有リンクのように入力以外で SQL を
  // 差し替えると onSelect が起きないので、古い位置のまま行・列を表示し、右側の別の要素に枠を付けてしまう。
  // エディタにフォーカスが無いとき（ボタンで差し替えたとき）は、カーソル連動を止める
  useEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    const offset = Math.min(textarea.selectionStart, value.length);
    setCaret(lineColumnAt(value, offset));
    onCaretChange?.(document.activeElement === textarea ? offset : null);
    // onCaretChange は呼び出し元の setState で、値が変わったときだけ読み直せばよい
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  // 置き換えたあとに編集したり、共有リンクなどで別の SQL に差し替わったりしたら「元に戻す」を消す。
  // 残すと、編集した内容まで置き換え前の SQL に戻してしまう
  useEffect(() => {
    if (replaced && value !== replaced.inserted) setReplaced(null);
  }, [value, replaced]);

  const applyEdit = useCallback(
    (textarea: HTMLTextAreaElement, edit: IndentEdit) => {
      // execCommand で入れると、ブラウザの「元に戻す」（Ctrl+Z）で字下げを取り消せる。
      // 使えない環境では値を直接差し替える（この場合は元に戻す履歴に残らない）
      textarea.setSelectionRange(edit.replaceStart, edit.replaceEnd);
      let inserted = false;
      try {
        inserted = document.execCommand?.('insertText', false, edit.insertText) ?? false;
      } catch {
        inserted = false;
      }
      if (inserted && textarea.value === edit.value) {
        textarea.setSelectionRange(edit.selectionStart, edit.selectionEnd);
        return;
      }
      pendingSelectionRef.current = { start: edit.selectionStart, end: edit.selectionEnd };
      onChange(edit.value);
    },
    [onChange],
  );

  /**
   * SQL 全体を text に置き換える。execCommand で入れると、ブラウザの「元に戻す」（Ctrl+Z）で前の SQL に戻せる。
   * 値を直接差し替えると元に戻す履歴が消え、さらに 300ms 後には保存も上書きされるので、入力していた SQL を取り戻せない。
   * フォーカスは置き換える前の要素（押したボタン）に戻す。エディタに残すと、カーソル連動が働いて右側に枠が付く。
   * 返り値は、ブラウザの「元に戻す」の履歴に残せたか（execCommand を使えない環境では値を直接差し替える）
   */
  const replaceAll = useCallback(
    (text: string): boolean => {
      const textarea = textareaRef.current;
      if (!textarea || textarea.value === text) return false;
      const returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      textarea.focus({ preventScroll: true });
      textarea.setSelectionRange(0, textarea.value.length);
      let inserted = false;
      try {
        inserted = document.execCommand?.('insertText', false, text) ?? false;
      } catch {
        inserted = false;
      }
      const nativeUndo = inserted && textarea.value === text;
      if (nativeUndo) {
        textarea.setSelectionRange(0, 0);
      } else {
        pendingSelectionRef.current = { start: 0, end: 0 };
        onChange(text);
      }
      textarea.scrollTop = 0;
      syncScroll(textarea);
      if (returnFocus && returnFocus !== textarea) returnFocus.focus({ preventScroll: true });
      return nativeUndo;
    },
    [onChange, syncScroll],
  );

  const loadSample = useCallback(
    (text: string) => {
      const previous = textareaRef.current?.value ?? value;
      if (previous === text) return;
      const nativeUndo = replaceAll(text);
      // 空の入力を置き換えたときは、戻す先が無いので出さない
      setReplaced(previous.trim() ? { previous, inserted: text, nativeUndo } : null);
    },
    [replaceAll, value],
  );

  const undoReplace = useCallback(() => {
    if (!replaced) return;
    setReplaced(null);
    replaceAll(replaced.previous);
    textareaRef.current?.focus();
  }, [replaced, replaceAll]);

  const handleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLTextAreaElement>) => {
      // 日本語の変換中のキーは IME に任せる。変換候補を選ぶ Tab を横取りすると、変換中の文字に字下げの空白が入る。
      // keyCode 229 は、isComposing を立てずに変換中のキーを送るブラウザ向け
      if (event.nativeEvent.isComposing || event.keyCode === 229) return;
      if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
        event.preventDefault();
        onRunNow?.();
        return;
      }
      if (event.key === 'Escape') {
        tabReleasedRef.current = true;
        return;
      }
      // 修飾キーだけの押下では Esc の印を消さない。消すと、Esc のあとの Shift+Tab で
      // Shift を押した時点で印が消え、Tab が字下げを戻す操作になって前の項目へ戻れない
      if (MODIFIER_KEYS.has(event.key)) return;
      if (event.key === 'Tab' && !event.ctrlKey && !event.altKey && !event.metaKey) {
        if (tabReleasedRef.current) {
          tabReleasedRef.current = false;
          return;
        }
        event.preventDefault();
        const textarea = event.currentTarget;
        const edit = computeIndentEdit(
          textarea.value,
          textarea.selectionStart,
          textarea.selectionEnd,
          event.shiftKey,
        );
        if (edit) applyEdit(textarea, edit);
        return;
      }
      tabReleasedRef.current = false;
    },
    [applyEdit, onRunNow],
  );

  const jumpToError = useCallback(() => {
    const textarea = textareaRef.current;
    if (!textarea || !errorSpan) return;
    textarea.focus();
    textarea.setSelectionRange(errorSpan.start, errorSpan.end);
    scrollToOffset(errorSpan.start);
  }, [errorSpan, scrollToOffset]);

  return (
    <div className="sql-editor">
      {(label || showSamples) && (
        <div className="sql-editor-toolbar">
          <span className="sql-editor-label">{label ?? 'SQL'}</span>
          {showSamples && (
            <SampleLoadButtons
              onSelect={() => loadSample(SAMPLE_SQL)}
              onUpdate={() => loadSample(UPDATE_SAMPLE_SQL)}
              onUnion={() => loadSample(UNION_SAMPLE_SQL)}
              onDelete={() => loadSample(DELETE_SAMPLE_SQL)}
              onLegacyJoin={() => loadSample(LEGACY_JOIN_SAMPLE_SQL)}
              onHierarchical={() => loadSample(HIERARCHICAL_SAMPLE_SQL)}
            />
          )}
        </div>
      )}
      <div className={`sql-editor-card${error ? ' sql-editor-card--error' : ''}`}>
      <div className={`sql-editor-body${error ? ' sql-editor-body--error' : ''}`}>
        <pre ref={highlightRef} className="sql-highlight-layer" aria-hidden="true">
          <code>
            {lines.map((html, index) => (
              <span
                key={index}
                className={`sql-line${index === errorLine ? ' sql-line--error' : ''}`}
                data-line={index + 1}
                dangerouslySetInnerHTML={{ __html: html }}
              />
            ))}
          </code>
        </pre>
        <textarea
          ref={textareaRef}
          className="sql-textarea sql-textarea--highlight"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onScroll={(e) => syncScroll(e.currentTarget)}
          onKeyDown={handleKeyDown}
          // フォーカスが外れたら Esc の印を消す。残すと、あとで戻ってきたときの Tab が字下げにならない
          onBlur={() => {
            tabReleasedRef.current = false;
          }}
          onSelect={(e) => {
            const target = e.currentTarget;
            setCaret(lineColumnAt(target.value, target.selectionStart));
            onCaretChange?.(target.selectionStart);
          }}
          placeholder="SELECT / UPDATE / DELETE ..."
          spellCheck={false}
          aria-label={label ?? 'SQL'}
          // エラーの表示中は、説明の参照先をエラーの表示にする（操作の案内より先に読んでほしいため）
          aria-describedby={error ? errorId : hintId}
        />
      </div>
      <div className="sql-editor-statusbar">
        {status && (
          // role="status" にすると、入力のたびに「解析中…」「解析済み」が読み上げられるので付けない
          <span className={`sql-status sql-status--${status}`}>
            {status === 'ok' && <IconCheckCircle size={13} />}
            {status === 'error' && <IconAlert size={13} />}
            {status === 'pending' && <IconSpinner size={13} />}
            {STATUS_LABELS[status]}
          </span>
        )}
        <span className="sql-editor-position">
          行 {caret.line}, 列 {caret.column}
        </span>
        <span className="sql-editor-keys" id={hintId}>
          <kbd>Ctrl</kbd>+<kbd>Enter</kbd> 今すぐ解析
          <span className="sql-editor-keys-sep" aria-hidden="true" />
          <kbd>Tab</kbd> 字下げ
          <span className="visually-hidden">。Esc を押してから Tab を押すと、次の項目へ移動します</span>
        </span>
      </div>
      </div>
      {/* 置き換えの知らせは読み上げたいので、領域は常に置いておき、中身だけを出し入れする */}
      <div className="sql-editor-notice-region" role="status">
        {replaced && (
          <div className="sql-editor-notice">
            <span className="sql-editor-notice-text">
              {replaced.nativeUndo
                ? 'サンプルの SQL に置き換えました。前の SQL は「元に戻す」か Ctrl+Z で戻せます'
                : 'サンプルの SQL に置き換えました。前の SQL は「元に戻す」で戻せます'}
            </span>
            <button type="button" className="btn btn--ghost sql-editor-notice-undo" onClick={undoReplace}>
              元に戻す
            </button>
          </div>
        )}
      </div>
      {error && (
        <div className="parse-error" role="alert" id={errorId}>
          <IconAlert size={15} className="parse-error-icon" />
          <span className="parse-error-text">
            <strong>解析エラー:</strong> {error}
          </span>
          {errorSpan && (
            <button type="button" className="btn btn--ghost parse-error-jump" onClick={jumpToError}>
              該当箇所へ移動
            </button>
          )}
        </div>
      )}
    </div>
  );
}
