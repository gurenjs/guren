import { expect, it } from 'bun:test'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { UI_COMPONENTS, uiComponentPath } from '../src/guren-css'
import { buttonClass } from '../templates/scaffold/ui/resources/js/components/ui/Button'

const read = (path: string) => readFile(join(import.meta.dir, '..', path), 'utf8')
const readRule = () => read('templates/agent/core/rules/ui.md')
const readTokens = () => read('templates/scaffold/guren-ui/resources/css/guren.css')

function section(markdown: string, heading: string): string {
  const start = markdown.indexOf(`\n## ${heading}\n`)
  expect(start).toBeGreaterThan(-1)
  const end = markdown.indexOf('\n## ', start + 1)
  return markdown.slice(start, end === -1 ? undefined : end)
}

it('every class string the ui rule lists is one the generators emit', async () => {
  const [rule, ...sources] = await Promise.all([
    readRule(),
    read('src/make-feature.ts'),
    read('src/make-auth.ts'),
    ...UI_COMPONENTS.map((name) => read(`templates/scaffold/ui/${uiComponentPath(name)}`)),
  ])
  const strings = [...section(rule, 'The shared class strings').matchAll(/^\| [^|]+ \| `([^`]+)`/gm)].map(
    (match) => match[1]!,
  )
  expect(strings.length).toBeGreaterThan(8)
  expect(strings.filter((classes) => !sources.some((source) => source.includes(classes)))).toEqual([])
})

const repoRoot = join(import.meta.dir, '../../..')
const PAGE_SOURCES = ['packages/cli/templates/scaffold', 'packages/create-app/templates', 'examples/agents/resources/js']

/** Every page and component the scaffolds ship, and the generators that write pages as strings. */
function readPageSources(): Promise<string[]> {
  const pages = PAGE_SOURCES.flatMap((dir) =>
    [...new Bun.Glob('**/*.tsx').scanSync({ cwd: join(repoRoot, dir) })].map((path) => join(repoRoot, dir, path)),
  )
  return Promise.all([
    read('src/make-feature.ts'),
    read('src/make-auth.ts'),
    ...pages.map((path) => readFile(path, 'utf8')),
  ])
}

// Tailwind v4's `outline-none` sets the style variable `outline-2` reads, so the ring needs its own style.
it('every class list that drops the outline gives its focus state a solid one', async () => {
  const sources = [await readRule(), ...(await readPageSources())]
  // A class list has spaces; the rule's prose names `outline-none` alone.
  const strings = sources
    .flatMap((text) => [...text.matchAll(/[`'"]([^`'"\n]*\boutline-none\b[^`'"\n]*)[`'"]/g)].map((match) => match[1]!))
    .filter((classes) => classes.includes(' '))
  expect(strings.length).toBeGreaterThan(3)
  expect(strings.filter((classes) => !classes.split(' ').includes('focus:outline-solid'))).toEqual([])
})

// axe's link-in-text-block: a link that shares its paragraph with words is told apart by more than color.
it('every link inside a sentence on a shipped page uses the underlined class string', async () => {
  const [rule, sources] = await Promise.all([readRule(), readPageSources()])
  const inSentence = section(rule, 'The shared class strings').match(/^\| Text link inside a sentence \| `([^`]+)`/m)?.[1]
  expect(inSentence).toContain('underline ')

  const paragraphs = sources.flatMap((text) => [...text.matchAll(/<p\b[^>]*>([\s\S]*?)<\/p>/g)].map((match) => match[1]!))
  const sentencesWithLinks = paragraphs.filter((body) => {
    const words = body
      .replace(/<(Link|a)\b[\s\S]*?<\/\1>/g, '')
      .replace(/\{[^}]*\}/g, '')
      .replace(/<[^>]*>/g, '')
    return /<(?:Link|a)\b/.test(body) && /[A-Za-z]/.test(words)
  })
  expect(sentencesWithLinks.length).toBeGreaterThan(2)
  expect(sentencesWithLinks.filter((body) => !body.includes(`className="${inSentence}"`))).toEqual([])
})

it('the ui rule describes the full-width submit as the Button component builds its block variant', async () => {
  const strings = section(await readRule(), 'The shared class strings')
  const primary = strings.match(/^\| Primary button \| `([^`]+)`/m)?.[1]
  const row = strings.match(/^\| Full-width submit \|.*$/m)?.[0] ?? ''
  const [first, last] = [...row.matchAll(/`([^`]+)`/g)].map((match) => match[1]!)
  expect(primary).toBeDefined()
  expect(buttonClass({ block: true })).toBe(`${first} ${primary} ${last}`)
})

it('the ui rule lists exactly the tokens guren.css declares', async () => {
  const [rule, tokens] = await Promise.all([readRule(), readTokens()])
  const declared = [...tokens.matchAll(/--g-([\w-]+):/g)].map((match) => match[1]!)
  // A row's names drop `--g-`; a name starting with `-` (`-chip`) is a suffix on the row's other names.
  const listed = [...section(rule, 'The tokens').matchAll(/^\| [^|]+ \| ([^|]+) \|/gm)].flatMap((row) => {
    const names = [...row[1]!.matchAll(/`([\w-]+)`/g)].map((match) => match[1]!)
    const bases = names.filter((name) => !name.startsWith('-'))
    const suffixes = names.filter((name) => name.startsWith('-') && !name.startsWith('--'))
    return [...bases, ...bases.flatMap((base) => suffixes.map((suffix) => base + suffix))]
  })
  expect(listed.length).toBeGreaterThan(30)
  expect(listed.filter((name) => !declared.includes(name))).toEqual([])
  expect(declared.filter((name) => !listed.includes(name))).toEqual([])
})

it('every g- utility the ui rule names is mapped in guren.css', async () => {
  const [rule, tokens] = await Promise.all([readRule(), readTokens()])
  const mapped = [...tokens.matchAll(/--(?:color|radius|shadow)-(g-[\w-]+):/g)].map((match) => match[1])
  const utilities = [...rule.matchAll(/\b(?:bg|text|border|outline|accent|rounded|shadow)-(g-[\w-]+)/g)].map(
    (match) => match[1]!,
  )
  expect(utilities.length).toBeGreaterThan(10)
  expect(utilities.filter((utility) => !mapped.includes(utility))).toEqual([])
})
