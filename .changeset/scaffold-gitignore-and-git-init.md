---
'create-guren-app': minor
'@guren/cli': minor
---

Ship a `.gitignore` with scaffolded apps and offer an initial commit.

npm strips files literally named `.gitignore` from published tarballs, so every
app scaffolded from the registry came out without one — `git init` immediately
staged `node_modules/`, build output, and the generated `.env`. Templates now
carry the file as `_gitignore` and the scaffolder restores the dot after each
template layer copies — collected from the copy itself, so a `--force` scaffold
never renames files it did not write. The default list also covers
`public/assets/`, `.guren/ssr/`, and `.DS_Store`.

`create-guren-app` (and `guren new`) gained a `--git` / `--no-git` flag that
initializes a repository and creates an initial commit once the harness and
optional auth scaffolding are in place. It is prompted in an interactive
terminal, off in non-interactive ones, and skipped when the target directory is
already inside a git repository or already contained files — an initial commit
must never sweep up anything the scaffolder did not write.
