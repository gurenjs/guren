import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'bun:test'
import { CONTROLLER_MEMBER_KINDS } from '../src/controller-methods'
import { extractClassDeclaration } from '../src/model-parser'
import { parseSourceFile } from '../src/parse-cache'

/**
 * Pins `CONTROLLER_MEMBER_KINDS` to the real `Controller` surface: a member the
 * audit's body-access rule doesn't know about is reported as a *pass*.
 * Reads the source rather than `Controller.prototype` — `packages/cli` resolves
 * `@guren/server` through `dist/`, so a prototype check would keep passing
 * against a stale build, and TS `private` is erased at runtime.
 */
const CONTROLLER_PATH = fileURLToPath(new URL('../../server/src/mvc/Controller.ts', import.meta.url))

/**
 * Names an action can call as `this.<name>(...)`: instance members that are
 * `protected` or public, written as a method, getter, overload signature, or
 * function-valued class field. Deliberately *not* `classActionMembers`, which
 * wants members holding a body and so excludes `TSDeclareMethod`. Throws on a
 * key it cannot name — skipping one would let it dodge classification.
 */
async function publicControllerSurface(): Promise<string[]> {
  const source = await readFile(CONTROLLER_PATH, 'utf8').catch(() => null)
  if (source === null) {
    throw new Error(
      `Could not read ${CONTROLLER_PATH}. If Controller.ts moved, update CONTROLLER_PATH here `
      + 'and re-check CONTROLLER_MEMBER_KINDS in src/controller-methods.ts against the new location.',
    )
  }

  const ast = parseSourceFile(source, CONTROLLER_PATH)
  if (!ast) throw new Error(`Could not parse ${CONTROLLER_PATH}.`)

  for (const node of ast.program.body) {
    const classDecl = extractClassDeclaration(node)
    if (classDecl?.id?.name !== 'Controller') continue

    const names = new Set<string>()
    for (const member of classDecl.body.body) {
      const callable =
        ((member.type === 'ClassMethod' || member.type === 'TSDeclareMethod')
          && member.kind !== 'constructor')
        || (member.type === 'ClassProperty'
          && (member.value?.type === 'ArrowFunctionExpression'
            || member.value?.type === 'FunctionExpression'))
      if (!callable) continue
      if (member.static || member.accessibility === 'private') continue
      if (member.key.type !== 'Identifier') {
        throw new Error(
          `Controller has a public/protected member with a ${member.key.type} key, which this guard `
          + 'cannot name. Give it an identifier key, or teach this test to resolve it — leaving it '
          + 'unnamed would let a body-reading accessor slip past CONTROLLER_MEMBER_KINDS.',
        )
      }
      names.add(member.key.name)
    }

    return [...names].sort()
  }

  throw new Error(`No 'Controller' class declaration found in ${CONTROLLER_PATH}.`)
}

describe('CONTROLLER_MEMBER_KINDS', () => {
  it('classifies every public/protected member of Controller', async () => {
    expect(Object.keys(CONTROLLER_MEMBER_KINDS).sort()).toEqual(await publicControllerSurface())
  })
})
