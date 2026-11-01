/**
 * The one spelling of boot-time seeding in `config/database.ts`, and the reading
 * of the denylist form older scaffolds shipped. Seeders write demo accounts, so
 * seeding is allowed by name: an unset NODE_ENV must not seed.
 * `packages/create-app/templates/database/` spells the same expression.
 */
import type { Expression, Node } from '@babel/types'
import { memberKeyName, objectLiteral, unwrapTypeAssertion, walk } from './ast-walk'
import { parseSourceFile } from './parse-cache'

export const SEED_ON_BOOT_EXPRESSION = "process.env.NODE_ENV === 'development' || process.env.NODE_ENV === 'test'"

export const SEED_ON_BOOT_OPTION = `{ seedOnBoot: ${SEED_ON_BOOT_EXPRESSION} }`

export const SEED_ON_BOOT_DEV_SCRIPT_NOTE = 'Start bin/serve.ts under NODE_ENV=development in the dev script (`"dev:server": "NODE_ENV=development bun --hot bin/serve.ts"`), or `bun run dev` stops seeding on boot.'

function isNodeEnv(node: Node): boolean {
  if (node.type !== 'MemberExpression' || node.object.type !== 'MemberExpression') return false
  const env = node.object
  return memberKeyName({ computed: node.computed, key: node.property }) === 'NODE_ENV'
    && memberKeyName({ computed: env.computed, key: env.property }) === 'env'
    && env.object.type === 'Identifier' && env.object.name === 'process'
}

function isNotProduction(node: Node): boolean {
  if (node.type !== 'BinaryExpression' || (node.operator !== '!==' && node.operator !== '!=')) return false
  const [left, right] = [unwrapTypeAssertion(node.left as Expression), unwrapTypeAssertion(node.right)]
  const production = (side: Node) => side.type === 'StringLiteral' && side.value === 'production'
  return (isNodeEnv(left) && production(right)) || (production(left) && isNodeEnv(right))
}

function seedsUnlessProduction(value: Node): boolean {
  const node = unwrapTypeAssertion(value)
  if (isNotProduction(node)) return true
  return node.type === 'LogicalExpression' && (seedsUnlessProduction(node.left) || seedsUnlessProduction(node.right))
}

/**
 * The lines of each `seedOnBoot` passed to `defineDatabaseConfig()` that still
 * compares `NODE_ENV !== 'production'`, alone or as an operand of `&&`/`||`/`??`.
 * `null` when the file does not parse.
 */
export function findLegacySeedOnBoot(source: string, filePath: string): number[] | null {
  const ast = parseSourceFile(source, filePath)
  if (!ast) return null
  const lines: number[] = []
  walk(ast.program, (node) => {
    if (node.type !== 'CallExpression') return
    const callee = node.callee as Node
    if (callee.type !== 'Identifier' || callee.name !== 'defineDatabaseConfig') return
    for (const argument of node.arguments as Node[]) {
      for (const member of objectLiteral(argument)?.properties ?? []) {
        if (member.type !== 'ObjectProperty' || memberKeyName(member) !== 'seedOnBoot') continue
        if (seedsUnlessProduction(member.value)) lines.push(member.loc?.start.line ?? 0)
      }
    }
  })
  return lines
}
