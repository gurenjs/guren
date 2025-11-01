declare global {
  interface ImportMeta {
    /** Optional Vite-style glob loader available in dev builds. */
    glob?: (pattern: string) => Record<string, () => Promise<unknown>>
  }
}

export {}
