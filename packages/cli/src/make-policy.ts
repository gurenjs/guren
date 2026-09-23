import type { ScaffoldFileEntry, WriterOptions } from './utils'
import { scaffoldFileEntry, writeScaffoldFile } from './utils'

const POLICY_DIR = 'app/Policies'

function policyTemplate(className: string): string {
  const modelName = className.replace(/Policy$/, '')
  const variableName = modelName.charAt(0).toLowerCase() + modelName.slice(1)

  return `import { Policy, type AuthUser } from '@guren/core'

interface ${modelName}Like {
  userId?: string | number
}

export class ${className} extends Policy {
  viewAny(_user: AuthUser | null): boolean {
    return true
  }

  view(_user: AuthUser | null, _${variableName}: ${modelName}Like): boolean {
    return true
  }

  create(user: AuthUser | null): boolean {
    return user !== null
  }

  update(user: AuthUser | null, ${variableName}: ${modelName}Like): boolean {
    return user !== null && user.id === ${variableName}.userId
  }

  delete(user: AuthUser | null, ${variableName}: ${modelName}Like): boolean {
    return user !== null && user.id === ${variableName}.userId
  }
}
`
}

export async function makePolicy(name: string, options: WriterOptions = {}): Promise<string> {
  const { path, contents } = policyFile(name, options)
  return writeScaffoldFile(path, contents, options)
}

export function policyFile(name: string, options: WriterOptions = {}): ScaffoldFileEntry {
  return scaffoldFileEntry(name, {
    dir: POLICY_DIR,
    suffix: 'Policy',
    template: ({ normalizedName }) => policyTemplate(normalizedName),
  }, options)
}
