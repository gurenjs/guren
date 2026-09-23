import type { SVGProps } from 'react'
import {
  GITHUB_ICON_PATH,
  MENU_ICON_PATH,
  MOON_ICON_PATH,
  RSS_ICON_PATH,
  SUN_ICON_PATH,
} from '../../../config/icon-paths.js'

type IconProps = SVGProps<SVGSVGElement>

export function TerminalIcon(props: IconProps) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" {...props}>
      <path fillRule="evenodd" d="M2.25 6a3 3 0 0 1 3-3h13.5a3 3 0 0 1 3 3v12a3 3 0 0 1-3 3H5.25a3 3 0 0 1-3-3V6Zm3.97.97a.75.75 0 0 1 1.06 0l2.25 2.25a.75.75 0 0 1 0 1.06l-2.25 2.25a.75.75 0 0 1-1.06-1.06l1.72-1.72-1.72-1.72a.75.75 0 0 1 0-1.06Zm4.28 4.28a.75.75 0 0 0 0 1.5h3a.75.75 0 0 0 0-1.5h-3Z" clipRule="evenodd" />
    </svg>
  )
}

export function BookOpenIcon(props: IconProps) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" {...props}>
      <path d="M11.25 4.533A9.707 9.707 0 0 0 6 3a9.735 9.735 0 0 0-3.25.555.75.75 0 0 0-.5.707v14.25a.75.75 0 0 0 1 .707A8.237 8.237 0 0 1 6 18.75c1.995 0 3.823.707 5.25 1.886V4.533ZM12.75 4.533A9.707 9.707 0 0 1 18 3a9.735 9.735 0 0 1 3.25.555.75.75 0 0 1 .5.707v14.25a.75.75 0 0 1-1 .707A8.237 8.237 0 0 0 18 18.75c-1.995 0-3.823.707-5.25 1.886V4.533Z" />
    </svg>
  )
}

export function GithubIcon(props: IconProps) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" {...props}>
      <path d={GITHUB_ICON_PATH} />
    </svg>
  )
}

export function MenuIcon(props: IconProps) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" {...props}>
      <path fillRule="evenodd" d={MENU_ICON_PATH} clipRule="evenodd" />
    </svg>
  )
}

export function XIcon(props: IconProps) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" {...props}>
      <path fillRule="evenodd" d="M5.47 5.47a.75.75 0 0 1 1.06 0L12 10.94l5.47-5.47a.75.75 0 1 1 1.06 1.06L13.06 12l5.47 5.47a.75.75 0 1 1-1.06 1.06L12 13.06l-5.47 5.47a.75.75 0 0 1-1.06-1.06L10.94 12 5.47 6.53a.75.75 0 0 1 0-1.06Z" clipRule="evenodd" />
    </svg>
  )
}

export function SearchIcon(props: IconProps) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" {...props}>
      <path fillRule="evenodd" d="M10.5 3.75a6.75 6.75 0 1 0 4.28 11.97l4.25 4.25a.75.75 0 1 0 1.06-1.06l-4.25-4.25A6.75 6.75 0 0 0 10.5 3.75Zm-5.25 6.75a5.25 5.25 0 1 1 10.5 0 5.25 5.25 0 0 1-10.5 0Z" clipRule="evenodd" />
    </svg>
  )
}

export function ChevronRightIcon(props: IconProps) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" {...props}>
      <path fillRule="evenodd" d="M16.28 11.47a.75.75 0 0 1 0 1.06l-7.5 7.5a.75.75 0 0 1-1.06-1.06L14.69 12 7.72 5.03a.75.75 0 0 1 1.06-1.06l7.5 7.5Z" clipRule="evenodd" />
    </svg>
  )
}

export function SunIcon(props: IconProps) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" {...props}>
      <path d={SUN_ICON_PATH} />
    </svg>
  )
}

export function MoonIcon(props: IconProps) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" {...props}>
      <path fillRule="evenodd" d={MOON_ICON_PATH} clipRule="evenodd" />
    </svg>
  )
}

export function RssIcon(props: IconProps) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" {...props}>
      <path fillRule="evenodd" d={RSS_ICON_PATH} clipRule="evenodd" />
    </svg>
  )
}

/* Deploy-target glyphs, drawn for this site rather than taken from a vendor:
   Cloudflare's and AWS's marks need permission, so none imitates a logo. */
const LINE = {
  xmlns: 'http://www.w3.org/2000/svg',
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.5,
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
} as const

/** A long-running server you host. */
export function ServerIcon(props: IconProps) {
  return (
    <svg {...LINE} {...props}>
      <rect x="3.75" y="4.5" width="16.5" height="6.5" rx="1.5" />
      <rect x="3.75" y="13" width="16.5" height="6.5" rx="1.5" />
      <path d="M7.25 7.75h.01M7.25 16.25h.01M11 7.75h5.75M11 16.25h5.75" />
    </svg>
  )
}

/** Many locations at the network edge. */
export function GlobeIcon(props: IconProps) {
  return (
    <svg {...LINE} {...props}>
      <circle cx="12" cy="12" r="8.25" />
      <path d="M3.75 12h16.5" />
      <path d="M12 3.75c2.2 2.25 3.3 5 3.3 8.25s-1.1 6-3.3 8.25c-2.2-2.25-3.3-5-3.3-8.25S9.8 6 12 3.75Z" />
    </svg>
  )
}

/** A build output a platform serves: static files over functions. */
export function LayersIcon(props: IconProps) {
  return (
    <svg {...LINE} {...props}>
      <path d="m12 3.75 8.25 4.25L12 12.25 3.75 8 12 3.75Z" />
      <path d="m3.75 12 8.25 4.25L20.25 12" />
      <path d="m3.75 16 8.25 4.25L20.25 16" />
    </svg>
  )
}

/** A function started on demand for each event. */
export function FunctionIcon(props: IconProps) {
  return (
    <svg {...LINE} {...props}>
      <path d="M8 4.5H7a2 2 0 0 0-2 2v3.25L3.75 12 5 14.25v3.25a2 2 0 0 0 2 2h1" />
      <path d="M16 4.5h1a2 2 0 0 1 2 2v3.25L20.25 12 19 14.25v3.25a2 2 0 0 1-2 2h-1" />
      <path d="m12.75 7.5-2.5 4.75h3.5l-2.5 4.75" />
    </svg>
  )
}
