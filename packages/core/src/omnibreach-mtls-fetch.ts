export * as OmnibreachMtlsFetch from "./omnibreach-mtls-fetch.js"

import fs from "fs"

/**
 * A `fetch` that presents the OmniBreach client certificate/key (Bun's native `tls` option) on
 * every request — the native replacement for the stunnel shim. Wired onto the OmniBreach provider's
 * transport in `aisdk.ts` when cert/key paths are configured.
 *
 * Trust model (the C1 lesson): this attaches ONLY the client cert/key. Server verification is left
 * on Bun's default (the system trust store) — no `ca`, no `rejectUnauthorized: false` — because the
 * gateway serves a public ACME cert. Never pin our private CA for server verification here.
 *
 * Cert/key are read once when the provider is initialized (not per request — that would block the
 * event loop on every LLM/SSE call); a rotated bundle is picked up on the next restart. A missing or
 * unreadable file throws a clear error naming the path instead of a cryptic TLS failure. The
 * response is returned unchanged, so SSE streaming is preserved.
 */
export function omnibreachMtlsFetch(certPath: string, keyPath: string): typeof fetch {
  const read = (label: string, filepath: string) => {
    try {
      return fs.readFileSync(filepath)
    } catch (cause) {
      throw new Error(`OmniBreach mTLS: cannot read client ${label} at ${filepath}: ${(cause as Error).message}`)
    }
  }
  const cert = read("certificate", certPath)
  const key = read("key", keyPath)
  return function omnibreachFetch(input: Parameters<typeof fetch>[0], init?: BunFetchRequestInit) {
    return fetch(input, { ...init, tls: { cert, key } })
  } as typeof fetch
}
