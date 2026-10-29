import { describe, expect, test } from "bun:test"
import fs from "fs"
import path from "path"
import { Schema } from "effect"
import { Document, Info } from "@opencode/schema/config"
import { omnibreachDefaults } from "../src/config/omnibreach-defaults"
import { Config } from "../src/config"

describe("omnibreach default-config layer", () => {
  // (a) With no omnibreach.json, the baked defaults expose the OmniBreach provider, the MCP
  //     127.0.0.1:8888 default, and the default model — all valid against the real config schema.
  test("baked defaults carry the OmniBreach provider, MCP server, and model", () => {
    const doc = omnibreachDefaults()
    expect(doc.type).toBe("document")

    const provider = doc.info.providers?.omnibreach
    expect(provider).toBeDefined()
    expect(provider?.name).toBe("OmniBreach Gateway")
    expect(provider?.package).toBe("@ai-sdk/openai-compatible")
    expect(provider?.models?.["omnibreach-agent"]).toBeDefined()
    expect(provider?.models?.["omnibreach-agent"]?.name).toBe("OmniBreach Agent")

    const server = doc.info.mcp?.servers?.omnibreach
    expect(server?.type).toBe("remote")
    if (server?.type === "remote") expect(server.url).toBe("http://127.0.0.1:8888")

    const model = doc.info.model as { providerID?: string; model?: string } | undefined
    expect(model?.providerID).toBe("omnibreach")
    expect(model?.model).toBe("omnibreach-agent")
  })

  // Gateway baseURL and cert/key paths are SUPPLIED by the installer's omnibreach.json (spec §3.3),
  // not baked — the baked provider must not pin a baseURL.
  test("baked provider does not hardcode a baseURL (installer supplies it)", () => {
    const provider = omnibreachDefaults().info.providers?.omnibreach
    expect((provider?.settings as Record<string, unknown> | undefined)?.baseURL).toBeUndefined()
  })

  // (wiring) The default is injected as the lowest-priority SETTINGS source in Config.load():
  // after managedPolicies (which stay load-first for policy authority), before every real layer.
  test("config.ts injects the default after managedPolicies and before integrations", () => {
    const src = fs.readFileSync(path.join(import.meta.dir, "../src/config.ts"), "utf8")
    expect(src).toContain('from "./config/omnibreach-defaults.js"')
    const iPolicies = src.indexOf("...managedPolicies,")
    const iDefaults = src.indexOf("omnibreachDefaults()")
    const iIntegrations = src.indexOf("...integrations.values(),")
    expect(iPolicies).toBeGreaterThan(-1)
    expect(iDefaults).toBeGreaterThan(iPolicies)
    expect(iIntegrations).toBeGreaterThan(iDefaults)
  })

  // (b) A higher-priority doc (an installer omnibreach.json) overrides the baked default. Uses the
  //     real Config.latest accessor (lowest->highest, findLast).
  test("a higher-priority config doc overrides the baked model; defaults show when alone", () => {
    const userDoc = new Document({
      type: "document",
      info: Schema.decodeUnknownSync(Info)({ model: "omnibreach/custom-model" }),
    })
    const overridden = Config.latest([omnibreachDefaults(), userDoc], "model") as
      | { model?: string }
      | undefined
    expect(overridden?.model).toBe("custom-model")

    const defaultOnly = Config.latest([omnibreachDefaults()], "model") as
      | { providerID?: string }
      | undefined
    expect(defaultOnly?.providerID).toBe("omnibreach")
  })

  // (b, deep-merge) "keeps the rest": OpenCode builds providers by flat-mapping EVERY config
  // document (config/plugin/provider.ts), so a higher layer overlays the baked default field-by-field
  // rather than replacing it. Guarded as a source dependency the default layer relies on.
  test("provider assembly overlays all config layers (deep-merge dependency holds)", () => {
    const src = fs.readFileSync(path.join(import.meta.dir, "../src/config/plugin/provider.ts"), "utf8")
    expect(src).toMatch(/function configuredProviders\(entries[\s\S]*?\.flatMap\([\s\S]*?info\.providers/)
  })

  // The pentest system prompt is baked via InstructionBuiltIns (always loaded into the prompt),
  // embedded as a compiled text asset — not a config `instructions` path (fragile in a single binary).
  test("the pentest prompt is baked into InstructionBuiltIns and trimmed of backend-only lines", () => {
    const builtins = fs.readFileSync(path.join(import.meta.dir, "../src/instructions/builtins.ts"), "utf8")
    expect(builtins).toContain('from "./omnibreach-pentest.md"')
    expect(builtins).toContain("core/omnibreach-pentest")
    expect(builtins).toContain("pentestPrompt")

    const prompt = fs.readFileSync(path.join(import.meta.dir, "../src/instructions/omnibreach-pentest.md"), "utf8")
    expect(prompt).toContain("autonomous penetration-testing agent")
    expect(prompt).not.toContain("retrieve_tool_output")
  })
})
