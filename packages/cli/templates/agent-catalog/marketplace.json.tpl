{
  "$schema": "https://json.schemastore.org/claude-code-marketplace.json",
  "name": "gurenjs",
  "owner": {
    "name": "Guren",
    "url": "https://guren.dev"
  },
  "description": "Guren agent skills for Claude Code, Cursor, Codex, GitHub Copilot, OpenCode and other coding agents.",
  "plugins": [
    {
      "name": "guren",
      "source": "./plugins/guren",
      "description": "Start a Guren app (Bun + Hono + Drizzle + Inertia, Laravel-shaped) and install its agent harness — guren context, guren check, guren audit.",
      "version": "__CLI_VERSION__",
      "author": { "name": "Guren" },
      "homepage": "https://guren.dev",
      "repository": "https://github.com/gurenjs/guren",
      "license": "MIT",
      "category": "framework",
      "keywords": ["guren", "bun", "hono", "drizzle", "inertia", "typescript", "fullstack", "laravel"]
    }
  ]
}
