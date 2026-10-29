export * as OmnibreachDefaults from "./omnibreach-defaults.js"

import { Schema } from "effect"
import { Document, Info } from "@opencode/schema/config"

// Baked, lowest-priority default config layer for the OmniBreach fork. The installer drops an
// `omnibreach.json` (a higher-priority layer) carrying the per-deployment gateway `baseURL` and
// per-client cert/key paths; because OpenCode overlays provider config across layers
// (`config/plugin/provider.ts` flat-maps every entry), those supplied values merge on top of the
// structure baked here while keeping the baked name/models.
//
// NOT baked (supplied at install, per spec §3.3): the gateway `baseURL`, and the client cert/key
// paths (which live under the omnibreach provider's settings and drive the mTLS fetch — Task 5).
const RAW = {
  model: "omnibreach/omnibreach-agent",
  providers: {
    omnibreach: {
      package: "@ai-sdk/openai-compatible",
      name: "OmniBreach Gateway",
      models: {
        "omnibreach-agent": {
          name: "OmniBreach Agent",
          limit: { context: 131072, output: 12288 },
        },
      },
    },
  },
  mcp: {
    servers: {
      // Default OmniBreach MCP tool server. The MCP server is a stdio process (omnibreach_mcp.py)
      // launched via `docker exec` into the client's tool container; the 127.0.0.1:8888 here is the
      // backend that stdio process talks to (its --server arg), NOT an MCP transport endpoint. This
      // matches the known-good spike config (harness/omnibreach-spike/opencode.json). The installer
      // (sub-project C) can override the container name / python path if a deployment differs.
      "omnibreach-tools": {
        type: "local",
        command: [
          "/usr/bin/docker",
          "exec",
          "-i",
          "omnibreach-server",
          "/app/.venv/bin/python",
          "/app/omnibreach_mcp.py",
          "--server",
          "http://127.0.0.1:8888",
        ],
      },
    },
  },
} as const

// Decoded once through the real config schema so the built-in is identical in shape to a loaded
// omnibreach.json entry. Any schema drift fails loudly at module load, not silently at runtime.
const INFO = Schema.decodeUnknownSync(Info)(RAW)

/** The built-in default config document, injected as the lowest-priority source in `Config.load()`. */
export function omnibreachDefaults(): Document {
  return new Document({ type: "document", info: INFO })
}
