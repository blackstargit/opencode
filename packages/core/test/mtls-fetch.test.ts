import { afterEach, describe, expect, test } from "bun:test"
import fs from "fs"
import os from "os"
import path from "path"
import { omnibreachMtlsFetch } from "../src/omnibreach-mtls-fetch"

// Hermetic, in-process: stub the global fetch to inspect what the wrapper attaches. This proves the
// wrapper's contract (presents the client cert/key, leaves server verification untouched, passes the
// response through). The live mTLS handshake against the real gateway is the operator-gated
// acceptance run (harness/omnibreach-acceptance.md), not a unit test.

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omnibreach-mtls-"))
const certPath = path.join(dir, "client.crt")
const keyPath = path.join(dir, "client.key")
fs.writeFileSync(certPath, "CLIENT-CERT-PEM")
fs.writeFileSync(keyPath, "CLIENT-KEY-PEM")

const originalFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = originalFetch
})

function stubFetch(response: Response) {
  const calls: { input: unknown; init: any }[] = []
  globalThis.fetch = ((input: unknown, init: any) => {
    calls.push({ input, init })
    return Promise.resolve(response)
  }) as typeof fetch
  return calls
}

describe("omnibreachMtlsFetch", () => {
  // (a) a request with valid cert/key presents them as Bun's tls client cert.
  test("attaches the client cert and key from the configured paths", async () => {
    const calls = stubFetch(new Response("ok"))
    await omnibreachMtlsFetch(certPath, keyPath)("https://gateway.example/v1/chat")

    expect(calls).toHaveLength(1)
    expect(calls[0].init.tls.cert.toString()).toBe("CLIENT-CERT-PEM")
    expect(calls[0].init.tls.key.toString()).toBe("CLIENT-KEY-PEM")
    expect(calls[0].input).toBe("https://gateway.example/v1/chat")
  })

  // (d) server verification is left on Bun's default (system trust store): the wrapper must NOT pin a
  // custom CA and must NOT disable verification. This is the C1 lesson, asserted hermetically.
  test("does not pin a CA or disable server verification", async () => {
    const calls = stubFetch(new Response("ok"))
    await omnibreachMtlsFetch(certPath, keyPath)("https://gateway.example/v1")

    expect(calls[0].init.tls.ca).toBeUndefined()
    expect(calls[0].init.tls.rejectUnauthorized).toBeUndefined()
  })

  // SSE streaming must survive: the wrapper returns the underlying response unchanged.
  test("returns the underlying response unchanged", async () => {
    const sentinel = new Response("stream")
    stubFetch(sentinel)
    const result = await omnibreachMtlsFetch(certPath, keyPath)("https://gateway.example/v1")
    expect(result).toBe(sentinel)
  })

  // passes caller init through (headers/body/signal) while adding tls.
  test("preserves caller-supplied request init", async () => {
    const calls = stubFetch(new Response("ok"))
    await omnibreachMtlsFetch(certPath, keyPath)("https://gateway.example/v1", {
      method: "POST",
      headers: { "x-test": "1" },
    })
    expect(calls[0].init.method).toBe("POST")
    expect(calls[0].init.headers["x-test"]).toBe("1")
    expect(calls[0].init.tls.cert.toString()).toBe("CLIENT-CERT-PEM")
  })

  // (c) a missing cert/key file throws a clear error naming the path, not a cryptic TLS crash.
  test("throws a clear error naming a missing cert path", async () => {
    const missing = path.join(dir, "does-not-exist.crt")
    stubFetch(new Response("ok"))
    let err: unknown
    try {
      await omnibreachMtlsFetch(missing, keyPath)("https://gateway.example/v1")
    } catch (e) {
      err = e
    }
    expect((err as Error | undefined)?.message).toContain(missing)
    expect((err as Error | undefined)?.message).toContain("OmniBreach mTLS")
  })

  test("throws a clear error naming a missing key path", async () => {
    const missing = path.join(dir, "does-not-exist.key")
    stubFetch(new Response("ok"))
    let err: unknown
    try {
      await omnibreachMtlsFetch(certPath, missing)("https://gateway.example/v1")
    } catch (e) {
      err = e
    }
    expect((err as Error | undefined)?.message).toContain(missing)
  })

  // (wiring) aisdk.ts routes the OmniBreach provider's transport through the mTLS fetch when cert/key
  // paths are configured. (b) "without a cert the gateway rejects" is the gateway's job (Caddy
  // trust_pool); this wrapper always presents the configured cert.
  test("aisdk wires the mTLS fetch for the omnibreach provider when cert/key are set", () => {
    const src = fs.readFileSync(path.join(import.meta.dir, "../src/aisdk.ts"), "utf8")
    expect(src).toContain("omnibreachMtlsFetch")
    expect(src).toMatch(/providerID === "omnibreach"[\s\S]*?settings\.cert[\s\S]*?omnibreachMtlsFetch\(/)
  })
})
