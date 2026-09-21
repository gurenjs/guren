/**
 * Where an app registers its durable agents (RFC 0017). A leaf with no imports:
 * `@guren/core/internal/deploy-build` reads it at plugin build time, where the
 * runtime barrel must not load, and the CLI checks read it without depending on core.
 */
export const AGENTS_CONFIG_FILE = 'config/agents.ts'
