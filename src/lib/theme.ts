/**
 * 配色テーマ。利用者の設定（自動 / ライト / ダーク）を localStorage に保存し、
 * <html data-theme="light|dark"> に解決済みの値を付ける。
 * 「自動」も OS の設定を読んで light / dark のどちらかを付けるので、CSS は light の 1 ブロックだけで済む
 */
import { safeLocalStorage } from './app-persistence';

export type ThemePreference = 'system' | 'light' | 'dark';
export type ColorScheme = 'light' | 'dark';

export const THEME_STORAGE_KEY = 'oracle-query-visualizer:theme:v1';

const DARK_QUERY = '(prefers-color-scheme: dark)';

export function isThemePreference(value: unknown): value is ThemePreference {
  return value === 'system' || value === 'light' || value === 'dark';
}

export function resolveColorScheme(preference: ThemePreference, systemPrefersDark: boolean): ColorScheme {
  if (preference === 'system') return systemPrefersDark ? 'dark' : 'light';
  return preference;
}

function systemPrefersDark(): boolean {
  // matchMedia が無い環境（テストの node など）は、これまでどおりダークにする
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return true;
  return window.matchMedia(DARK_QUERY).matches;
}

function readPreference(): ThemePreference {
  try {
    const value = safeLocalStorage()?.getItem(THEME_STORAGE_KEY);
    return isThemePreference(value) ? value : 'system';
  } catch {
    return 'system';
  }
}

let preference: ThemePreference = readPreference();
let scheme: ColorScheme = resolveColorScheme(preference, systemPrefersDark());
const listeners = new Set<() => void>();

function applyScheme(next: ColorScheme): void {
  scheme = next;
  if (typeof document !== 'undefined') document.documentElement.dataset.theme = next;
  listeners.forEach((listener) => listener());
}

/** 起動時に 1 回呼ぶ。OS の設定が変わったら「自動」のときだけ追従する */
export function initTheme(): void {
  applyScheme(resolveColorScheme(preference, systemPrefersDark()));
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
  window.matchMedia(DARK_QUERY).addEventListener?.('change', (event) => {
    if (preference === 'system') applyScheme(event.matches ? 'dark' : 'light');
  });
}

export function getThemePreference(): ThemePreference {
  return preference;
}

export function getColorScheme(): ColorScheme {
  return scheme;
}

export function setThemePreference(next: ThemePreference): void {
  preference = next;
  try {
    safeLocalStorage()?.setItem(THEME_STORAGE_KEY, next);
  } catch {
    // 保存できなくても、このページを開いている間は切り替わる
  }
  applyScheme(resolveColorScheme(next, systemPrefersDark()));
}

export function subscribeTheme(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
