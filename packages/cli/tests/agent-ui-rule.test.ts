import { expect, it } from 'bun:test'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { PRIMARY_BUTTON_CLASS, PRIMARY_SUBMIT_CLASS } from '../src/guren-css'

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
    read('src/guren-css.ts'),
    read('src/make-feature.ts'),
    read('src/make-auth.ts'),
  ])
  const strings = [...section(rule, 'The shared class strings').matchAll(/^\| [^|]+ \| `([^`]+)`/gm)].map(
    (match) => match[1]!,
  )
  expect(strings.length).toBeGreaterThan(8)
  expect(strings.filter((classes) => !sources.some((source) => source.includes(classes)))).toEqual([])
})

it('the ui rule describes the full-width submit as PRIMARY_SUBMIT_CLASS is built', async () => {
  const row = section(await readRule(), 'The shared class strings').match(/^\| Full-width submit \|.*$/m)?.[0] ?? ''
  const [first, last] = [...row.matchAll(/`([^`]+)`/g)].map((match) => match[1]!)
  expect(PRIMARY_SUBMIT_CLASS).toBe(`${first} ${PRIMARY_BUTTON_CLASS} ${last}`)
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
