import type { IntegrationOAuthMethodRegistration } from "@opencode/plugin/effect/integration"
import { define } from "@opencode/plugin/effect/plugin"
import { Deferred, Effect, Schema } from "effect"
import type { Server } from "node:http"
import { Credential } from "../../credential.js"
import { Integration } from "../../integration.js"
import { OauthCallbackPage } from "../../oauth/page.js"
import { Provider } from "../../provider.js"
import type { PluginInternal } from "../internal.js"

const integrationID = Integration.ID.make("omnibreach")
const methodID = Integration.MethodID.make("browser")
const providerID = Provider.ID.make("omnibreach")

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

const browserInstructions = "Complete authorization in your browser. This window will close automatically."

// Headless login (a box with NO local browser): the SAME loopback exchange, but the user opens the
// authorize URL on another device and forwards the fixed callback port back here (e.g. ssh -L). The
// only differences from the browser method are this text and that the CLI does not auto-open the URL.
// TODO(live-CF): OOB copy-paste-code variant if CF Access supports it (spec §4.3) — a localized swap of
// the loopback capture for a pasted-code prompt on THIS method only; do NOT build CF device-grant.
const headlessInstructions =
  `Open this link to sign in on any device with a browser, then make sure its OAuth callback can reach ` +
  `local port ${callbackPort} on this machine (e.g. ssh -L ${callbackPort}:localhost:${callbackPort}). ` +
  `This window finishes automatically once the callback arrives.`

/**
 * Shared loopback login machinery: discover endpoints, start the loopback callback listener, and hand
 * back the authorize URL (PKCE S256) + a callback Effect that exchanges the delivered code. BOTH the
 * `browser` and `headless` methods call this — they differ only in `instructions` and in whether the
 * CLI auto-opens the URL (a harness concern, not this function's). `issuerURL`/`client` are parameters
 * for testability; the registered methods pass the module consts.
 */
function startLoopbackLogin(issuerURL: string, client: string, instructions: string) {
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
      instructions,
      callback: Deferred.await(code).pipe(
        Effect.flatMap((value) => exchangeCode(value, verifier, endpoints.token_endpoint, client, redirect)),
      ),
    }
  })
}

/** Browser login — the CLI/TUI auto-opens the loopback authorize URL. */
export function authorize(issuerURL: string, client: string) {
  return startLoopbackLogin(issuerURL, client, browserInstructions)
}

/** Headless login — identical loopback exchange, surfaced for a machine with no local browser. */
export function headlessAuthorize(issuerURL: string, client: string) {
  return startLoopbackLogin(issuerURL, client, headlessInstructions)
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

// --- Task 4: attach the current Bearer to every model request ---------------------------------

type AuthFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>

export interface BearerFetchDeps {
  /** The stored OmniBreach OAuth credential right now, or undefined when signed out. No auto-refresh. */
  readonly read: () => Promise<Credential.OAuth | undefined>
  /** Exchanges the refresh token for a fresh credential (Task 3's refresh()). */
  readonly refresh: (credential: Credential.OAuth) => Promise<Credential.OAuth>
  /** Writes a refreshed credential back to the store so the next read() returns it. */
  readonly persist: (credential: Credential.OAuth) => Promise<void>
  /** The underlying fetch to call — the AI SDK's timeout-aware fetch in production. */
  readonly fetch: AuthFetch
  readonly now?: () => number
}

// Concurrent requests sharing one near-expiry credential collapse onto a single token exchange here,
// keyed by the refresh token, instead of stampeding the gateway (gitlab.ts's `refreshing`-map pattern).
// ponytail: in-process single-flight only — the framework's build-time connection.resolve has its own
// cross-process credentials.lock; fine for a single-user CLI, revisit if multi-Location refreshes ever race.
const refreshing = new Map<string, Promise<Credential.OAuth>>()

/**
 * Wraps a fetch so every request carries `Authorization: Bearer <current access token>`. The credential
 * is read fresh on each call and proactively refreshed within REFRESH_MARGIN_MS of expiry (single-flight,
 * then persisted) — so a refresh can never leave a later request on a stale token, and the fresh header
 * overrides whatever token the SDK baked into the cached model at build time. On a refresh failure it
 * falls back to the current token (the gateway's 401 then drives re-login) rather than dropping auth.
 */
export function bearerFetch(deps: BearerFetchDeps): AuthFetch {
  const now = deps.now ?? Date.now
  const current = async () => {
    const credential = await deps.read()
    if (!credential || !needsRefresh(credential, now())) return credential
    const key = credential.refresh
    const inflight = refreshing.get(key)
    if (inflight) return inflight
    const attempt = (async () => {
      try {
        const next = await deps.refresh(credential)
        await deps.persist(next)
        return next
      } catch {
        return credential
      }
    })()
    refreshing.set(key, attempt)
    void attempt.finally(() => {
      if (refreshing.get(key) === attempt) refreshing.delete(key)
    })
    return attempt
  }
  return async (input, init) => {
    const credential = await current().catch(() => undefined)
    if (!credential) return deps.fetch(input, init)
    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined))
    headers.set("Authorization", `Bearer ${credential.access}`)
    return deps.fetch(input, { ...init, headers })
  }
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

