import { describe, expect, test } from "bun:test"
import fs from "fs"
import os from "os"
import path from "path"
import { pathToFileURL } from "url"
import { ConfigDiscovery } from "@opencode/core/config/discovery"
import { configDirectories, projectConfigDirectories } from "../../tui/src/util/config-directories"

describe("config namespace", () => {
  test("global config dir resolves under omnibreach, not opencode", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "omnibreach-namespace-"))
    const directories = {
      data: path.join(root, "data"),
      cache: path.join(root, "cache"),
      config: path.join(root, "config"),
      state: path.join(root, "state"),
    }
    const module = pathToFileURL(path.join(import.meta.dir, "../../util/src/global.ts")).href
    const result = Bun.spawnSync({
      cmd: [process.execPath, "-e", `const { Global } = await import(${JSON.stringify(module)}); process.stdout.write(Global.Path.config)`],
      env: {
        ...process.env,
        XDG_DATA_HOME: directories.data,
        XDG_CACHE_HOME: directories.cache,
        XDG_CONFIG_HOME: directories.config,
        XDG_STATE_HOME: directories.state,
      },
      stdout: "pipe",
      stderr: "pipe",
    })

    expect(result.exitCode, result.stderr.toString()).toBe(0)
    const resolvedConfigDir = result.stdout.toString()
    expect(resolvedConfigDir).toBe(path.join(directories.config, "omnibreach"))
    expect(path.basename(resolvedConfigDir)).toBe("omnibreach")
    expect(resolvedConfigDir).not.toContain("opencode")
    fs.rmSync(root, { recursive: true, force: true })
  })

  test("project config filename is omnibreach.json/.jsonc, never opencode.json", () => {
    expect(ConfigDiscovery.names).toEqual(["omnibreach.json", "omnibreach.jsonc"])
    for (const name of ConfigDiscovery.names) {
      expect(name).not.toContain("opencode")
      expect(name.startsWith("omnibreach.")).toBe(true)
    }
  })

  test("no platform's system config directory or MDM preferences path contains opencode", () => {
    const paths = [
      ConfigDiscovery.systemDirectory("darwin", {}),
      ConfigDiscovery.systemDirectory("linux", {}),
      ConfigDiscovery.systemDirectory("win32", { ProgramData: "C:\\ProgramData" }),
      ...ConfigDiscovery.preferencePaths("alice"),
    ]
    for (const resolved of paths) {
      expect(resolved).not.toContain("opencode")
      expect(resolved.toLowerCase()).toContain("omnibreach")
    }
  })

  // The on-disk namespace the TUI and `mcp add` READ/WRITE must match what discovery (above) reads,
  // or `mcp add` writes a config discovery never loads. Guards the files outside discovery.ts.
  test("tui config + project dirs resolve under .omnibreach, never .opencode", () => {
    const cwd = path.join(os.tmpdir(), "a", "b", "c")
    const dirs = [
      ...configDirectories(path.join(os.tmpdir(), "cfg"), cwd).slice(1),
      ...projectConfigDirectories(path.join(os.tmpdir(), "a"), cwd),
    ]
    expect(dirs.length).toBeGreaterThan(0)
    for (const dir of dirs) {
      expect(path.basename(dir)).toBe(".omnibreach")
      expect(dir).not.toContain(".opencode")
    }
  })

  test("mcp add writes omnibreach.json/.omnibreach and the tui/plan writers drop .opencode", () => {
    const read = (rel: string) => fs.readFileSync(path.join(import.meta.dir, rel), "utf8")
    for (const rel of [
      "../../cli/src/commands/handlers/mcp/add.ts",
      "../../tui/src/plugin/discovery.ts",
      "../src/plugin/plan.ts",
    ]) {
      const text = read(rel)
      expect(text).not.toContain(".opencode")
      expect(text).toContain(".omnibreach")
    }
    const add = read("../../cli/src/commands/handlers/mcp/add.ts")
    expect(add).not.toContain("opencode.json")
    expect(add).toContain("omnibreach.json")
  })
})
