import { createContext, useContext, type ReactNode } from 'react';
import type { JoinFocusHighlight } from '../lib/join-diagram-focus';

export interface JoinFocusContextValue {
  highlight: JoinFocusHighlight;
  hasFocus: boolean;
  selectNode: (nodeId: string) => void;
  selectEdge: (edgeId: string) => void;
}

const JoinFocusContext = createContext<JoinFocusContextValue>({
  highlight: {
    primaryNodeIds: new Set(),
    relatedNodeIds: new Set(),
    primaryEdgeIds: new Set(),
    relatedEdgeIds: new Set(),
  },
  hasFocus: false,
  selectNode: () => {},
  selectEdge: () => {},
});

export function JoinFocusContextProvider({
  highlight,
  hasFocus,
  selectNode,
  selectEdge,
  children,
}: JoinFocusContextValue & { children: ReactNode }) {
  return (
    <JoinFocusContext.Provider value={{ highlight, hasFocus, selectNode, selectEdge }}>
      {children}
    </JoinFocusContext.Provider>
  );
}

export function useJoinFocus(): JoinFocusContextValue {
  return useContext(JoinFocusContext);
}
