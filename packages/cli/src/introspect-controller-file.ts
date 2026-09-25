import type { AppManifest } from '@guren/server'

import { classNameFromPath, excludeBarrelFiles } from './discovery'

const IMPORT_FAILED = ' could not be imported: '

/** The `controller-import` warning the child leaves for a controller file whose import threw. */
export function controllerImportWarning(file: string, reason: string): AppManifest['warnings'][number] {
  return { code: 'controller-import', message: `${file}${IMPORT_FAILED}${reason}` }
}

/** The controller files, POSIX-relative, the child could not import: a class there may be the routed one. */
export function controllerImportFailures(manifest: Pick<AppManifest, 'warnings'>): string[] {
  return manifest.warnings.flatMap((warning) => {
    const at = warning.code === 'controller-import' ? warning.message.indexOf(IMPORT_FAILED) : -1
    return at > 0 ? [warning.message.slice(0, at)] : []
  })
}

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
