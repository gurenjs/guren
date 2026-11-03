// Line glyphs for a docs feature list (`<!-- feature-icon: <key> -->`), drawn
// in the same 24px, 1.5-stroke style as the home page's deploy-target icons.
// Inner SVG markup only: `app/Services/doc-features.ts` wraps each one.

export const FEATURE_ICONS = {
  bolt: '<path d="M13.25 3 5.5 13.25h6L10.75 21l7.75-10.25h-6L13.25 3Z" />',
  code: '<path d="m8.25 7.5-4.5 4.5 4.5 4.5M15.75 7.5l4.5 4.5-4.5 4.5M13.5 5.25l-3 13.5" />',
  shield:
    '<path d="M12 3.75 4.75 6.5v5.25c0 4.1 3.05 7.3 7.25 8.5 4.2-1.2 7.25-4.4 7.25-8.5V6.5L12 3.75Z" /><path d="m9 12 2.25 2.25 3.75-4" />',
  graph:
    '<circle cx="6.25" cy="6.25" r="2.25" /><circle cx="17.75" cy="8.5" r="2.25" /><circle cx="10" cy="17.75" r="2.25" /><path d="M8.45 6.7l7.1 1.35M7 8.4l2.25 7.2M16.4 10.3l-5 5.6" />',
  battery:
    '<rect x="3" y="7.5" width="15.5" height="9" rx="1.75" /><path d="M21 10.75v2.5M6.5 10.5v3M9.5 10.5v3M12.5 10.5v3" />',
  folder:
    '<path d="M3.75 7.25a1.5 1.5 0 0 1 1.5-1.5h3.9l1.6 1.75h8a1.5 1.5 0 0 1 1.5 1.5v8.5a1.5 1.5 0 0 1-1.5 1.5H5.25a1.5 1.5 0 0 1-1.5-1.5V7.25Z" /><path d="M3.75 10.25h16.5" />',
  route:
    '<path d="M12 3.75v16.5M9 20.25h6" /><path d="M12 5.5h5.75l2 2.25-2 2.25H12" /><path d="M12 12H6.25l-2 2.25 2 2.25H12" />',
} as const

export type FeatureIconKey = keyof typeof FEATURE_ICONS
