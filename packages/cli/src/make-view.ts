import { assertNotApiOnly } from './app-surface'
import type { WriterOptions } from './utils'
import { pascalCase, safePathSegments, writeRoot, writeScaffoldFile } from './utils'

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

/**
 * Refuses a confirmed API-only app: codegen leaves the page out of
 * `.guren/pages.gen.ts` (`planPageManifest`), so nothing could render it.
 */
export async function makeView(name: string, options: WriterOptions = {}): Promise<string> {
  // Before the shape check, so a malformed name reports as a usage error
  // rather than being masked by the app's shape.
  const segments = safePathSegments(name, 'view name')
  const componentName = pascalCase(segments[segments.length - 1]!)
  const filePath = `${VIEW_ROOT}/${segments.join('/')}.tsx`
  const appRoot = writeRoot(options)
  await assertNotApiOnly(appRoot, {
    does: 'guren make:view scaffolds a React page component',
    instead: 'Scaffold a JSON controller with guren make:controller and register it in routes/api.ts',
  })
  return writeScaffoldFile(filePath, viewTemplate(componentName), { ...options, cwd: appRoot })
}
