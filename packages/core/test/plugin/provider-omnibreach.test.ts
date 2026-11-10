import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { authorize, callbackPort, OmnibreachPlugin } from "@opencode/core/plugin/provider/omnibreach"
import { ProviderPlugins } from "@opencode/core/plugin/provider"

// Hermetic stub of a Cloudflare Access OIDC endpoint: discovery + authorize + token.
// Runs on loopback so it is reachable from the plugin's `fetch` calls without real network.
function stubOidc(tokens: Record<string, unknown> = { access_token: "stub-access", refresh_token: "stub-refresh", expires_in: 3600 }) {
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
