import { classNameFromPath, excludeBarrelFiles } from './discovery'

export interface ControllerExport {
  readonly file: string
  readonly exportName: string
}

/**
 * The file that declares a class several files export (RFC 0026 §3): the one
 * named after it, else any non-barrel, else the first. A barrel re-exports the
 * class too, and discovery's order is the filesystem's, so none may decide it.
 */
export function pickDeclaringFile(candidates: readonly ControllerExport[], className: string): ControllerExport | undefined {
  return candidates.find(({ file }) => classNameFromPath(file) === className)
    ?? candidates.find(({ file }) => excludeBarrelFiles([file]).length > 0)
    ?? candidates[0]
}
