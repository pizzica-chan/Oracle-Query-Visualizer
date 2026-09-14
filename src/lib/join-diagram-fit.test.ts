import { describe, expect, it } from 'vitest';
import { canFitJoinDiagram, decideJoinDiagramFit, planJoinDiagramFit } from './join-diagram-fit';

describe('planJoinDiagramFit', () => {
  it('非表示中は fit せず、再表示用フラグを立てる', () => {
    expect(
      planJoinDiagramFit(false, 'layout-a', {
        lastFitLayoutKey: 'layout-a',
        needsFitOnShow: false,
      }),
    ).toEqual({
      lastFitLayoutKey: 'layout-a',
      needsFitOnShow: true,
      shouldFit: false,
    });
  });

  it('非表示 → 表示では必ず fit する', () => {
    expect(
      planJoinDiagramFit(true, 'layout-a', {
        lastFitLayoutKey: 'layout-a',
        needsFitOnShow: true,
      }),
    ).toEqual({
      lastFitLayoutKey: 'layout-a',
      needsFitOnShow: false,
      shouldFit: true,
    });
  });

  it('非表示中に layoutKey が変わっても、再表示時に fit する', () => {
    const whileHidden = planJoinDiagramFit(false, 'layout-b', {
      lastFitLayoutKey: 'layout-a',
      needsFitOnShow: false,
    });
    expect(whileHidden).toEqual({
      lastFitLayoutKey: 'layout-a',
      needsFitOnShow: true,
      shouldFit: false,
    });

    expect(planJoinDiagramFit(true, 'layout-b', whileHidden)).toEqual({
      lastFitLayoutKey: 'layout-b',
      needsFitOnShow: false,
      shouldFit: true,
    });
  });

  it('表示中に layoutKey が変わると fit する', () => {
    expect(
      planJoinDiagramFit(true, 'layout-b', {
        lastFitLayoutKey: 'layout-a',
        needsFitOnShow: false,
      }),
    ).toEqual({
      lastFitLayoutKey: 'layout-b',
      needsFitOnShow: false,
      shouldFit: true,
    });
  });

  it('表示中で layoutKey もフラグも変わらなければ fit しない', () => {
    expect(
      planJoinDiagramFit(true, 'layout-a', {
        lastFitLayoutKey: 'layout-a',
        needsFitOnShow: false,
      }),
    ).toEqual({
      lastFitLayoutKey: 'layout-a',
      needsFitOnShow: false,
      shouldFit: false,
    });
  });
});

describe('canFitJoinDiagram', () => {
  const ready = {
    hasInstance: true,
    containerWidth: 800,
    containerHeight: 600,
    nodeCount: 3,
    measuredNodeCount: 3,
  };

  it('コンテナもノードも実測できていれば fit してよい', () => {
    expect(canFitJoinDiagram(ready)).toBe(true);
  });

  it('ReactFlow インスタンス未取得では fit しない', () => {
    expect(canFitJoinDiagram({ ...ready, hasInstance: false })).toBe(false);
  });

  it('display:none 直後のコンテナ 0 サイズでは fit しない', () => {
    expect(canFitJoinDiagram({ ...ready, containerWidth: 0, containerHeight: 0 })).toBe(false);
    expect(canFitJoinDiagram({ ...ready, containerWidth: 800, containerHeight: 0 })).toBe(false);
    expect(canFitJoinDiagram({ ...ready, containerWidth: 0, containerHeight: 600 })).toBe(false);
  });

  it('ノードの measured が揃うまで fit しない', () => {
    expect(canFitJoinDiagram({ ...ready, measuredNodeCount: 0 })).toBe(false);
    expect(canFitJoinDiagram({ ...ready, measuredNodeCount: 2 })).toBe(false);
    expect(canFitJoinDiagram({ ...ready, measuredNodeCount: 3 })).toBe(true);
  });

  it('ノードが無いときは待たない', () => {
    expect(canFitJoinDiagram({ ...ready, nodeCount: 0, measuredNodeCount: 0 })).toBe(true);
  });
});

describe('decideJoinDiagramFit', () => {
  const ready = {
    hasInstance: true,
    containerWidth: 800,
    containerHeight: 600,
    nodeCount: 3,
    measuredNodeCount: 3,
  };

  it('実測が揃っていれば即 fit する', () => {
    expect(decideJoinDiagramFit(ready, 0, 60)).toBe('fit');
  });

  it('実測待ちの間はリトライする', () => {
    expect(decideJoinDiagramFit({ ...ready, measuredNodeCount: 0 }, 0, 60)).toBe('retry');
    expect(decideJoinDiagramFit({ ...ready, containerWidth: 0 }, 59, 60)).toBe('retry');
  });

  it('打ち切り時でもコンテナが実測できていれば fit する（既定 viewport のままにしない）', () => {
    expect(decideJoinDiagramFit({ ...ready, measuredNodeCount: 0 }, 60, 60)).toBe('fit');
  });

  it('打ち切り時にコンテナが 0 のままなら fit しない（壊れた viewport を確定させない）', () => {
    expect(decideJoinDiagramFit({ ...ready, containerWidth: 0, containerHeight: 0 }, 60, 60)).toBe(
      'give-up',
    );
    expect(decideJoinDiagramFit({ ...ready, hasInstance: false }, 60, 60)).toBe('give-up');
  });
});
