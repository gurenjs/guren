/**
 * The element a server-rendered Inertia document carries its initial page in, written and read
 * here: `InertiaEngine.ts` writes it with `initialPageElement()` and names it in the page-global
 * shim with `INITIAL_PAGE_SELECTOR`, and `readInitialPage()` reads it back from HTML, else a legacy
 * `data-page` attribute, for code that holds the HTML rather than a DOM (`@guren/testing`,
 * `guren browser:doctor`). It imports nothing, so a Node process can load it alone.
 */

const ATTRIBUTES = ['data-page="app"', 'type="application/json"'] as const

/** The selector the client and the page-global shim find the element by. */
export const INITIAL_PAGE_SELECTOR = `script[${ATTRIBUTES.join('][')}]`

/** `json` is the page serialized by `serializePage()`, which escapes `<` so no `</script>` can end the element early. */
export function initialPageElement(json: string): string {
  return `<script ${ATTRIBUTES.join(' ')}>${json}</script>`
}

const ENTITIES: Readonly<Record<string, string>> = { quot: '"', amp: '&', lt: '<', gt: '>', '#39': "'" }

/** The element's JSON text; the attribute form is entity-decoded. Undefined when the document carries neither. */
function payloadText(html: string): string | undefined {
  // Attributes are tested with `includes`, since chained `[^>]*` groups backtrack polynomially on a large body.
  const openTag = /<script\b[^>]*>/giu
  let tag: RegExpExecArray | null
  while ((tag = openTag.exec(html)) !== null) {
    const text = tag[0].toLowerCase()
    if (!ATTRIBUTES.every((attribute) => text.includes(attribute))) continue
    // Searched on the original, never a lowercased copy: case folding can change a string's length.
    const close = /<\/script\s*>/giu
    close.lastIndex = openTag.lastIndex
    const end = close.exec(html)
    return end ? html.slice(openTag.lastIndex, end.index) : undefined
  }
  const legacy = /data-page="([^"]+)"/u.exec(html)
  return legacy?.[1]?.replace(/&(quot|amp|lt|gt|#39);/gu, (_, entity: string) => ENTITIES[entity]!)
}

/**
 * The parsed initial page, or `undefined` when the document carries none. Throws the JSON parser's
 * error when the element holds text that is not JSON, since that is a broken document, not an absent page.
 */
export function readInitialPage(html: string): unknown {
  const text = payloadText(html)
  return text === undefined ? undefined : JSON.parse(text)
}
