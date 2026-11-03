import { isInteractiveDiagramName } from '../../config/interactive-diagrams.js'

/**
 * A marker, then the mermaid fence it upgrades. The fence is what GitHub, the
 * search index and a reader without JavaScript see, so a marker without one is
 * refused rather than rendering nothing there. A marker inside a code block is
 * escaped text by this point and never matches.
 */
const MARKER = /<!--\s*interactive:\s*([^\s>]*)\s*-->\s*(<pre class="mermaid">[\s\S]*?<\/pre>)?/gu

/** Wraps each marked mermaid fence in the placeholder the docs page mounts a component into. */
export function renderInteractiveDiagrams(html: string): string {
  return html.replace(MARKER, (_match, name: string, fallback: string | undefined) => {
    if (!isInteractiveDiagramName(name)) {
      throw new Error(`Unknown interactive diagram "${name}": add it to web/config/interactive-diagrams.ts.`)
    }
    if (!fallback) {
      throw new Error(`<!-- interactive: ${name} --> must sit directly above a mermaid fence, which readers without JavaScript see instead.`)
    }
    return `<div class="doc-interactive" data-interactive="${name}">${fallback}</div>`
  })
}
