import { discoverModelFiles, excludeBarrelFiles, toPosixRelative } from './discovery'
import { discoverParsedModels, type DiscoveredModel } from './model-parser'

export interface ModelSourceReading {
  models: DiscoveredModel[]
  unparsedFiles: string[]
  unreadable?: string
}

/** Static metadata follows the model parser's first declared class rule; unreadable sources invalidate the whole reading. */
export async function readModelSources(root: string): Promise<ModelSourceReading> {
  try {
    const [models, files] = await Promise.all([discoverParsedModels(root), discoverModelFiles(root)])
    const parsed = new Set(models.map((model) => model.relPath))
    return { models, unparsedFiles: excludeBarrelFiles(files).map((file) => toPosixRelative(root, file)).filter((file) => !parsed.has(file)) }
  } catch (error) {
    return { models: [], unparsedFiles: [], unreadable: error instanceof Error ? error.message : String(error) }
  }
}
