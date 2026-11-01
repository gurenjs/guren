/**
 * JSON for an `X-Testing-*` header, every character past `~` written as a `\uXXXX`
 * escape: a header value is a byte string, so Bun throws on `浦田` and a Latin-1 `é`
 * arrives byte-mangled. The result is still plain JSON, which every server's
 * `JSON.parse` reads, so no `@guren/server` release needs a decoder for it.
 */
export function testingHeaderValue(value: unknown): string {
  return JSON.stringify(value).replace(
    /[\u007f-￿]/g,
    (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`,
  )
}
