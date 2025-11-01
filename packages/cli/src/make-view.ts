import type { WriterOptions } from './utils'
import { pascalCase, writeFileSafe } from './utils'

const VIEW_ROOT = 'resources/js/pages'

function viewTemplate(componentName: string): string {
  return `import type { FC } from 'react'

interface ${componentName}Props {
  message?: string
}

const ${componentName}: FC<${componentName}Props> = ({ message }) => {
  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-bold">${componentName}</h1>
      {message ? <p>{message}</p> : null}
    </div>
  )
}

export default ${componentName}
`
}

export async function makeView(name: string, options: WriterOptions = {}): Promise<string> {
  const normalized = name.replace(/^\/+|\/+$/gu, '')
  const componentName = pascalCase(normalized.split('/').pop() ?? normalized)
  const filePath = `${VIEW_ROOT}/${normalized}.tsx`
  return writeFileSafe(filePath, viewTemplate(componentName), options)
}
