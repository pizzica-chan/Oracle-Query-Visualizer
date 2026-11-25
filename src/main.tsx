import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { initTheme } from './lib/theme';
import './index.css';

// 最初の配色は index.html のインラインスクリプトが決めている。ここでは同じ値を付け直し、
// OS の設定が変わったときに「自動」の配色が追従するようにする
initTheme();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
