import { existsSync, symlinkSync, unlinkSync, lstatSync } from 'node:fs'
import { resolve, relative } from 'node:path'
import { consola } from 'consola'

export interface StorageLinkOptions {
  /**
   * Application root directory.
   */
  appRoot?: string

  /**
   * Force recreate the link.
   */
  force?: boolean

  /**
   * Use relative path for symlink.
   */
  relative?: boolean
}

const DEFAULT_STORAGE_PATH = 'storage/app/public'
const DEFAULT_PUBLIC_PATH = 'public/storage'

/**
 * Create a symbolic link from public/storage to storage/app/public.
 */
export function createStorageLink(options: StorageLinkOptions = {}): boolean {
  const appRoot = options.appRoot ? resolve(options.appRoot) : process.cwd()
  const storagePath = resolve(appRoot, DEFAULT_STORAGE_PATH)
  const publicPath = resolve(appRoot, DEFAULT_PUBLIC_PATH)

  // Check if storage directory exists
  if (!existsSync(storagePath)) {
    consola.error(`Storage directory not found: ${storagePath}`)
    consola.info('Create the directory first or check your configuration.')
    return false
  }

  // Check if link already exists
  if (existsSync(publicPath)) {
    if (options.force) {
      try {
        const stats = lstatSync(publicPath)
        if (stats.isSymbolicLink()) {
          unlinkSync(publicPath)
          consola.info('Removed existing symbolic link.')
        } else {
          consola.error(`${publicPath} exists and is not a symbolic link.`)
          consola.info('Remove it manually or use a different path.')
          return false
        }
      } catch {
        consola.error(`Failed to remove existing link: ${publicPath}`)
        return false
      }
    } else {
      // Check if it's already the correct link
      try {
        const stats = lstatSync(publicPath)
        if (stats.isSymbolicLink()) {
          consola.info('Storage link already exists.')
          return true
        }
      } catch {
        // Ignore
      }
      consola.warn(`${publicPath} already exists. Use --force to recreate.`)
      return false
    }
  }

  // Determine link target (relative or absolute)
  const linkTarget = options.relative
    ? relative(resolve(appRoot, 'public'), storagePath)
    : storagePath

  try {
    symlinkSync(linkTarget, publicPath, 'junction')
    consola.success(`Created storage link: ${DEFAULT_PUBLIC_PATH} → ${DEFAULT_STORAGE_PATH}`)
    return true
  } catch (error) {
    consola.error(`Failed to create symbolic link: ${error instanceof Error ? error.message : String(error)}`)
    return false
  }
}

/**
 * Remove the storage symbolic link.
 */
export function removeStorageLink(options: StorageLinkOptions = {}): boolean {
  const appRoot = options.appRoot ? resolve(options.appRoot) : process.cwd()
  const publicPath = resolve(appRoot, DEFAULT_PUBLIC_PATH)

  if (!existsSync(publicPath)) {
    consola.info('Storage link does not exist.')
    return true
  }

  try {
    const stats = lstatSync(publicPath)
    if (!stats.isSymbolicLink()) {
      consola.error(`${publicPath} is not a symbolic link.`)
      return false
    }

    unlinkSync(publicPath)
    consola.success('Storage link removed.')
    return true
  } catch (error) {
    consola.error(`Failed to remove storage link: ${error instanceof Error ? error.message : String(error)}`)
    return false
  }
}

/**
 * Check if storage link exists and is valid.
 */
export function hasStorageLink(options: StorageLinkOptions = {}): boolean {
  const appRoot = options.appRoot ? resolve(options.appRoot) : process.cwd()
  const publicPath = resolve(appRoot, DEFAULT_PUBLIC_PATH)

  if (!existsSync(publicPath)) {
    return false
  }

  try {
    const stats = lstatSync(publicPath)
    return stats.isSymbolicLink()
  } catch {
    return false
  }
}
