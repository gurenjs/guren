/**
 * The one rule that keeps a manifest's `drizzle-orm` and `drizzle-kit` pins on
 * the copy `@guren/orm` brings with it. `@guren/orm` names an exact `drizzle-orm`
 * version, so a manifest pinning a different one installs a second nested copy:
 * the app builds its table descriptors against one while the adapter runs on the
 * other. `drizzle-kit` has no upstream declaration to read and has never shared
 * numbers with `drizzle-orm` on the stable lines, so the companion release is
 * checked for existence before its version is written. Two callers: `guren upgrade`
 * against the published ORM manifest, `scripts/sync-template-deps.ts` against this repository's.
 */
import { isExactVersion, isLocationSpecifier } from './codemods'

/** The dependency whose version is read from `@guren/orm`'s own manifest. */
export const PIN_SOURCE = 'drizzle-orm'

/** Kept in step with what `@guren/orm` depends on, not with each other. */
const DRIZZLE_PACKAGES = [PIN_SOURCE, 'drizzle-kit'] as const

/** The fields that install a copy, so a duplicate of the pinned package is possible. */
const PINNED_FIELDS = ['dependencies', 'devDependencies'] as const

/** Every field a `@guren/orm` declaration can appear in. */
const MANIFEST_FIELDS = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'] as const

export type PinnedField = (typeof PINNED_FIELDS)[number]

/** The parts of a `package.json` this rule reads; anything else is ignored. */
export interface DependencyManifest {
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
  peerDependencies?: Record<string, string>
  optionalDependencies?: Record<string, string>
}

/** `@guren/orm`'s own manifest — published, or the one in this workspace. */
export interface OrmManifest {
  version: string
  dependencies?: Record<string, string>
}

export interface DrizzlePinChange {
  field: PinnedField
  name: string
  previousVersion: string
  nextVersion: string
}

/**
 * Why a pin the rule looked at was left where it is. Refusals are part of the
 * verdict: a caller reading only the changes cannot tell "nothing to do" from
 * "drift I will not touch". `guren upgrade` reports all four and moves on; the
 * template sync fails on the two a maintainer can fix in this repository.
 */
export type DrizzlePinDeclineReason =
  /** `@guren/orm` names no single exact `drizzle-orm` version to follow. */
  | 'no-exact-pin'
  /** The pin names a place rather than a release; rewriting it would change what runs. */
  | 'location-specifier'
  /** The companion release does not exist, so there is nothing to move that pin to. */
  | 'companion-unpublished'
  /** The registry could not answer, so whether the companion release exists is unknown. */
  | 'companion-unverifiable'

export interface DrizzlePinDecline {
  reason: DrizzlePinDeclineReason
  /** Names what was left alone and why, ready to print. */
  message: string
}

export interface DrizzlePinOptions {
  /**
   * Does `<name>@<version>` exist as a release? Asked only about the companion,
   * only when its pin has to move, and at most once per version per call. A
   * rejection becomes a `companion-unverifiable` decline, so an unreachable
   * registry cannot read as "nothing to align".
   */
  companionPublished: (name: string, version: string) => Promise<boolean>
  onDecline?: (decline: DrizzlePinDecline) => void
}

interface DrizzlePin {
  field: PinnedField
  name: string
  current: string
}

function collectPins(manifest: DependencyManifest): DrizzlePin[] {
  return PINNED_FIELDS.flatMap((field) => {
    const dependencies = manifest[field] ?? {}
    return DRIZZLE_PACKAGES.filter((name) => dependencies[name]).map((name) => ({
      field,
      name,
      current: dependencies[name] as string,
    }))
  })
}

/**
 * The version being matched is the one `@guren/orm` installs, so a manifest that
 * does not use the ORM has no duplicate to avoid and no reason to follow its pin.
 */
function usesGurenOrm(manifest: DependencyManifest): boolean {
  return MANIFEST_FIELDS.some((field) => Boolean(manifest[field]?.['@guren/orm']))
}

/**
 * Whether this manifest has anything to align — checked before the ORM manifest
 * is fetched, so a manifest without drizzle pins costs no request.
 */
export function needsDrizzleAlignment(manifest: DependencyManifest): boolean {
  return collectPins(manifest).length > 0 && usesGurenOrm(manifest)
}

/**
 * The pin rewrites this manifest needs to dedupe on `@guren/orm`'s drizzle copy.
 * Returned rather than applied, because the two callers write them differently
 * but need the same verdict. Everything this refuses to rewrite goes to
 * `onDecline`.
 */
export async function planDrizzlePins(
  manifest: DependencyManifest,
  orm: OrmManifest,
  { companionPublished, onDecline = () => {} }: DrizzlePinOptions,
): Promise<DrizzlePinChange[]> {
  if (!needsDrizzleAlignment(manifest)) {
    return []
  }

  const source = `@guren/orm@${orm.version}`
  const pin = orm.dependencies?.[PIN_SOURCE]
  if (!pin) {
    onDecline({
      reason: 'no-exact-pin',
      message: `Could not read the ${PIN_SOURCE} version ${source} depends on — leaving the drizzle pins alone.`,
    })
    return []
  }

  // Deduping only works if the ORM names one exact version: a range lets the
  // manifest and the nested copy resolve differently, which is what is broken.
  if (!isExactVersion(pin)) {
    onDecline({
      reason: 'no-exact-pin',
      message: `${source} depends on ${PIN_SOURCE} "${pin}", which is not a single exact version — leaving the drizzle pins alone.`,
    })
    return []
  }

  // The loop can ask about the same package twice (`drizzle-kit` declared in
  // both dependency fields), so the dedupe belongs here. A memo across
  // *manifests* is still the caller's business.
  const asked = new Map<string, Promise<boolean | null>>()
  const exists = (name: string): Promise<boolean | null> => {
    let pending = asked.get(name)
    if (!pending) {
      // A registry that cannot answer is its own verdict, not a crash: the
      // template sync gates CI on this, and an npm blip must not fail a PR.
      pending = companionPublished(name, pin).catch(() => null)
      asked.set(name, pending)
    }
    return pending
  }

  const changes: DrizzlePinChange[] = []
  for (const { field, name, current } of collectPins(manifest)) {
    if (current === pin) {
      continue
    }
    if (isLocationSpecifier(current)) {
      onDecline({
        reason: 'location-specifier',
        message: `${field}.${name} is "${current}", which names a location rather than a release — leaving it alone. Align it with ${PIN_SOURCE} ${pin} yourself if you want the ORM's copy deduped.`,
      })
      continue
    }
    // Only the companion needs checking: `pin` came from the ORM's own
    // dependency on PIN_SOURCE, so that version necessarily exists.
    if (name !== PIN_SOURCE) {
      const published = await exists(name)
      if (published === null) {
        onDecline({
          reason: 'companion-unverifiable',
          message: `Could not ask npm whether ${name}@${pin} exists — leaving ${field}.${name} at "${current}".`,
        })
        continue
      }
      if (!published) {
        onDecline({
          reason: 'companion-unpublished',
          message: `${name}@${pin} does not exist on npm — leaving ${field}.${name} at "${current}". Pick the ${name} release matching ${PIN_SOURCE} ${pin} yourself.`,
        })
        continue
      }
    }
    changes.push({ field, name, previousVersion: current, nextVersion: pin })
  }

  return changes
}
