import { pageTitle } from '../../../config/site.js'
import { Footer } from '../components/Footer.js'
import { Header } from '../components/Header.js'
import { Seo } from '../components/Seo.js'
import { Tick } from '../components/Tick.js'
import {
  WALLPAPERS,
  WALLPAPER_FORMATS,
  wallpaperFile,
  wallpaperThumb,
  type WallpaperFormat,
} from '../lib/wallpapers.js'

const GRID: Record<WallpaperFormat['id'], string> = {
  desktop: 'grid gap-6 sm:grid-cols-2',
  mobile: 'grid grid-cols-2 gap-6 sm:grid-cols-3 lg:grid-cols-6',
}

function WallpaperCard({ slug, name, format }: { slug: string; name: string; format: WallpaperFormat }) {
  const file = wallpaperFile(slug, format.id)

  return (
    <li className="overflow-hidden rounded-lg border border-home-line bg-home-raised">
      <img
        src={wallpaperThumb(slug, format.id)}
        alt={`${name} wallpaper, ${format.label.toLowerCase()}`}
        width={format.width}
        height={format.height}
        loading="lazy"
        decoding="async"
        className="block h-auto w-full"
      />
      <div
        className={
          format.id === 'mobile'
            ? 'flex flex-col items-start gap-2.5 px-4 py-3'
            : 'flex items-center justify-between gap-3 px-4 py-3'
        }
      >
        <span className="font-bold">{name}</span>
        <a
          href={file}
          download
          aria-label={`Download ${name}, ${format.label.toLowerCase()}`}
          className="inline-flex items-center rounded-md bg-crimson-600 px-4 py-1.5 text-sm font-bold text-crimson-50 no-underline transition hover:bg-crimson-700 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-crimson-300"
        >
          Download
        </a>
      </div>
    </li>
  )
}

export default function Wallpapers() {
  return (
    <>
      <Seo
        title={pageTitle('Wallpapers')}
        description="Guren wallpapers for desktop and phone, free to download."
        path="/wallpapers"
      />
      <div className="min-h-dvh bg-home-ground font-home text-home-text antialiased">
        <Header variant="home" />

        <main className="mx-auto max-w-6xl px-6 pb-24 pt-14 md:pt-20">
          <Tick />
          <h1 className="mt-5 text-balance text-[2.25rem] font-bold leading-[1.08] tracking-[-0.03em] md:text-[3rem]">
            Wallpapers
          </h1>
          <p className="mt-5 max-w-[38rem] text-lg leading-[1.65] text-home-text-2">
            Guren in crimson, for your desktop and your phone.
          </p>

          {WALLPAPER_FORMATS.map((format) => (
            <section key={format.id} aria-labelledby={`wallpapers-${format.id}`} className="mt-16">
              <h2 id={`wallpapers-${format.id}`} className="text-2xl font-bold tracking-[-0.02em]">
                {format.label}
              </h2>
              <p className="mt-1 font-mono text-sm text-home-text-2">
                {format.width}×{format.height}
              </p>
              <ul className={`mt-6 ${GRID[format.id]}`}>
                {WALLPAPERS.map(({ slug, name }) => (
                  <WallpaperCard key={slug} slug={slug} name={name} format={format} />
                ))}
              </ul>
            </section>
          ))}
        </main>

        <Footer variant="home" />
      </div>
    </>
  )
}
