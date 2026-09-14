import { createContext, useContext } from 'react';
import type { OnSourceSpanSelect } from '../lib/source-link';
import type { SourceSpan } from '../lib/types';

export interface SourceLinkContextValue {
  activeSourceSpan: SourceSpan | null;
  onSourceSpanSelect?: OnSourceSpanSelect;
}

export const SourceLinkContext = createContext<SourceLinkContextValue>({
  activeSourceSpan: null,
});

export function useSourceLink(): SourceLinkContextValue {
  return useContext(SourceLinkContext);
}
