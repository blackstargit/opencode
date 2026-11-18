# CLAUDE.md — OmniBreach fork of OpenCode

> This `opencode/` submodule is OmniBreach's **maintained source fork** of
> [OpenCode](https://opencode.ai) (branch `omnibreach`), the engine behind the
> OmniBreach CLI product. It is **not** first-party OmniBreach code — it's
> upstream code we edit deliberately (branding, a baked default-config layer, the
> client-auth provider plugin).

> **Intentionally NOT `@`-imported into the repo-root `CLAUDE.md`** (unlike
> `backend`/`server`/`frontend`). It loads only when you're working in this
> directory — upstream OpenCode's TS/Effect/Bun conventions are noise for a
> backend/frontend/root session. General rules still apply via `../RULES.md`.

## Two guides apply here — read before editing fork code

- **`../harness/CLAUDE.md`** — the OmniBreach-specific overlay and the source of
  truth for the fork: exactly what we edit, the sync-safe branding boundary
  (theme + a config-dir plugin), the build chain (`../harness/build-omnibreach.sh`
  → `../harness/installer/build-installer.sh`), and the Cloudflare-Access
  client-auth provider plugin.
- **`AGENTS.md`** (this dir) — upstream OpenCode's own engineering guide, kept
  unmodified as *their* source of truth (we deliberately do not copy it out).
  Still governs fork edits; most load-bearing for our work:
  - **TUI theme tokens** — governs the palette-C branding in
    `packages/tui/src/theme/`; pick tokens by semantic role, never raw `theme.hue`.
  - **Checks** — `bun run check` (repo root) / `bun typecheck` (package dir);
    **never run `tsc` directly**.
  - TS / Effect / Bun / import style — applies when touching the provider plugin
    (`packages/core/src/plugin/provider/omnibreach.ts`) or any core edit.

## Where AGENTS.md diverges from our fork

AGENTS.md says the default branch is `dev` and to target PRs at `dev` — that is
**upstream's** workflow. Our fork works on branch **`omnibreach`**. Commits and
pushes follow `../RULES.md` (never on your own, only when explicitly asked).
