// TUI theming (task 5.1): full colour, or monochrome for NO_COLOR / --no-color / TERM=dumb terminals.
// Monochrome drops colours only — bold, dim and inverse stay, so the cursor and emphasis still show — and every
// state that colour alone would carry also has a glyph or a word (delivery marks, liveness dots, "!" on high usage).
import { createContext, useContext } from 'react';

export interface Theme {
  readonly mono: boolean;
  /** Map a palette colour to what this theme renders (undefined = terminal default). */
  color(c: string | undefined): string | undefined;
}

export const COLOR_THEME: Theme = { mono: false, color: (c) => c };
export const MONO_THEME: Theme = { mono: true, color: () => undefined };

/** https://no-color.org: any non-empty NO_COLOR disables colour; so do `--no-color` and TERM=dumb. */
export function themeFrom(env: NodeJS.ProcessEnv = process.env, argv: readonly string[] = []): Theme {
  const noColor = (env.NO_COLOR !== undefined && env.NO_COLOR !== '') || env.TERM === 'dumb' || argv.includes('--no-color');
  return noColor ? MONO_THEME : COLOR_THEME;
}

export const ThemeContext = createContext<Theme>(COLOR_THEME);
export const useTheme = (): Theme => useContext(ThemeContext);
