import type { PageProps } from '@guren/inertia-client/contracts'
import { pages as generatedPages } from '../../../.guren/pages.gen.ts'

export const appPages = {
  home: generatedPages.Home.props<{
    message: string
  }>(),
} as const

export type HomePageProps = PageProps<typeof appPages.home>
