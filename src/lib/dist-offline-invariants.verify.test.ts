import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { assertDistOfflineInvariants } from './dist-offline-invariants';

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

/** npm run verify-dist-offline / ensure-dist から呼ばれる */
describe('dist offline invariants (verify)', () => {
  it('dist/ は file:// 直開き向けである', () => {
    expect(() => assertDistOfflineInvariants(resolve(PROJECT_ROOT, 'dist'))).not.toThrow();
  });
});
