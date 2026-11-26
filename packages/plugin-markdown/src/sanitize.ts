import type sanitizeHtml from 'sanitize-html'

import { alertAllowedClasses } from './alerts'

/**
 * Theme ids shiki bundles, which `createShikiHighlight` puts on its `<pre>`
 * beside `shiki shiki-themes`. Kept in sync by a test against shiki's
 * `bundledThemesInfo`; this module cannot import shiki, an optional peer.
 */
export const SHIKI_THEME_CLASSES: readonly string[] = [
  'andromeeda', 'aurora-x', 'ayu-dark', 'ayu-light', 'ayu-mirage',
  'catppuccin-frappe', 'catppuccin-latte', 'catppuccin-macchiato', 'catppuccin-mocha',
  'dark-plus', 'dracula', 'dracula-soft', 'everforest-dark', 'everforest-light',
  'github-dark', 'github-dark-default', 'github-dark-dimmed', 'github-dark-high-contrast',
  'github-light', 'github-light-default', 'github-light-high-contrast',
  'gruvbox-dark-hard', 'gruvbox-dark-medium', 'gruvbox-dark-soft',
  'gruvbox-light-hard', 'gruvbox-light-medium', 'gruvbox-light-soft',
  'horizon', 'horizon-bright', 'houston', 'kanagawa-dragon', 'kanagawa-lotus', 'kanagawa-wave',
  'laserwave', 'light-plus', 'material-theme', 'material-theme-darker', 'material-theme-lighter',
  'material-theme-ocean', 'material-theme-palenight', 'min-dark', 'min-light', 'monokai',
  'night-owl', 'night-owl-light', 'nord', 'one-dark-pro', 'one-light', 'plastic', 'poimandres',
  'red', 'rose-pine', 'rose-pine-dawn', 'rose-pine-moon', 'slack-dark', 'slack-ochin',
  'snazzy-light', 'solarized-dark', 'solarized-light', 'synthwave-84', 'tokyo-night', 'vesper',
  'vitesse-black', 'vitesse-dark', 'vitesse-light',
]

/**
 * Default allowlist applied to rendered HTML (RFC 0012). The output is commonly
 * injected with dangerouslySetInnerHTML, and escaping raw HTML in the source is
 * not enough: markdown syntax itself carries `javascript:`/`data:` URLs into
 * href and src. A fresh object per call, so one renderer's `sanitize` callback
 * can mutate its copy without bleeding into other renderers.
 */
export function defaultSanitizeOptions(): sanitizeHtml.IOptions {
  return {
    allowedTags: [
      'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
      'p', 'br', 'hr', 'blockquote', 'div',
      'ul', 'ol', 'li',
      'strong', 'em', 'del', 'code', 'pre', 'span',
      'a', 'img',
      'table', 'thead', 'tbody', 'tr', 'th', 'td',
    ],
    allowedAttributes: {
      a: ['href', 'title'],
      img: ['src', 'alt', 'title'],
      h1: ['id'], h2: ['id'], h3: ['id'], h4: ['id'], h5: ['id'], h6: ['id'],
      // shiki emits inline colors on the wrapper and every token. `class` is
      // admitted through allowedClasses alone, so a callback that replaces
      // allowedClasses drops classes on these tags instead of passing them all.
      pre: ['style', 'tabindex'],
      code: ['style'],
      span: ['style'],
      th: ['align'],
      td: ['align'],
    },
    // sanitize-html passes every class on a tag that lists `class` in
    // allowedAttributes, so each tag's classes are listed here instead: div/p
    // the values alerts.ts emits (derived there so the two cannot drift), code
    // marked's fence class, pre and span what createShikiHighlight emits.
    allowedClasses: {
      ...alertAllowedClasses(),
      pre: ['shiki', 'shiki-themes', ...SHIKI_THEME_CLASSES],
      code: ['language-*'],
      span: ['line'],
    },
    allowedSchemes: ['http', 'https', 'mailto'],
    allowedSchemesAppliedToAttributes: ['href', 'src'],
    // `//host/path` inherits the page scheme but still points off-origin —
    // same trust question as an absolute URL, so it gets no special pass.
    allowProtocolRelative: false,
    // Only the declarations shiki produces; anything else (position,
    // background-image, …) is dropped.
    allowedStyles: {
      '*': {
        color: [/^#[0-9a-fA-F]{3,8}$/],
        'background-color': [/^#[0-9a-fA-F]{3,8}$/],
        // Dual-theme shiki carries the dark palette in custom properties that
        // the reference stylesheet switches on — stripping them silently
        // breaks dark mode.
        '--shiki-dark': [/^#[0-9a-fA-F]{3,8}$/],
        '--shiki-dark-bg': [/^#[0-9a-fA-F]{3,8}$/],
        'font-style': [/^italic$|^normal$/],
        'font-weight': [/^bold$|^normal$|^\d{3}$/],
        'text-decoration': [/^underline$|^line-through$|^none$/],
      },
    },
    disallowedTagsMode: 'escape',
  }
}
