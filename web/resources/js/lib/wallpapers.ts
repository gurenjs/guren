// The files under public/wallpapers; tests/lib/wallpapers.test.ts fails on an
// entry here that has no file there.

export interface WallpaperFormat {
  id: 'desktop' | 'mobile'
  label: string
  width: number
  height: number
}

export const WALLPAPER_FORMATS: readonly WallpaperFormat[] = [
  { id: 'desktop', label: 'Desktop', width: 5120, height: 2880 },
  { id: 'mobile', label: 'Mobile', width: 1170, height: 2532 },
]

export interface Wallpaper {
  slug: string
  name: string
}

export const WALLPAPERS: readonly Wallpaper[] = [
  { slug: 'crimson', name: 'Crimson' },
  { slug: 'flare', name: 'Flare' },
  { slug: 'lotus', name: 'Lotus' },
  { slug: 'sparks', name: 'Sparks' },
  { slug: 'blueprint', name: 'Blueprint' },
  { slug: 'kanji', name: 'Kanji' },
]

export function wallpaperFile(slug: string, format: WallpaperFormat['id']): string {
  return `/wallpapers/guren-${slug}-${format}.jpg`
}

export function wallpaperThumb(slug: string, format: WallpaperFormat['id']): string {
  return `/wallpapers/thumbs/guren-${slug}-${format}.webp`
}
