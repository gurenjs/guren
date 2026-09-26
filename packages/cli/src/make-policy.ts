import { POLICIES_DIR } from './discovery'
import type { ScaffoldFileEntry, WriterOptions } from './utils'
import { scaffoldFileEntry, writeScaffoldFile } from './utils'

export interface PolicyAbilitySource {
  /** A line comment above the method, without the slashes. */
  comment?: string
  /** The method's name and parameter list, e.g. `create(user: AuthUser | null)`. */
  signature: string
  body: string
}

/** The policy source `make:policy` and `plan:scaffold` write: `plan/policy-abilities.ts` reads each ability as a method of a class extending `Policy`. */
export function buildPolicySource(options: { className: string; declarations?: string; abilities: readonly PolicyAbilitySource[] }): string {
  const methods = options.abilities.map((ability) => {
    const comment = ability.comment === undefined ? '' : `  // ${ability.comment}\n`
    return `${comment}  ${ability.signature}: boolean {\n    ${ability.body}\n  }\n`
  })
  return `import { Policy, type AuthUser } from '@guren/core'

${options.declarations ? `${options.declarations}\n` : ''}export class ${options.className} extends Policy {
${methods.join('\n')}}
`
}

function policyTemplate(className: string): string {
  const modelName = className.replace(/Policy$/, '')
  const variableName = modelName.charAt(0).toLowerCase() + modelName.slice(1)

  return buildPolicySource({
    className,
    declarations: `interface ${modelName}Like {\n  userId?: string | number\n}\n`,
    abilities: [
      { signature: 'viewAny(_user: AuthUser | null)', body: 'return true' },
      { signature: `view(_user: AuthUser | null, _${variableName}: ${modelName}Like)`, body: 'return true' },
      { signature: 'create(user: AuthUser | null)', body: 'return user !== null' },
      { signature: `update(user: AuthUser | null, ${variableName}: ${modelName}Like)`, body: `return user !== null && user.id === ${variableName}.userId` },
      { signature: `delete(user: AuthUser | null, ${variableName}: ${modelName}Like)`, body: `return user !== null && user.id === ${variableName}.userId` },
    ],
  })
}

export async function makePolicy(name: string, options: WriterOptions = {}): Promise<string> {
  const { path, contents } = policyFile(name, options)
  return writeScaffoldFile(path, contents, options)
}

export function policyFile(name: string, options: WriterOptions = {}): ScaffoldFileEntry {
  return scaffoldFileEntry(name, {
    dir: POLICIES_DIR,
    suffix: 'Policy',
    template: ({ normalizedName }) => policyTemplate(normalizedName),
  }, options)
}
