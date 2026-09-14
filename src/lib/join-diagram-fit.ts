export interface JoinDiagramFitState {
  lastFitLayoutKey: string | null;
  needsFitOnShow: boolean;
}

export interface JoinDiagramFitPlan extends JoinDiagramFitState {
  shouldFit: boolean;
}

/** タブ表示状態と layoutKey から fitView の要否を決める（副作用なし） */
export function planJoinDiagramFit(
  isActive: boolean,
  layoutKey: string,
  state: JoinDiagramFitState,
): JoinDiagramFitPlan {
  if (!isActive) {
    return {
      lastFitLayoutKey: state.lastFitLayoutKey,
      needsFitOnShow: true,
      shouldFit: false,
    };
  }

  const layoutChanged = state.lastFitLayoutKey !== layoutKey;
  if (!layoutChanged && !state.needsFitOnShow) {
    return {
      lastFitLayoutKey: state.lastFitLayoutKey,
      needsFitOnShow: false,
      shouldFit: false,
    };
  }

  return {
    lastFitLayoutKey: layoutKey,
    needsFitOnShow: false,
    shouldFit: true,
  };
}

export interface JoinDiagramFitReadiness {
  /** ReactFlow インスタンスを onInit で受け取れているか */
  hasInstance: boolean;
  /** 描画コンテナの実測サイズ（display:none 中は 0） */
  containerWidth: number;
  containerHeight: number;
  /** レイアウト対象のノード数 */
  nodeCount: number;
  /** measured（実寸）が確定しているノード数 */
  measuredNodeCount: number;
}

/**
 * fitView を呼んでよい状態か。
 *
 * ReactFlow の fitView は「コンテナの width / height」と「ノードの measured」から
 * viewport を計算するが、そのどちらもブラウザの ResizeObserver 経由で非同期に入る。
 * タブの display:none を解除した直後は両方とも未確定で、その状態で fitView すると
 * width=0 として計算され、グラフの中心が画面左上に来る壊れた viewport が確定してしまう。
 *
 * fitView の戻り値は常に true なので成否では判断できない。呼ぶ前にここで確かめる。
 */
export function canFitJoinDiagram(readiness: JoinDiagramFitReadiness): boolean {
  if (!hasMeasuredContainer(readiness)) return false;
  // ノードが無ければ合わせる対象も無い（空表示なので viewport は壊れない）
  if (readiness.nodeCount === 0) return true;
  return readiness.measuredNodeCount >= readiness.nodeCount;
}

function hasMeasuredContainer(readiness: JoinDiagramFitReadiness): boolean {
  return readiness.hasInstance && readiness.containerWidth > 0 && readiness.containerHeight > 0;
}

export type JoinDiagramFitDecision = 'fit' | 'retry' | 'give-up';

/**
 * 実測待ちのリトライを続けるか、fitView を呼ぶか、諦めるか。
 *
 * 打ち切り時にコンテナだけでも実測できていれば fit する。
 * viewport が壊れる原因はコンテナサイズ 0 なので、その条件さえ満たせば
 * 「まったく fit しない（既定 viewport のまま）」より合わせたほうがよい。
 */
export function decideJoinDiagramFit(
  readiness: JoinDiagramFitReadiness,
  attempt: number,
  maxAttempts: number,
): JoinDiagramFitDecision {
  if (canFitJoinDiagram(readiness)) return 'fit';
  if (attempt < maxAttempts) return 'retry';
  return hasMeasuredContainer(readiness) ? 'fit' : 'give-up';
}
