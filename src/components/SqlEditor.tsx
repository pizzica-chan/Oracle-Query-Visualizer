import { useCallback, useEffect, useMemo, useRef } from 'react';
import { highlightSqlToHtml } from '../lib/sql-highlight';
import type { SourceSpan } from '../lib/types';
import { SampleLoadButtons } from './SampleLoadButtons';

interface SqlEditorProps {
  value: string;
  onChange: (value: string) => void;
  onLoadSample?: () => void;
  onLoadUpdateSample?: () => void;
  onLoadDeleteSample?: () => void;
  onLoadUnionSample?: () => void;
  onLoadLegacyJoinSample?: () => void;
  onLoadHierarchicalSample?: () => void;
  error?: string;
  focusSpan?: SourceSpan | null;
  /** エディタ上部のラベル */
  label?: string;
  /** サンプル読込ボタンを表示するか（デフォルト true） */
  showSamples?: boolean;
}

export function SqlEditor({
  value,
  onChange,
  onLoadSample,
  onLoadUpdateSample,
  onLoadDeleteSample,
  onLoadUnionSample,
  onLoadLegacyJoinSample,
  onLoadHierarchicalSample,
  error,
  focusSpan = null,
  label,
  showSamples = true,
}: SqlEditorProps) {
  const highlightRef = useRef<HTMLPreElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const highlightedHtml = useMemo(() => {
    const html = highlightSqlToHtml(value, focusSpan ?? undefined);
    return value.endsWith('\n') ? `${html} ` : html;
  }, [value, focusSpan]);

  const syncScroll = useCallback((target: HTMLTextAreaElement) => {
    const layer = highlightRef.current;
    if (!layer) return;
    layer.scrollTop = target.scrollTop;
    layer.scrollLeft = target.scrollLeft;
  }, []);

  useEffect(() => {
    if (!focusSpan || !textareaRef.current) return;
    const textarea = textareaRef.current;
    const lineHeight = parseFloat(getComputedStyle(textarea).lineHeight) || 22;
    const textBefore = value.slice(0, focusSpan.start);
    const line = textBefore.split('\n').length - 1;
    const targetTop = Math.max(0, line * lineHeight - textarea.clientHeight * 0.35);
    textarea.scrollTop = targetTop;
    syncScroll(textarea);
  }, [focusSpan, value, syncScroll]);

  const canShowSamples =
    showSamples &&
    onLoadSample &&
    onLoadUpdateSample &&
    onLoadDeleteSample &&
    onLoadUnionSample &&
    onLoadLegacyJoinSample &&
    onLoadHierarchicalSample;

  return (
    <div className="sql-editor">
      {(label || canShowSamples) && (
        <div className="sql-editor-toolbar">
          {label ? <span className="sql-editor-label">{label}</span> : <span />}
          {canShowSamples && (
            <SampleLoadButtons
              onSelect={onLoadSample}
              onUpdate={onLoadUpdateSample}
              onUnion={onLoadUnionSample}
              onDelete={onLoadDeleteSample}
              onLegacyJoin={onLoadLegacyJoinSample}
              onHierarchical={onLoadHierarchicalSample}
            />
          )}
        </div>
      )}
      <div className={`sql-editor-body${error ? ' sql-editor-body--error' : ''}`}>
        <pre ref={highlightRef} className="sql-highlight-layer" aria-hidden="true">
          <code dangerouslySetInnerHTML={{ __html: highlightedHtml }} />
        </pre>
        <textarea
          ref={textareaRef}
          className="sql-textarea sql-textarea--highlight"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onScroll={(e) => syncScroll(e.currentTarget)}
          placeholder="SELECT / UPDATE / DELETE ..."
          spellCheck={false}
          aria-label={label}
        />
      </div>
      {error && (
        <div className="parse-error" role="alert">
          <strong>解析エラー:</strong> {error}
        </div>
      )}
    </div>
  );
}
