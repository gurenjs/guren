/**
 * The rendered plan page, run whole against the DOM calls it makes. The page is a
 * classic script with no module to import, so its markup is parsed and its script
 * evaluated here; what a test reads is what that script built.
 */

type Listener = (event: PageEvent) => void
export interface PageEvent {
  key?: string
  preventDefault(): void
}

/** `function name(...) { ... }` as the page spells it, by brace matching. */
export function pageFunctionSource(source: string, name: string): string {
  const start = source.indexOf(`function ${name}(`)
  if (start < 0) throw new Error(`the page declares no ${name}()`)
  let depth = 0
  for (let at = source.indexOf('{', start); at < source.length; at += 1) {
    if (source[at] === '{') depth += 1
    else if (source[at] === '}') {
      depth -= 1
      if (depth === 0) return source.slice(start, at + 1)
    }
  }
  throw new Error(`${name}() never closes`)
}

const VOID_TAGS = new Set(['input', 'meta', 'br', 'hr', 'img', 'link'])

export class PageNode {
  readonly nodeType: number
  readonly attributes: Record<string, string> = {}
  readonly listeners: Record<string, Listener[]> = {}
  childNodes: PageNode[] = []
  parentNode: PageNode | null = null
  text = ''
  value = ''
  checked = false
  hidden = false
  focused = false;
  [property: string]: unknown

  constructor(
    readonly tag: string,
    private readonly page?: PageDocument,
  ) {
    this.nodeType = tag === '#text' ? 3 : 1
  }

  get id(): string {
    return this.attributes.id ?? ''
  }

  set id(value: string) {
    this.attributes.id = value
  }

  get className(): string {
    return this.attributes.class ?? ''
  }

  set className(value: string) {
    this.attributes.class = value
  }

  get lang(): string {
    return this.attributes.lang ?? ''
  }

  set lang(value: string) {
    this.attributes.lang = value
  }

  get href(): string {
    return this.attributes.href ?? ''
  }

  set href(value: string) {
    this.attributes.href = value
  }

  get firstChild(): PageNode | null {
    return this.childNodes[0] ?? null
  }

  get textContent(): string {
    if (this.nodeType === 3) return this.text
    return this.childNodes.map((child) => child.textContent).join('')
  }

  set textContent(value: string) {
    if (this.nodeType === 3) {
      this.text = String(value)
      return
    }
    for (const child of this.childNodes) child.parentNode = null
    this.childNodes = []
    if (value !== '') this.appendChild(new PageNode('#text', this.page)).text = String(value)
  }

  get classList(): { toggle(name: string, on: boolean): void } {
    return {
      toggle: (name, on) => {
        const names = new Set(this.className.split(' ').filter(Boolean))
        if (on) names.add(name)
        else names.delete(name)
        this.className = [...names].join(' ')
      },
    }
  }

  setAttribute(name: string, value: string): void {
    this.attributes[name] = String(value)
  }

  getAttribute(name: string): string | null {
    return this.attributes[name] ?? null
  }

  removeAttribute(name: string): void {
    delete this.attributes[name]
  }

  appendChild(child: PageNode): PageNode {
    if (child.parentNode) child.parentNode.removeChild(child)
    child.parentNode = this
    this.childNodes.push(child)
    return child
  }

  removeChild(child: PageNode): PageNode {
    this.childNodes = this.childNodes.filter((node) => node !== child)
    child.parentNode = null
    return child
  }

  cloneNode(deep: boolean): PageNode {
    const copy = new PageNode(this.tag, this.page)
    Object.assign(copy.attributes, this.attributes)
    copy.text = this.text
    if (deep) for (const child of this.childNodes) copy.appendChild(child.cloneNode(true))
    return copy
  }

  contains(other: PageNode | null): boolean {
    for (let node = other; node; node = node.parentNode) if (node === this) return true
    return false
  }

  addEventListener(type: string, listener: Listener): void {
    ;(this.listeners[type] ??= []).push(listener)
  }

  dispatch(type: string, event: Partial<PageEvent> = {}): void {
    for (const listener of this.listeners[type] ?? []) listener({ preventDefault() {}, ...event })
  }

  click(): void {
    this.dispatch('click')
  }

  focus(): void {
    this.focused = true
  }

  scrollIntoView(): void {}

  all(): PageNode[] {
    return [this, ...this.childNodes.flatMap((child) => child.all())]
  }

  withTag(tag: string): PageNode[] {
    return this.all().filter((node) => node.tag === tag)
  }

  withClass(name: string): PageNode[] {
    return this.all().filter((node) => node.className.split(' ').includes(name))
  }

  /** Whether this node or an ancestor is hidden, as the `hidden` attribute reads on screen. */
  get shown(): boolean {
    return !this.hidden && (this.parentNode === null || this.parentNode.shown)
  }
}

export class PageDocument {
  readonly documentElement = new PageNode('html', this)
  readonly body = new PageNode('body', this)
  title = ''

  createElement(tag: string): PageNode {
    return new PageNode(tag, this)
  }

  createElementNS(_namespace: string, tag: string): PageNode {
    return new PageNode(tag, this)
  }

  createTextNode(text: string): PageNode {
    const node = new PageNode('#text', this)
    node.text = String(text)
    return node
  }

  getElementById(id: string): PageNode | null {
    if (id === '') return null
    return this.body.all().find((node) => node.id === id) ?? null
  }

  querySelector(selector: string): PageNode | null {
    if (!selector.startsWith('.')) throw new Error(`the page DOM only answers class selectors, not ${selector}`)
    return this.body.withClass(selector.slice(1))[0] ?? null
  }
}

