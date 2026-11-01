import { describe, expect, it, test } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'

import { formTagProblems } from './form-tags'

const repoRoot = join(import.meta.dir, '../../..')
const TEMPLATE_ROOTS = ['packages/create-app/templates', 'packages/cli/templates/scaffold']

/** Submits a QUERY route through the typed client and names no field. */
const CLIENT_ONLY_FORM = 'packages/create-app/templates/blog/resources/js/pages/posts/Index.tsx'

function collectTsx(dir: string): string[] {
  const found: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) found.push(...collectTsx(path))
    else if (entry.name.endsWith('.tsx')) found.push(path)
  }
  return found
}

test('formTagProblems reports a form with no method, and one with an undefined action', () => {
  expect(formTagProblems('const a = <form onSubmit={(e) => e.preventDefault()}><input name="p" /></form>')).toEqual([
    'page.tsx:1: method=null action=null',
  ])
  expect(formTagProblems('const a = <form method="post" action={undefined}></form>')).toEqual([
    'page.tsx:1: method=post action={undefined}',
  ])
  expect(formTagProblems('const a = <form method="post" action={c.path}></form>')).toEqual([])
})

describe('shipped template forms submit as POST to their route before hydration', () => {
  const files = TEMPLATE_ROOTS.flatMap((root) => collectTsx(join(repoRoot, root)))
    .map((file) => relative(repoRoot, file))
    .filter((file) => readFileSync(join(repoRoot, file), 'utf8').includes('<form'))

  test('the exempt form still exists and still has no method', () => {
    expect(formTagProblems(readFileSync(join(repoRoot, CLIENT_ONLY_FORM), 'utf8'))).toHaveLength(1)
  })

  it.each(files.filter((file) => file !== CLIENT_ONLY_FORM))('%s', (file) => {
    expect(formTagProblems(readFileSync(join(repoRoot, file), 'utf8'), file)).toEqual([])
  })
})
