import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'bun:test'
import { CONTROLLER_MEMBER_KINDS } from '../src/controller-methods'
import { extractClassDeclaration } from '../src/model-parser'
import { parseSourceFile } from '../src/parse-cache'

/**
 * Pins `CONTROLLER_MEMBER_KINDS` to the real `Controller` surface, because a
 * member the audit's body-access rule doesn't know about is reported as a
 * *pass* — the gap looks like a clean bill of health. The same map now backs
 * the `this.<member>(` patterns both `guren audit` and the agent-route checks
 * spell, so a rename that lands here fails their compile rather than leaving
 * a regex quietly matching nothing.
 *
 * Reads the source rather than `Controller.prototype`: `packages/cli` resolves
 * `@guren/server` through `dist/`, so a prototype check would keep passing
 * against a stale build, and TS `private` is erased at runtime, which would
 * drag internals app code cannot call into the classification.
 */
const CONTROLLER_PATH = fileURLToPath(new URL('../../server/src/mvc/Controller.ts', import.meta.url))

/**
 * Method and getter names an action can call: instance members that are
 * `protected` or (explicitly or by omission) `public`. Class *properties* are
 * left out — the only one on the public surface is the static `inject` DI hint,
 * which is configuration, not something a method body invokes.
 *
 * Throws on any eligible member this cannot name (a computed or string-literal
 * key). Skipping those quietly would let one be added without classification,
 * which is the failure this guard exists to prevent.
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
      if (member.type !== 'ClassMethod' && member.type !== 'TSDeclareMethod') continue
      if (member.static || member.accessibility === 'private' || member.kind === 'constructor') continue
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