/** The markup the page ships: tags, attributes and text. It holds no entity and no `>` in a value. */
function parseMarkup(markup: string, document: PageDocument, root: PageNode): void {
  const stack = [root]
  for (const token of markup.match(/<!--[\s\S]*?-->|<[^>]+>|[^<]+/g) ?? []) {
    const parent = stack[stack.length - 1]!
    if (token.startsWith('<!--')) continue
    if (token.startsWith('</')) {
      stack.pop()
    } else if (token.startsWith('<')) {
      const tag = /^<([A-Za-z0-9-]+)/.exec(token)![1]!.toLowerCase()
      const node = parent.appendChild(document.createElement(tag))
      for (const [, name, , value] of token.matchAll(/\s([A-Za-z-]+)(="([^"]*)")?/g)) {
        if (name === 'hidden') node.hidden = true
        else node.setAttribute(name!, value ?? '')
      }
      if (!VOID_TAGS.has(tag) && !token.endsWith('/>')) stack.push(node)
    } else {
      // A space between two tags on one line is a space on the page; indentation is not.
      const text = token.replace(/^\s*\n\s*|\s*\n\s*$/g, '').replace(/\s+/g, ' ')
      if (text !== '') parent.appendChild(document.createTextNode(text))
    }
  }
}

export interface PageOptions {
  hash?: string
  storage?: Record<string, string>
  width?: number
}

export interface Page {
  document: PageDocument
  storage: Record<string, string>
  location: { hash: string }
  window: PageNode
  byId(id: string): PageNode
}

export function openPlanPage(html: string, options: PageOptions = {}): Page {
  const bodyStart = html.indexOf('<body>') + '<body>'.length
  const scriptStart = html.indexOf('<script>', bodyStart)
  const scriptEnd = html.lastIndexOf('</script>')
  if (bodyStart < 0 || scriptStart < 0 || scriptEnd < 0) throw new Error('the page is not shaped as the template ships it')

  const document = new PageDocument()
  const lang = /<html lang="([^"]*)"/.exec(html)
  if (lang) document.documentElement.setAttribute('lang', lang[1]!)
  // The data block is markup like the rest, but its text is JSON and must not be re-spaced.
  const dataBlock = /<script type="application\/json" id="plan-data">([\s\S]*?)<\/script>/.exec(html)!
  const data = document.body.appendChild(document.createElement('script'))
  data.id = 'plan-data'
  data.textContent = dataBlock[1]!
  parseMarkup(html.slice(bodyStart, scriptStart).replace(dataBlock[0], ''), document, document.body)
  const wrap = document.querySelector('.wrap')
  if (wrap) wrap.clientWidth = options.width ?? 1100

  const storage: Record<string, string> = { ...options.storage }
  const location = { hash: options.hash ?? '' }
  const window = new PageNode('#window')
  Object.assign(window, {
    location,
    localStorage: {
      getItem: (key: string) => (Object.hasOwn(storage, key) ? storage[key] : null),
      setItem: (key: string, value: string) => {
        storage[key] = String(value)
      },
    },
    navigator: { clipboard: { writeText: () => Promise.resolve() } },
    requestAnimationFrame: (callback: () => void) => callback(),
    setTimeout: () => 0,
    clearTimeout: () => {},
    matchMedia: () => ({ matches: false, addEventListener() {} }),
  })

  // oxlint-disable-next-line no-new-func -- the page is a classic script with no module to import
  new Function('window', 'document', 'URL', 'Blob', html.slice(scriptStart + '<script>'.length, scriptEnd))(
    window,
    document,
    { createObjectURL: () => 'blob:plan', revokeObjectURL() {} },
    class {},
  )

  return {
    document,
    storage,
    location,
    window,
    byId(id) {
      const node = document.getElementById(id)
      if (!node) throw new Error(`the page has no #${id}`)
      return node
    },
  }
}

const WORDED_ATTRIBUTES = ['aria-label', 'placeholder', 'title'] as const

/**
 * Everything the page says and every place it links, in document order: one line per
 * text node, per worded attribute and per `href`. Hidden state and styling are left out,
 * so two renderings that read the same compare equal.
 */
export function pageWords(root: PageNode, skip: (node: PageNode) => boolean = () => false): string[] {
  const lines: string[] = []
  const visit = (node: PageNode): void => {
    if (skip(node) || node.id === 'plan-data') return
    if (node.nodeType === 3) {
      if (node.text !== '') lines.push(node.text)
      return
    }
    // The accessible name either way, so naming a region by its heading reads as the label it replaced.
    const labelledBy = root.all().find((other) => other.id !== '' && other.id === node.attributes['aria-labelledby'])
    if (labelledBy) lines.push(`@aria-label ${labelledBy.textContent}`)
    for (const name of WORDED_ATTRIBUTES) {
      const value = node.attributes[name] ?? (typeof node[name] === 'string' ? (node[name] as string) : undefined)
      if (value) lines.push(`@${name} ${value}`)
    }
    if (node.attributes.href) lines.push(`-> ${node.attributes.href}`)
    node.childNodes.forEach(visit)
  }
  visit(root)
  return lines
}

/** Adjacent text joined, so a sentence built from three text nodes equals one built from one. */
export function pageSentences(root: PageNode, skip?: (node: PageNode) => boolean): string[] {
  const joined: string[] = []
  let open = false
  for (const line of pageWords(root, skip)) {
    const isText = !line.startsWith('@') && !line.startsWith('-> ')
    if (isText && open) joined[joined.length - 1] += line
    else joined.push(line)
    open = isText
  }
  return joined
}
