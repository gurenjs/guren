/**
 * A strict reader for a small XML subset: elements, attributes, the five named
 * entities and numeric references, CDATA, comments, processing instructions.
 * Index-walking, no regex, so the work is linear in an untrusted document's
 * length. A DOCTYPE is refused, so no entity is ever defined by the document.
 * Looser than XML 1.0 in one place: control characters pass, raw and as `&#1;`.
 * Stricter in another: a numeric reference padded past the span of `&#x10FFFF;`
 * is refused, however legal. Every limit is the caller's to set.
 */

export interface XmlElement {
  name: string
  attributes: Map<string, string>
  children: XmlElement[]
}

/** All in UTF-16 units, which is what a string's length counts. Each unset limit takes `XML_SUBSET_LIMITS`. */
export interface XmlSubsetLimits {
  maxChars?: number
  maxAttributeChars?: number
  maxDepth?: number
  /** An element or attribute name, which reaches an error message; a longer one is cut short and fails as malformed. */
  maxNameChars?: number
  /** The distance from `&` to `;`: 9 spans `&#x10FFFF;` and `&#1114111;`, the longest either notation needs. */
  maxReferenceSpan?: number
}

/** What an unset limit takes. A caller that means to bound one of these says so rather than reading it back. */
export const XML_SUBSET_LIMITS: Required<XmlSubsetLimits> = {
  maxChars: 32 * 1024 * 1024,
  maxAttributeChars: 1024 * 1024,
  maxDepth: 64,
  maxNameChars: 128,
  maxReferenceSpan: 9,
}

/** The message says what could not be read, and is fit to show as it stands. */
export class XmlSubsetError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'XmlSubsetError'
  }
}

function resolveLimits(limits: XmlSubsetLimits): Required<XmlSubsetLimits> {
  return {
    maxChars: limits.maxChars ?? XML_SUBSET_LIMITS.maxChars,
    maxAttributeChars: limits.maxAttributeChars ?? XML_SUBSET_LIMITS.maxAttributeChars,
    maxDepth: limits.maxDepth ?? XML_SUBSET_LIMITS.maxDepth,
    maxNameChars: limits.maxNameChars ?? XML_SUBSET_LIMITS.maxNameChars,
    maxReferenceSpan: limits.maxReferenceSpan ?? XML_SUBSET_LIMITS.maxReferenceSpan,
  }
}

/** The root element. Text content is checked for entities and dropped: no caller reads it. */
export function parseXmlSubset(input: string, options: XmlSubsetLimits = {}): XmlElement {
  const limits = resolveLimits(options)
  if (input.length > limits.maxChars) throw new XmlSubsetError(`the document is over ${limits.maxChars} characters`)
  const text = input.charCodeAt(0) === 0xfeff ? input.slice(1) : input

  const stack: XmlElement[] = []
  let root: XmlElement | undefined
  let pos = 0

  while (pos < text.length) {
    if (text[pos] !== '<') {
      const next = text.indexOf('<', pos)
      const end = next === -1 ? text.length : next
      const content = text.slice(pos, end)
      if (stack.length === 0) {
        if (content.trim() !== '') throw new XmlSubsetError(`text outside the root element at offset ${pos}`)
      } else {
        decodeEntities(content, pos, limits.maxReferenceSpan)
      }
      pos = end
    } else if (text.startsWith('<!--', pos)) {
      pos = skipPast(text, '-->', pos + 4, 'comment')
    } else if (text.startsWith('<?', pos)) {
      pos = skipPast(text, '?>', pos + 2, 'processing instruction')
    } else if (text.startsWith('<![CDATA[', pos)) {
      if (stack.length === 0) throw new XmlSubsetError(`CDATA outside the root element at offset ${pos}`)
      pos = skipPast(text, ']]>', pos + 9, 'CDATA section')
    } else if (text.startsWith('<!', pos)) {
      throw new XmlSubsetError(`a declaration (<!DOCTYPE and the like) at offset ${pos} is not read`)
    } else if (text[pos + 1] === '/') {
      const nameEnd = scanName(text, pos + 2, limits.maxNameChars)
      const name = text.slice(pos + 2, nameEnd)
      const close = skipWhitespace(text, nameEnd)
      if (name === '' || text[close] !== '>') throw new XmlSubsetError(`malformed closing tag at offset ${pos}`)
      const open = stack.pop()
      if (open === undefined) throw new XmlSubsetError(`</${name}> at offset ${pos} closes nothing`)
      if (open.name !== name) throw new XmlSubsetError(`</${name}> at offset ${pos} closes <${open.name}>`)
      pos = close + 1
    } else {
      const tag = readOpenTag(text, pos, limits)
      const parent = stack[stack.length - 1]
      if (parent) parent.children.push(tag.element)
      else if (root) throw new XmlSubsetError(`a second root element at offset ${pos}`)
      else root = tag.element
      if (!tag.selfClosing) {
        if (stack.length >= limits.maxDepth) throw new XmlSubsetError(`elements nest deeper than ${limits.maxDepth}`)
        stack.push(tag.element)
      }
      pos = tag.end
    }
  }

  const unclosed = stack[stack.length - 1]
  if (unclosed) throw new XmlSubsetError(`the document ends inside <${unclosed.name}>`)
  if (!root) throw new XmlSubsetError('the document holds no element')
  return root
}

