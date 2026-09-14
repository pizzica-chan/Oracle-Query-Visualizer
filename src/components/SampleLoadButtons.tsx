interface SampleLoadButtonsProps {
  onSelect: () => void;
  onUpdate: () => void;
  onUnion: () => void;
  onDelete: () => void;
  onLegacyJoin: () => void;
  onHierarchical: () => void;
  /** welcome 画面などで SELECT を強調する */
  highlightSelect?: boolean;
}

const SAMPLES = [
  { id: 'select', label: 'SELECT', title: 'SELECT のサンプル SQL を読み込む', handler: 'onSelect' as const },
  { id: 'union', label: 'UNION', title: 'UNION のサンプル SQL を読み込む', handler: 'onUnion' as const },
  { id: 'update', label: 'UPDATE', title: 'UPDATE のサンプル SQL を読み込む', handler: 'onUpdate' as const },
  { id: 'delete', label: 'DELETE', title: 'DELETE のサンプル SQL を読み込む', handler: 'onDelete' as const },
  {
    id: 'legacy-join',
    label: '(+) 結合',
    title: '旧式外部結合演算子 (+) を使ったサンプル SQL を読み込む',
    handler: 'onLegacyJoin' as const,
  },
  {
    id: 'hierarchical',
    label: 'CONNECT BY',
    title: '階層問い合わせ（CONNECT BY / START WITH）のサンプル SQL を読み込む',
    handler: 'onHierarchical' as const,
  },
] as const;

export function SampleLoadButtons({
  onSelect,
  onUpdate,
  onUnion,
  onDelete,
  onLegacyJoin,
  onHierarchical,
  highlightSelect = false,
}: SampleLoadButtonsProps) {
  const handlers = { onSelect, onUpdate, onUnion, onDelete, onLegacyJoin, onHierarchical };

  return (
    <div className="sample-load">
      <span className="sample-load-label">サンプル SQL</span>
      <div className="sample-load-buttons">
        {SAMPLES.map((sample) => (
          <button
            key={sample.id}
            type="button"
            className={`btn sample-load-btn${
              highlightSelect && sample.id === 'select' ? ' btn--primary' : ' btn--ghost'
            }`}
            onClick={handlers[sample.handler]}
            title={sample.title}
          >
            {sample.label}
          </button>
        ))}
      </div>
    </div>
  );
}
