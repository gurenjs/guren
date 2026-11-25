---
'@guren/plugin-markdown': patch
---

The default sanitizer now filters `class` on `span`, `pre` and `code`, as it already did on `div` and `p`. Raw HTML in untrusted markdown could previously put any class from the app's stylesheet on those tags, a full-viewport `fixed inset-0 z-50` overlay included. They now keep marked's `language-*` and what `createShikiHighlight` emits (`shiki`, `shiki-themes`, the names of shiki's bundled themes and `line`), so shiki output is unchanged. A custom highlighter whose output carries other classes, such as highlight.js's `hljs-*`, or a shiki theme loaded under a name shiki does not bundle, loses those classes until a `sanitize` callback adds them to `allowedClasses`. A callback that replaces `allowedClasses` outright now drops classes on these three tags rather than passing every value.
