import type sanitizeHtml from 'sanitize-html'

import { alertAllowedClasses } from './alerts'

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
      // shiki emits inline colors on the wrapper and every token.
      pre: ['class', 'style', 'tabindex'],
      code: ['class', 'style'],
      span: ['class', 'style'],
      th: ['align'],
      td: ['align'],
    },
    // Class attributes on div/p are admitted only for the exact values
    // alerts.ts emits, derived there so the two cannot drift. `class` itself
    // must stay out of allowedAttributes for div/p, or every class passes.
    allowedClasses: alertAllowedClasses(),
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
