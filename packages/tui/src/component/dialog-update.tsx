import type { UpdateState } from "../context/update-notification"

// OmniBreach: self-update is disabled. This fork is pinned and distributed by OmniBreach,
// so it never checks for, downloads, or installs updates (no call-home). The updater is
// also switched off upstream (see commands/handlers/default.ts), so this dialog is never
// opened; it is kept as an inert no-op purely so the update-notification context typechecks.
export function DialogUpdate(_props: {
  check?: (signal: AbortSignal) => Promise<string | undefined>
  state: () => UpdateState | undefined
  skip: () => void
  install: () => Promise<void>
  restart: () => void
}) {
  return null
}