// Second method (openai.ts's dual-method pattern): same OIDC endpoints + exchange + refresh as the
// browser method — only the loopback URL is opened elsewhere and forwarded back. The stored credential
// keeps methodID `browser` (via the shared credential()), so Task 4's bearerFetch reads it unchanged.
const headlessMethod = {
  integrationID,
  method: {
    id: Integration.MethodID.make("headless"),
    type: "oauth",
    label: "Login with OmniBreach (headless)",
  },
  authorize: () => headlessAuthorize(issuer, clientID),
  refresh: (value) => refresh(value, issuer, clientID),
} satisfies IntegrationOAuthMethodRegistration

export const OmnibreachPlugin = define({
  id: "opencode.provider.omnibreach",
  effect: Effect.fn(function* (ctx) {
    const credentials = yield* Credential.Service
    yield* ctx.integration.transform((draft) => {
      draft.method.update(browserMethod)
      draft.method.update(headlessMethod)
    })

    // Run the integration/credential Effects from the detached fetch callback below with the plugin's
    // own service context, so a request can read/refresh/persist the credential outside Effect land.
    const context = yield* Effect.context<PluginInternal.Requirements>()
    const run = <A>(effect: Effect.Effect<A, never, PluginInternal.Requirements>): Promise<A> =>
      Effect.runPromise(Effect.provide(effect, context))

    const activeCredentialID = Effect.gen(function* () {
      const connection = yield* ctx.integration.connection.active(integrationID)
      return connection?.type === "credential" ? Credential.ID.make(connection.id) : undefined
    }).pipe(Effect.orElseSucceed(() => undefined))

    // Read the stored OAuth credential WITHOUT the framework's build-time auto-refresh, so the
    // per-request refresh below (needsRefresh/refresh/persist) stays the authority during a turn.
    const readCredential = () =>
      run(
        Effect.gen(function* () {
          const id = yield* activeCredentialID
          const info = id ? yield* credentials.get(id) : undefined
          return info?.value.type === "oauth" && info.value.methodID === methodID ? info.value : undefined
        }).pipe(Effect.orElseSucceed(() => undefined)),
      )
    const persistCredential = (value: Credential.OAuth) =>
      run(
        Effect.gen(function* () {
          const id = yield* activeCredentialID
          if (id) yield* credentials.update(id, { value })
        }).pipe(Effect.orElseSucceed(() => undefined)),
      )

    // Attach the Bearer at the fetch layer (the github-copilot precedent for an openai-compatible
    // provider): wrap the AI SDK's timeout-aware fetch before the SDK is built, so every /v1/* call
    // carries the current token. NOT provider `settings.fetch` — a function there is stripped by
    // Provider.mergeOverlay's JSON decode at model-resolve time.
    yield* ctx.aisdk.hook(
      "sdk",
      Effect.fn(function* (evt) {
        if (evt.model.providerID !== providerID) return
        const inner: AuthFetch = typeof evt.options.fetch === "function" ? (evt.options.fetch as AuthFetch) : fetch
        evt.options.fetch = bearerFetch({
          read: readCredential,
          refresh: (value) => Effect.runPromise(refresh(value, issuer, clientID)),
          persist: persistCredential,
          fetch: inner,
        })
      }),
    )
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