function readOpenTag(
  text: string,
  start: number,
  limits: Required<XmlSubsetLimits>,
): { element: XmlElement; selfClosing: boolean; end: number } {
  const nameEnd = scanName(text, start + 1, limits.maxNameChars)
  if (nameEnd === start + 1) throw new XmlSubsetError(`malformed tag at offset ${start}`)
  const element: XmlElement = { name: text.slice(start + 1, nameEnd), attributes: new Map(), children: [] }

  let pos = nameEnd
  for (;;) {
    const afterSpace = skipWhitespace(text, pos)
    if (afterSpace >= text.length) throw new XmlSubsetError(`the document ends inside a <${element.name}> tag`)
    if (text[afterSpace] === '>') return { element, selfClosing: false, end: afterSpace + 1 }
    if (text[afterSpace] === '/' && text[afterSpace + 1] === '>') {
      return { element, selfClosing: true, end: afterSpace + 2 }
    }
    if (afterSpace === pos) throw new XmlSubsetError(`malformed <${element.name}> tag at offset ${start}`)

    const attributeEnd = scanName(text, afterSpace, limits.maxNameChars)
    const name = text.slice(afterSpace, attributeEnd)
    const equals = skipWhitespace(text, attributeEnd)
    const quoteAt = skipWhitespace(text, equals + 1)
    const quote = text[quoteAt]
    if (name === '' || text[equals] !== '=' || (quote !== '"' && quote !== "'")) {
      throw new XmlSubsetError(`malformed attribute in <${element.name}> at offset ${afterSpace}`)
    }
    const valueEnd = text.indexOf(quote, quoteAt + 1)
    if (valueEnd === -1) throw new XmlSubsetError(`the document ends inside an attribute of <${element.name}>`)
    if (valueEnd - quoteAt - 1 > limits.maxAttributeChars) {
      throw new XmlSubsetError(
        `the ${name} attribute at offset ${afterSpace} is over ${limits.maxAttributeChars} characters`,
      )
    }
    const raw = text.slice(quoteAt + 1, valueEnd)
    if (raw.includes('<')) throw new XmlSubsetError(`a raw < inside the ${name} attribute at offset ${afterSpace}`)
    if (element.attributes.has(name)) throw new XmlSubsetError(`<${element.name}> repeats the ${name} attribute`)
    element.attributes.set(name, decodeEntities(raw, quoteAt + 1, limits.maxReferenceSpan))
    pos = valueEnd + 1
  }
}

const NAMED_ENTITIES = new Map([
  ['lt', '<'],
  ['gt', '>'],
  ['amp', '&'],
  ['quot', '"'],
  ['apos', "'"],
])

function decodeEntities(raw: string, offset: number, maxReferenceSpan: number): string {
  let amp = raw.indexOf('&')
  if (amp === -1) return raw

  const parts: string[] = []
  let pos = 0
  while (amp !== -1) {
    const semi = raw.indexOf(';', amp)
    if (semi === -1) throw new XmlSubsetError(`an unterminated entity reference at offset ${offset + amp}`)
    if (semi - amp > maxReferenceSpan) {
      throw new XmlSubsetError(`an entity reference longer than any this reader decodes at offset ${offset + amp}`)
    }
    const body = raw.slice(amp + 1, semi)
    const decoded = body.startsWith('#') ? decodeNumericReference(body) : NAMED_ENTITIES.get(body)
    if (decoded === undefined) throw new XmlSubsetError(`the unknown entity &${body}; at offset ${offset + amp}`)
    parts.push(raw.slice(pos, amp), decoded)
    pos = semi + 1
    amp = raw.indexOf('&', pos)
  }
  parts.push(raw.slice(pos))
  return parts.join('')
}

function decodeNumericReference(body: string): string | undefined {
  const hex = body[1] === 'x'
  const digits = body.slice(hex ? 2 : 1)
  if (digits === '') return undefined
  let codePoint = 0
  for (let index = 0; index < digits.length; index++) {
    const digit = digitValue(digits.charCodeAt(index), hex)
    if (digit === -1) return undefined
    codePoint = codePoint * (hex ? 16 : 10) + digit
  }
  const surrogate = codePoint >= 0xd800 && codePoint <= 0xdfff
  if (codePoint === 0 || codePoint > 0x10ffff || surrogate) return undefined
  return String.fromCodePoint(codePoint)
}

function digitValue(code: number, hex: boolean): number {
  if (isDigit(code)) return code - 48
  if (!hex) return -1
  const lower = code | 0x20
  return lower >= 97 && lower <= 102 ? lower - 87 : -1
}

function skipPast(text: string, terminator: string, from: number, what: string): number {
  const at = text.indexOf(terminator, from)
  if (at === -1) throw new XmlSubsetError(`the document ends inside a ${what}`)
  return at + terminator.length
}

function skipWhitespace(text: string, from: number): number {
  let pos = from
  while (pos < text.length && ' \t\r\n'.includes(text[pos]!)) pos++
  return pos
}

function scanName(text: string, from: number, maxNameChars: number): number {
  let pos = from
  const limit = Math.min(text.length, from + maxNameChars)
  while (pos < limit) {
    const code = text.charCodeAt(pos)
    const start = isAsciiLetter(code) || text[pos] === '_' || text[pos] === ':'
    if (!start && (pos === from || (!isDigit(code) && text[pos] !== '-' && text[pos] !== '.'))) break
    pos++
  }
  return pos
}

function isAsciiLetter(code: number): boolean {
  const lower = code | 0x20
  return lower >= 97 && lower <= 122
}

function isDigit(code: number): boolean {
  return code >= 48 && code <= 57
}
