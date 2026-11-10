import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { authorize, bearerFetch, callbackPort, credential, needsRefresh, OmnibreachPlugin, refresh } from "@opencode/core/plugin/provider/omnibreach"
import { ProviderPlugins } from "@opencode/core/plugin/provider"

// Hermetic stub of a Cloudflare Access OIDC endpoint: discovery + authorize + token.
// Runs on loopback so it is reachable from the plugin's `fetch` calls without real network.
// `refreshResponse` controls the grant_type=refresh_token branch: a body to return, or a status
// to fail with (the revoked/expired refresh-token case).
function stubOidc(
  tokens: Record<string, unknown> = { access_token: "stub-access", refresh_token: "stub-refresh", expires_in: 3600 },
  refreshResponse: { status?: number; body?: Record<string, unknown> } = {
    body: { access_token: "stub-access-2", refresh_token: "stub-refresh-2", expires_in: 3600 },
  },
) {
  const seen: { token?: Record<string, string> } = {}
  const server = Bun.serve({
    port: 0,
    async fetch(req, srv): Promise<Response> {
      const url = new URL(req.url)
      const base = `http://127.0.0.1:${srv.port}`
      if (url.pathname === "/.well-known/openid-configuration")
        return Response.json({
          issuer: base,
          authorization_endpoint: `${base}/authorize`,
          token_endpoint: `${base}/token`,
        })
      if (url.pathname === "/authorize") {
        const redirect = new URL(url.searchParams.get("redirect_uri") ?? "")
        redirect.searchParams.set("code", "stub-code")
        redirect.searchParams.set("state", url.searchParams.get("state") ?? "")
        return new Response(null, { status: 302, headers: { Location: redirect.href } })
      }
      if (url.pathname === "/token" && req.method === "POST") {
        const form = Object.fromEntries(new URLSearchParams(await req.text()))
        seen.token = form
        if (form.grant_type === "refresh_token") {
          // A revoked/expired refresh token is the invalid_grant case the client must surface.
          if (refreshResponse.status || !form.refresh_token)
            return new Response(JSON.stringify({ error: "invalid_grant" }), { status: refreshResponse.status ?? 400 })
          return Response.json(refreshResponse.body)
        }
        // PKCE + authorization-code are required; reject anything else so the test proves the wiring.
        if (form.grant_type !== "authorization_code" || !form.code_verifier)
          return new Response(JSON.stringify({ error: "invalid_request" }), { status: 400 })
        return Response.json(tokens)
      }
      return new Response("not found", { status: 404 })
    },
  })
  return { issuer: `http://127.0.0.1:${server.port}`, seen, close: () => server.stop(true) }
}

// Drives refresh() the way OpenCode's credential refresh path does: discover the token endpoint and
// POST grant_type=refresh_token. `issuer`/`client` are parameters so the stub can be targeted.
async function runRefresh(prev: ReturnType<typeof credential>, issuer: string, client: string) {
  return Effect.runPromise(refresh(prev, issuer, client))
}

// Drives authorize() the way the Integration oauth runner does: start the loopback listener, deliver
// the IdP's redirect to it (code + state), then await the callback that exchanges the code.
async function runAuthorize(issuer: string, clientID: string, code: string) {
  return Effect.runPromise(
    Effect.gen(function* () {
      const result = yield* authorize(issuer, clientID)
      const url = new URL(result.url)
      const callback = new URL(url.searchParams.get("redirect_uri") ?? "")
      callback.searchParams.set("state", url.searchParams.get("state") ?? "")
      callback.searchParams.set("code", code)
      const [, cred] = yield* Effect.all(
        [Effect.promise(() => fetch(callback, { headers: { Connection: "close" } })), result.callback],
        { concurrency: "unbounded" },
      )
      return { cred, authorizeURL: url }
    }).pipe(Effect.scoped),
  )
}

