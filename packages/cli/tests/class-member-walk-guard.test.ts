import { readdir, readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { describe, expect, it } from 'bun:test'

const SRC_DIR = fileURLToPath(new URL('../src', import.meta.url))

/**
 * `controller-methods.ts` owns `classActionMembers`, the one answer to which
 * members of a controller class are actions. A copy elsewhere is wrong the
 * same way every time: `Router` dispatches to `store = async () => {}` exactly
 * as to `async store() {}`, so class-field actions get reported as absent.
 */
const OWNS_THE_RULE = new Set(['controller-methods.ts'])

/** Quoted, so prose spelling the name in backticks is not flagged. */
const TYPE_TEST = /['"]ClassMethod['"]/

/**
 * Pinned at the source level: another copy compiles, passes every other test,
 * and only under-reports, so nothing at runtime distinguishes it.
 */
describe('the controller-action rule has one home', () => {
  it('has no class-member type test outside controller-methods.ts', async () => {
    const entries = await readdir(SRC_DIR, { withFileTypes: true, recursive: true })
    const offenders: string[] = []

    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.ts')) continue
      if (OWNS_THE_RULE.has(entry.name)) continue
      const path = join(entry.parentPath ?? SRC_DIR, entry.name)
      if (TYPE_TEST.test(await readFile(path, 'utf8'))) offenders.push(entry.name)
    }

    expect(
      offenders,
      `${offenders.join(', ')} spells its own class-member type test. Walk the members with `
      + '`classActionMembers(classDecl)` from ./controller-methods instead, so a controller action '
      + 'written as a class field is not invisible to it. If this scanner genuinely wants method '
      + 'declarations only, say why in a comment and add its file name to OWNS_THE_RULE here.',
    ).toEqual([])
  })
})
