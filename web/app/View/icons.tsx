/** @jsxImportSource @guren/core */
import type { FC } from '@guren/core'
import {
  GITHUB_ICON_PATH,
  MENU_ICON_PATH,
  MOON_ICON_PATH,
  RSS_ICON_PATH,
  SUN_ICON_PATH,
} from '../../config/icon-paths.js'

/**
 * Server-rendered wrappers around `config/icon-paths.ts`; the React set in
 * `resources/js/components/` wraps the same strings.
 */

type IconProps = { class?: string }

export const GithubIcon: FC<IconProps> = ({ class: className }) => (
  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" class={className}>
    <path d={GITHUB_ICON_PATH} />
  </svg>
)

export const MenuIcon: FC<IconProps> = ({ class: className }) => (
  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" class={className}>
    <path fill-rule="evenodd" d={MENU_ICON_PATH} clip-rule="evenodd" />
  </svg>
)

export const SunIcon: FC<IconProps> = ({ class: className }) => (
  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" class={className}>
    <path d={SUN_ICON_PATH} />
  </svg>
)

export const MoonIcon: FC<IconProps> = ({ class: className }) => (
  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" class={className}>
    <path fill-rule="evenodd" d={MOON_ICON_PATH} clip-rule="evenodd" />
  </svg>
)

export const RssIcon: FC<IconProps> = ({ class: className }) => (
  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" class={className}>
    <path fill-rule="evenodd" d={RSS_ICON_PATH} clip-rule="evenodd" />
  </svg>
)
