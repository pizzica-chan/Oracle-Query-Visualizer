// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { JoinDiagram } from './JoinDiagram';
import { parseOracleQuery, SAMPLE_SQL } from '../lib/parser';

describe('JoinDiagram オフライン', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('描画処理中に fetch が呼ばれない', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(() => {
      throw new Error('offline guard: fetch');
    });

    const result = parseOracleQuery(SAMPLE_SQL);
    expect(result.success).toBe(true);
    if (!result.success) return;

    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    try {
      await act(async () => {
        root.render(
          <JoinDiagram
            tables={result.query.tables}
            joins={result.query.joins}
            resolveAliases={false}
          />,
        );
      });
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      await act(async () => root.unmount());
      container.remove();
    }
  });
});
