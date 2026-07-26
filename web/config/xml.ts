// Shared XML escaping for the machine-facing endpoints (sitemap.xml, RSS).
// Kept beside site.ts rather than inside either producer: both emit XML built
// from the same post titles, and a fix applied to only one of them would leave
// the sitemap and the feed disagreeing about what is safe to emit.

// XML 1.0 forbids most C0 controls outright — a single stray one makes the
// whole document unparseable, so they are dropped rather than escaped. Tab,
// newline and carriage return are the legal exceptions.
const INVALID_XML_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/gu

export function xmlEscape(value: string): string {
  return value
    .replace(INVALID_XML_CHARS, '')
    .replace(/&/gu, '&amp;')
    .replace(/</gu, '&lt;')
    .replace(/>/gu, '&gt;')
    .replace(/"/gu, '&quot;')
}
