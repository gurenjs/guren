import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { WALLPAPERS, WALLPAPER_FORMATS, wallpaperFile, wallpaperThumb } from '../../resources/js/lib/wallpapers.js'

const PUBLIC_DIR = join(import.meta.dirname, '../../public')

describe('wallpapers', () => {
  it('should ship a download and a thumbnail for every wallpaper in every format', () => {
    const missing = WALLPAPERS.flatMap(({ slug }) =>
      WALLPAPER_FORMATS.flatMap(({ id }) => [wallpaperFile(slug, id), wallpaperThumb(slug, id)]),
    ).filter((path) => !existsSync(join(PUBLIC_DIR, path)))

    expect(missing).toEqual([])
  })
})
