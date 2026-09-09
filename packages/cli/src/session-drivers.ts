import { BUILT_IN_SESSION_DRIVERS } from '@guren/core'
import { readInstalledPluginManifests } from './plugin-manifest'

/**
 * The one rule for "does this session driver exist, and does it survive a
 * runtime that shares no memory between requests". Built-ins plus every
 * installed plugin's `gurenPlugin.drivers.session`. Nothing here boots the
 * app, so a driver registered only in application code is *unknown* — which
 * callers must report as unverified rather than as absent (RFC 0020 §4).
 */
export type SessionDriverRegistry = ReadonlyMap<string, boolean>

export async function resolveSessionDrivers(cwd: string = process.cwd()): Promise<SessionDriverRegistry> {
  const drivers = new Map<string, boolean>(BUILT_IN_SESSION_DRIVERS)

  for (const { manifest } of await readInstalledPluginManifests(cwd)) {
    for (const declared of manifest.drivers?.session ?? []) {
      // A plugin cannot redefine a built-in: the framework's own registration
      // wins at runtime, so letting a manifest claim `memory` is persistent
      // would make the check vouch for a store that is not there.
      if (!declared?.name || BUILT_IN_SESSION_DRIVERS.has(declared.name)) continue
      drivers.set(declared.name, declared.persistent === true)
    }
  }

  return drivers
}