describe("OmnibreachPlugin", () => {
  test("is registered alongside the other provider plugins", () => {
    expect(ProviderPlugins).toContain(OmnibreachPlugin)
  })

  test("authorize() exchanges the code for an OAuth credential with absolute expiry", async () => {
    const stub = stubOidc()
    try {
      const now = Date.now()
      const { cred, authorizeURL } = await runAuthorize(stub.issuer, "stub-client", "the-code")

      // discover() + PKCE wiring surfaced on the authorize URL
      expect(authorizeURL.origin + authorizeURL.pathname).toBe(`${stub.issuer}/authorize`)
      expect(authorizeURL.searchParams.get("client_id")).toBe("stub-client")
      expect(authorizeURL.searchParams.get("response_type")).toBe("code")
      expect(authorizeURL.searchParams.get("scope")).toBe("openid email offline_access")
      expect(authorizeURL.searchParams.get("code_challenge_method")).toBe("S256")
      expect(authorizeURL.searchParams.get("code_challenge")).toBeTruthy()

      // the token exchange posts the code + a PKCE verifier matching the challenge
      expect(stub.seen.token).toMatchObject({ grant_type: "authorization_code", code: "the-code", client_id: "stub-client" })
      const verifier = stub.seen.token?.code_verifier ?? ""
      const challenge = Buffer.from(
        await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)),
      ).toString("base64url")
      expect(authorizeURL.searchParams.get("code_challenge")).toBe(challenge)

      expect(cred.type).toBe("oauth")
      expect(cred.access).toBe("stub-access")
      expect(cred.refresh).toBe("stub-refresh")
      expect(cred.expires).toBeGreaterThan(now) // absolute ms, not expires_in
      expect(cred.expires).toBeGreaterThanOrEqual(now + 3_600_000)
      expect(cred.expires).toBeLessThanOrEqual(Date.now() + 3_600_000)
    } finally {
      stub.close()
    }
  })

  test("refresh() swaps the refresh token for a new access token + later absolute expiry", async () => {
    const stub = stubOidc()
    try {
      const prev = credential({ access_token: "stub-access", refresh_token: "stub-refresh", expires_in: 30 })
      const next = await runRefresh(prev, stub.issuer, "stub-client")
      expect(stub.seen.token).toMatchObject({ grant_type: "refresh_token", refresh_token: "stub-refresh", client_id: "stub-client" })
      expect(next.access).toBe("stub-access-2")
      expect(next.refresh).toBe("stub-refresh-2")
      expect(next.expires).toBeGreaterThan(prev.expires) // fresh absolute expiry, further out than the near-expiry input
    } finally {
      stub.close()
    }
  })

  test("refresh() carries the old refresh token forward when the server does not rotate it", async () => {
    // Access/expiry refresh, but no new refresh_token in the response.
    const stub = stubOidc(undefined, { body: { access_token: "stub-access-2", expires_in: 3600 } })
    try {
      const prev = credential({ access_token: "stub-access", refresh_token: "keep-me", expires_in: 30 })
      const next = await runRefresh(prev, stub.issuer, "stub-client")
      expect(next.access).toBe("stub-access-2")
      expect(next.refresh).toBe("keep-me")
    } finally {
      stub.close()
    }
  })

  test("needsRefresh triggers on the safety margin, not exactly at expires", () => {
    expect(needsRefresh({ expires: Date.now() + 30_000 })).toBe(true) // inside the ~60s margin
    expect(needsRefresh({ expires: Date.now() - 1_000 })).toBe(true) // already expired
    expect(needsRefresh({ expires: Date.now() + 120_000 })).toBe(false) // comfortably ahead
    // margin predicate is exact against an injected now
    expect(needsRefresh({ expires: 100_000 }, 40_000)).toBe(true) // 40_000 + 60_000 >= 100_000
    expect(needsRefresh({ expires: 100_000 }, 39_000)).toBe(false) // 39_000 + 60_000 < 100_000
  })

  test("an expired/revoked refresh token yields an actionable re-login error", async () => {
    const stub = stubOidc(undefined, { status: 400 }) // /token → 400 invalid_grant
    try {
      const prev = credential({ access_token: "stub-access", refresh_token: "dead-refresh", expires_in: 30 })
      const error = await Effect.runPromise(refresh(prev, stub.issuer, "stub-client").pipe(Effect.flip))
      expect(error).toBeInstanceOf(Error)
      expect((error as Error).message).toContain("omnibreach auth login")
    } finally {
      stub.close()
    }
  })

  // --- Task 4: per-request Bearer attach (bearerFetch wraps the SDK's fetch) ---

  test("model requests carry the current Bearer, and the new one after refresh (never stale)", async () => {
    let stored = credential({ access_token: "access-A", refresh_token: "refresh-A", expires_in: 3600 })
    let refreshCount = 0
    const seen: Array<string | null> = []
    const fetchImpl = bearerFetch({
      read: async () => stored,
      refresh: async () => {
        refreshCount++
        return credential({ access_token: "access-B", refresh_token: "refresh-B", expires_in: 3600 })
      },
      persist: async (next) => {
        stored = next
      },
      fetch: async (_input, init) => {
        seen.push(new Headers(init?.headers ?? {}).get("authorization"))
        return new Response("ok")
      },
    })

    await fetchImpl("https://gateway/v1/chat/completions")
    expect(seen.at(-1)).toBe("Bearer access-A") // fresh credential → its current token
    expect(refreshCount).toBe(0) // nowhere near expiry → no refresh

    // the token slips into the refresh margin (same access value, short expiry)
    stored = credential({ access_token: "access-A", refresh_token: "refresh-A", expires_in: 10 })
    await fetchImpl("https://gateway/v1/chat/completions")
    expect(refreshCount).toBe(1)
    expect(seen.at(-1)).toBe("Bearer access-B") // refreshed token, never the stale access-A

    // the persisted (now-fresh) credential is read back on the next request
    await fetchImpl("https://gateway/v1/chat/completions")
    expect(refreshCount).toBe(1) // still fresh → no extra refresh
    expect(seen.at(-1)).toBe("Bearer access-B")
  })

  test("the fresh Bearer overrides a token baked into the request, other headers kept", async () => {
    const stored = credential({ access_token: "fresh-access", refresh_token: "r", expires_in: 3600 })
    const seen: Array<{ authorization: string | null; keep: string | null }> = []
    const fetchImpl = bearerFetch({
      read: async () => stored,
      refresh: async () => stored,
      persist: async () => {},
      fetch: async (_input, init) => {
        const headers = new Headers(init?.headers ?? {})
        seen.push({ authorization: headers.get("authorization"), keep: headers.get("x-keep") })
        return new Response("ok")
      },
    })
    await fetchImpl("https://gateway/v1/chat/completions", {
      headers: { Authorization: "Bearer STALE-BAKED", "x-keep": "1" },
    })
    expect(seen.at(-1)).toEqual({ authorization: "Bearer fresh-access", keep: "1" })
  })

  test("signed out: request passes through with no Authorization and never refreshes", async () => {
    let auth: string | null = "unset"
    const fetchImpl = bearerFetch({
      read: async () => undefined,
      refresh: async () => {
        throw new Error("refresh must not run when signed out")
      },
      persist: async () => {},
      fetch: async (_input, init) => {
        auth = new Headers(init?.headers ?? {}).get("authorization")
        return new Response("ok")
      },
    })
    await fetchImpl("https://gateway/v1/chat/completions")
    expect(auth).toBeNull()
  })

  test("concurrent near-expiry requests trigger exactly one refresh (single-flight)", async () => {
    let stored = credential({ access_token: "access-A", refresh_token: "refresh-sf", expires_in: 10 })
    let refreshCount = 0
    const seen: Array<string | null> = []
    const fetchImpl = bearerFetch({
      read: async () => stored,
      refresh: async () => {
        refreshCount++
        await new Promise((resolve) => setTimeout(resolve, 10)) // widen the in-flight window
        return credential({ access_token: "access-B", refresh_token: "refresh-B", expires_in: 3600 })
      },
      persist: async (next) => {
        stored = next
      },
      fetch: async (_input, init) => {
        seen.push(new Headers(init?.headers ?? {}).get("authorization"))
        return new Response("ok")
      },
    })
    await Promise.all([
      fetchImpl("https://gateway/v1/chat/completions"),
      fetchImpl("https://gateway/v1/chat/completions"),
      fetchImpl("https://gateway/v1/chat/completions"),
    ])
    expect(refreshCount).toBe(1) // one exchange shared by all three
    expect(seen).toEqual(["Bearer access-B", "Bearer access-B", "Bearer access-B"])
  })

  test("login fails clearly when the loopback port is in use", async () => {
    const stub = stubOidc()
    const { createServer } = await import("node:http")
    const blocker = createServer()
    await new Promise<void>((resolve) => blocker.listen(callbackPort, "localhost", resolve))
    try {
      const error = await Effect.runPromise(authorize(stub.issuer, "stub-client").pipe(Effect.scoped, Effect.flip))
      expect((error as Error).message).toContain(`port ${callbackPort}`)
      expect((error as Error).message).toContain("already in use")
    } finally {
      blocker.close()
      stub.close()
    }
  })
})
