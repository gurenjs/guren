import { readdir, readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { describe, expect, it } from 'bun:test'

const SRC_DIR = fileURLToPath(new URL('../src', import.meta.url))

/**
 * Files allowed to spell a class-member type test themselves, and why.
 *
 * `controller-methods.ts` owns `classActionMembers`, the one answer to which
 * members of a controller class are actions. Anywhere else, a bare
 * `member.type === 'ClassMethod'` is a second copy of that answer — and a
 * copy that is wrong the same way every time, because `Router` dispatches to
 * `store = async () => {}` exactly as it does to `async store() {}`. Four
 * scanners held such a copy and each silently reported class-field actions as
 * absent rather than as unverified.
 */
const OWNS_THE_RULE = new Set(['controller-methods.ts'])

/**
 * A quoted `'ClassMethod'` / `"ClassMethod"` — the shape a type test takes.
 * Prose in a comment (which this repo writes a lot of) spells it in backticks
 * and does not match, so the guard does not tax explaining the rule.
 */
const TYPE_TEST = /['"]ClassMethod['"]/

/**
 * A sixth copy of the controller-action rule compiles, passes every other
 * test, and quietly under-reports — nothing at runtime distinguishes it from
 * the shared iterator, which is why this is pinned at the source level. Same
 * argument as `controller-surface.test.ts` re-parsing `Controller.ts`.
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
