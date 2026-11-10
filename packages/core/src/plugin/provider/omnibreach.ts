import type { IntegrationOAuthMethodRegistration } from "@opencode/plugin/effect/integration"
import { define } from "@opencode/plugin/effect/plugin"
import { Deferred, Effect, Schema } from "effect"
import type { Server } from "node:http"
import { Credential } from "../../credential.js"
import { Integration } from "../../integration.js"
import { OauthCallbackPage } from "../../oauth/page.js"
import type { PluginInternal } from "../internal.js"

const integrationID = Integration.ID.make("omnibreach")
const methodID = Integration.MethodID.make("browser")

// Cloudflare Access OIDC application for the OmniBreach model gateway. Single deployment, so these
// are baked constants (the digitalocean.ts precedent), not per-user config.
// TODO(network-team): real CF Access issuer/client_id at deploy — the values below are PLACEHOLDERS;
// the live round-trip is out of scope here and the tests pass these in explicitly.
export const issuer = "https://TEAM.cloudflareaccess.com/cdn-cgi/access/sso/oidc/APP_ID"
export const clientID = "OMNIBREACH_CF_ACCESS_CLIENT_ID"

// OIDC authorization-code + PKCE. offline_access asks Cloudflare Access for a refresh token (Task 3).
const oauthScope = "openid email offline_access"
// Fixed because Cloudflare Access matches redirect_uri exactly, so it cannot be an ephemeral port.
// TODO(network-team): register http://localhost:<callbackPort>/callback as the Access app redirect URI.
export const callbackPort = 8723
const callbackPath = "/callback"

const Discovery = Schema.Struct({
  authorization_endpoint: Schema.NonEmptyString,
  token_endpoint: Schema.NonEmptyString,
})
const decodeDiscovery = Schema.decodeUnknownEffect(Discovery)

const Token = Schema.Struct({
  access_token: Schema.NonEmptyString,
  refresh_token: Schema.optional(Schema.String),
  expires_in: Schema.optional(Schema.Number),
})
const decodeToken = Schema.decodeUnknownEffect(Token)

export type Endpoints = typeof Discovery.Type

/** Resolves the OIDC authorize + token endpoints via standard discovery. Reused by Tasks 3 and 5. */
export function discover(issuerURL: string) {
  return request(`${issuerURL.replace(/\/+$/, "")}/.well-known/openid-configuration`, { method: "GET" }).pipe(
    Effect.flatMap(decodeDiscovery),
    Effect.mapError((cause) =>
      cause instanceof Error ? cause : new Error("Invalid OIDC discovery document from the OmniBreach gateway"),
    ),
  )
}

/**
 * Exchanges an authorization code for an OAuth credential against the discovered token endpoint.
 * Parameterized (not reading the module consts) so tests and Task 3/5 can target any endpoint.
 */
export function exchangeCode(
  code: string,
  verifier: string,
  tokenEndpoint: string,
  client: string,
  redirectURI: string,
) {
  return tokenRequest(tokenEndpoint, {
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectURI,
    client_id: client,
    code_verifier: verifier,
  }).pipe(Effect.map(credential))
}

/** Builds the stored OAuth credential with an ABSOLUTE expiry (now + expires_in). Reused by Task 3. */
export function credential(tokens: typeof Token.Type) {
  return Credential.OAuth.make({
    type: "oauth",
    methodID,
    access: tokens.access_token,
    refresh: tokens.refresh_token ?? "",
    expires: Date.now() + (tokens.expires_in ?? 3600) * 1000,
  })
}

/**
 * Browser login: discover endpoints, start the loopback callback listener, hand back the authorize
 * URL (PKCE S256) and a callback Effect that exchanges the delivered code. `issuerURL`/`client` are
 * parameters for testability; the registered method passes the module consts.
 */
export function authorize(issuerURL: string, client: string) {
  return Effect.gen(function* () {
    const endpoints = yield* discover(issuerURL)
    const verifier = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url")
    const challenge = Buffer.from(
      yield* Effect.promise(() => crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))),
    ).toString("base64url")
    const state = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url")

    const code = yield* Deferred.make<string, Error>()
    // Lazy so runtimes without a loopback listener (workerd) never evaluate node:http.
    const { createServer } = yield* Effect.promise(() => import("node:http"))
    const server = createServer((req, response) => {
      const url = new URL(req.url ?? "/", "http://localhost")
      if (url.pathname !== callbackPath) {
        response.writeHead(404).end("Not found")
        return
      }
      const error = url.searchParams.get("error_description") ?? url.searchParams.get("error")
      const value = url.searchParams.get("code")
      if (error) {
        Effect.runFork(Deferred.fail(code, new Error(error)))
        response.writeHead(400, { "Content-Type": "text/html" }).end(OauthCallbackPage.error(error, { provider: "OmniBreach" }))
        return
      }
      if (!value || url.searchParams.get("state") !== state) {
        const message = value ? "Invalid OAuth state" : "Missing authorization code"
        Effect.runFork(Deferred.fail(code, new Error(message)))
        response
          .writeHead(400, { "Content-Type": "text/html" })
          .end(OauthCallbackPage.error(message, { provider: "OmniBreach" }))
        return
      }
      Effect.runFork(Deferred.succeed(code, value))
      response.writeHead(200, { "Content-Type": "text/html" }).end(OauthCallbackPage.success({ provider: "OmniBreach" }))
    })
    yield* listen(server)
    yield* Effect.addFinalizer(() => Effect.sync(() => server.close()))
    const redirect = `http://localhost:${callbackPort}${callbackPath}`
    return {
      mode: "auto" as const,
      url: `${endpoints.authorization_endpoint}?${new URLSearchParams({
        response_type: "code",
        client_id: client,
        redirect_uri: redirect,
        scope: oauthScope,
        code_challenge: challenge,
        code_challenge_method: "S256",
        state,
      })}`,
      instructions: "Complete authorization in your browser. This window will close automatically.",
      callback: Deferred.await(code).pipe(
        Effect.flatMap((value) => exchangeCode(value, verifier, endpoints.token_endpoint, client, redirect)),
      ),
    }
  })
}

