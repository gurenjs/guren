/**
 * Shared vocabulary for both markdown pipelines (docs MarkdownRenderer and
 * blog PostRenderer), so the two cannot drift apart on one site.
 */

// Themeless ink (Guren UI): app.css always applies the dark palette from the
// `--shiki-dark` custom properties and pins the background to the ink token.
export const MARKDOWN_CODE_THEMES = {
  light: 'rose-pine-dawn',
  dark: 'rose-pine-moon',
} as const

// Callouts render as diagnostic rows (Guren UI): GitHub's five directives map
// onto the note / ok / rule / never vocabulary of `guren check`.
export const SITE_ALERT_LABELS = {
  note: 'note',
  tip: 'ok',
  important: 'rule',
  warning: 'rule',
  caution: 'never',
} as const
