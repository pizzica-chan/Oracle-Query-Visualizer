import { useSyncExternalStore } from 'react';
import {
  getColorScheme,
  getThemePreference,
  subscribeTheme,
  type ColorScheme,
  type ThemePreference,
} from '../lib/theme';

export function useThemePreference(): ThemePreference {
  return useSyncExternalStore(subscribeTheme, getThemePreference, getThemePreference);
}

/** 今の配色（light / dark）。JOIN 図の線の色など、CSS 変数で渡せない色の切り替えに使う */
export function useColorScheme(): ColorScheme {
  return useSyncExternalStore(subscribeTheme, getColorScheme, getColorScheme);
}