// Pre-expiry window: refresh once the credential is within this long of expiry (or past it), rather
// than only after a 401. Matches the ~60s precedent commented in chatgpt.ts (`expires <= now + 60_000`).
export const REFRESH_MARGIN_MS = 60_000

/** True when the credential is within REFRESH_MARGIN_MS of expiry (or already expired). T4 gates on this. */
export function needsRefresh(credential: Pick<Credential.OAuth, "expires">, nowMs: number = Date.now()) {
  return credential.expires <= nowMs + REFRESH_MARGIN_MS
}

/**
 * Refreshes an OAuth credential: discover the token endpoint, POST grant_type=refresh_token + client_id,
 * and return a new credential with a fresh ABSOLUTE expiry. The old refresh token is carried forward when
 * the server does not rotate it. A rejected/revoked token (invalid_grant / 4xx) becomes an actionable
 * re-login error. Parameterized (issuerURL/client) like `authorize` so the hermetic test targets the stub;
 * the registered method passes the module consts.
 */
export function refresh(value: Credential.OAuth, issuerURL: string, client: string) {
  return discover(issuerURL).pipe(
    Effect.flatMap((endpoints) =>
      tokenRequest(endpoints.token_endpoint, {
        grant_type: "refresh_token",
        refresh_token: value.refresh,
        client_id: client,
      }).pipe(
        Effect.map((tokens) => credential({ ...tokens, refresh_token: tokens.refresh_token || value.refresh })),
        // ponytail: any token-POST failure (not just 4xx) maps to re-login guidance — a refresh failure
        // overwhelmingly means a dead/revoked session, and the original detail is preserved for the rare
        // transient case. Split out per-status handling only if T4's request path needs transient retries.
        Effect.mapError((cause) => {
          const detail = cause instanceof Error ? cause.message : String(cause)
          return new Error(
            `Your OmniBreach session has expired or was revoked (${detail}). Run \`omnibreach auth login\` to sign in again.`,
          )
        }),
      ),
    ),
  )
}

const browserMethod = {
  integrationID,
  method: {
    id: methodID,
    type: "oauth",
    label: "Login with OmniBreach",
  },
  authorize: () => authorize(issuer, clientID),
  refresh: (value) => refresh(value, issuer, clientID),
} satisfies IntegrationOAuthMethodRegistration

export const OmnibreachPlugin = define({
  id: "opencode.provider.omnibreach",
  effect: Effect.fn(function* (ctx) {
    yield* ctx.integration.transform((draft) => {
      draft.method.update(browserMethod)
    })
  }),
} satisfies PluginInternal.InternalPlugin)

function tokenRequest(tokenEndpoint: string, body: Record<string, string>) {
  return Effect.gen(function* () {
    const data = yield* request(tokenEndpoint, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(body).toString(),
    })
    return yield* decodeToken(data).pipe(
      Effect.mapError((cause) =>
        cause instanceof Error ? cause : new Error("Invalid token response from the OmniBreach gateway"),
      ),
    )
  })
}

// Plain fetch (openai.ts precedent) keeps login self-contained — no Effect HttpClient service needed,
// so the hermetic test can point it at a loopback stub.
function request(url: string, init: RequestInit) {
  return Effect.tryPromise({
    try: async (signal): Promise<unknown> => {
      const response = await fetch(url, { ...init, signal })
      if (!response.ok) {
        const detail = await response.text().catch(() => "")
        throw new Error(`OmniBreach login request failed (${response.status})${detail ? `: ${detail}` : ""}`)
      }
      return response.json()
    },
    catch: (cause) => (cause instanceof Error ? cause : new Error(String(cause))),
  })
}

// Cloudflare Access matches redirect_uri exactly, so the callback port is fixed, not ephemeral.
function listen(server: Server) {
  return Effect.callback<void, Error>((resume) => {
    const onError = (error: Error) => resume(Effect.fail(error))
    server.once("error", onError)
    server.listen(callbackPort, "localhost", () => {
      server.off("error", onError)
      resume(Effect.void)
    })
  }).pipe(
    Effect.mapError((cause) =>
      "code" in cause && cause.code === "EADDRINUSE"
        ? new Error(
            `OmniBreach login needs local port ${callbackPort}, but it is already in use. Stop the process using that port and try again.`,
          )
        : cause,
    ),
  )
}
