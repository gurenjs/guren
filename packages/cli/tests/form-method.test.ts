import { describe, expect, it, test } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'

import { walk, type BabelNode } from '../src/ast-walk'
import { parseSourceFile } from '../src/parse-cache'

const repoRoot = join(import.meta.dir, '../../..')
const TEMPLATE_ROOTS = ['packages/create-app/templates', 'packages/cli/templates/scaffold']

/**
 * A form submitted before React hydrates is a native submit: with no `method` it is a GET that
 * puts every named field, a password included, in the URL. The one form exempt submits a
 * QUERY route through the typed client and names no field.
 */
const CLIENT_ONLY_FORMS = new Set(['packages/create-app/templates/blog/resources/js/pages/posts/Index.tsx'])

interface FormTag {
  method: string | null
  action: string | null
  line: number
}

/** Each `<form>` opening tag's `method` (a string literal, else its source) and `action` source. */
function formTags(source: string, file = 'page.tsx'): FormTag[] {
  const ast = parseSourceFile(source, file)
  if (!ast) throw new Error(`${file} does not parse`)
  const tags: FormTag[] = []
  walk(ast.program, (node) => {
    if (node.type !== 'JSXOpeningElement') return
    const name = node.name as BabelNode
    if (name.type !== 'JSXIdentifier' || name.name !== 'form') return
    const attribute = (key: string): string | null => {
      for (const attr of node.attributes as BabelNode[]) {
        if (attr.type !== 'JSXAttribute' || (attr.name as BabelNode).name !== key) continue
        const value = attr.value as BabelNode | null
        if (value?.type === 'StringLiteral') return value.value as string
        const start = value?.start as number | undefined
        const end = value?.end as number | undefined
        return start !== undefined && end !== undefined ? source.slice(start, end) : ''
      }
      return null
    }
    tags.push({ method: attribute('method'), action: attribute('action'), line: node.loc?.start.line ?? 0 })
  })
  return tags
}

function collectTsx(dir: string): string[] {
  const found: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) found.push(...collectTsx(path))
    else if (entry.name.endsWith('.tsx')) found.push(path)
  }
  return found
}

test('formTags reads a form with no method as such', () => {
  expect(formTags('const a = <form className="x" onSubmit={(e) => e.preventDefault()}><input name="p" /></form>')).toEqual([
    { method: null, action: null, line: 1 },
  ])
  expect(formTags('const a = <form method="post" action={c.path}></form>')).toEqual([
    { method: 'post', action: '{c.path}', line: 1 },
  ])
})

describe('shipped template forms submit as POST to their route before hydration', () => {
  const pages = TEMPLATE_ROOTS.flatMap((root) => collectTsx(join(repoRoot, root)))
    .map((file) => ({ file: relative(repoRoot, file), tags: formTags(readFileSync(file, 'utf8'), file) }))
    .filter(({ tags }) => tags.length > 0)

  test('finds the auth and posts forms, and the exempt one still exists', () => {
    expect(pages.filter(({ file }) => !CLIENT_ONLY_FORMS.has(file)).length).toBeGreaterThanOrEqual(8)
    for (const exempt of CLIENT_ONLY_FORMS) {
      expect(pages.map(({ file }) => file)).toContain(exempt)
    }
  })

  it.each(pages.filter(({ file }) => !CLIENT_ONLY_FORMS.has(file)).map(({ file, tags }) => [file, tags] as const))('%s', (_file, tags) => {
    for (const tag of tags) {
      expect({ line: tag.line, method: tag.method }).toEqual({ line: tag.line, method: 'post' })
      expect(tag.action).toBeTruthy()
    }
  })
})
