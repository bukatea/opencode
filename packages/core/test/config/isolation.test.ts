import { expect } from "bun:test"
import fs from "node:fs/promises"
import { Cause, Effect, Exit, Layer } from "effect"
import { HttpClient } from "effect/http"
import { TestClock } from "effect/testing"
import { Config } from "@opencode/core/config"
import { ConfigDiscovery } from "@opencode/core/config/discovery"
import { ConfigPluginSource } from "@opencode/core/config/plugin/source"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { Bus } from "@opencode/core/bus"
import { Credential } from "@opencode/core/credential"
import { Global } from "@opencode/util/global"
import { FSUtil } from "@opencode/util/fs-util"
import { Location } from "@opencode/core/location"
import { KV } from "@opencode/core/kv"
import { ManagedPolicy } from "@opencode/core/managed-policy"
import { AbsolutePath } from "@opencode/core/schema"
import { WellKnown } from "@opencode/core/wellknown"
import { Watcher } from "@opencode/core/filesystem/watcher"
import { Integration } from "@opencode/schema/integration"
import { emptyCredentialNode } from "../fixture/config-nodes"
import { location } from "../fixture/location"
import { tmpdirScoped } from "../fixture/tmpdir"
import { drain } from "../lib/clock"
import { testEffect } from "../lib/effect"

const it = testEffect(Layer.empty)
const entry: WellKnown.Entry = {
  origin: "https://fixture.invalid",
  integrationID: Integration.ID.make("https://fixture.invalid"),
  manifest: { auth: { command: ["never-execute"], env: "FIXTURE_KEY" } },
}

function fixture(directory: string, options: Config.Options & { isolated?: boolean }, calls: string[]) {
  const call = <A>(name: string, value: A) =>
    Effect.sync(() => {
      calls.push(name)
      return value
    })
  const watcher = Watcher.testLayer
  return Layer.mergeAll(
    AppNodeBuilder.build(
      LayerNode.group([Config.node, ConfigPluginSource.node, Bus.node, FSUtil.node, Global.node, Location.node]),
      [
        Config.node.replace(Config.configured({ system: false, project: false, global: false, ...options })),
        Location.node.replace(Layer.succeed(Location.Service, location({ directory: AbsolutePath.make(directory) }))),
        Global.node.replace(Global.layerWith({ config: directory + "/global", home: directory + "/home" })),
        Credential.node.replace(emptyCredentialNode),
        WellKnown.node.replace(
          Layer.succeed(
            WellKnown.Service,
            WellKnown.Service.of({
              entries: () => call("entries", [entry]),
              snapshot: () => {
                calls.push("snapshot")
                return [entry]
              },
              cached: () =>
                call("cached", [
                  {
                    shell: "cached-sentinel",
                    plugins: ["fixture-plugin"],
                    policies: [{ action: "tool.use", resource: "shell:*", effect: "deny" }],
                  },
                ]),
              refresh: () => call("refresh", false),
              resolve: () => Effect.die(new Error("unexpected resolve")),
              add: () => Effect.die(new Error("unexpected add")),
              remove: () => Effect.die(new Error("unexpected remove")),
            }),
          ),
        ),
        Watcher.node.replace(watcher),
      ],
    ),
    watcher,
  )
}

it.effect("causal baseline: cached well-known survives disabled filesystem and empty inline plugins", () =>
  Effect.gen(function* () {
    const tmp = yield* tmpdirScoped()
    const calls: string[] = []
    yield* Effect.gen(function* () {
      const config = yield* Config.Service
      const source = yield* ConfigPluginSource.Service
      expect(yield* config.entries()).toHaveLength(2)
      expect(Config.latest(yield* config.entries(), "shell")).toBe("cached-sentinel")
      expect(yield* source.operations()).toEqual([{ type: "add", target: "fixture-plugin", options: {} }])
      expect(calls).toEqual(["entries", "cached"])
    }).pipe(Effect.provide(fixture(tmp.path, { content: '{"plugin":[]}' }, calls)))
  }),
)

it.effect("isolated: inline-only config excludes cached sources, watches, events, refresh and update", () =>
  Effect.gen(function* () {
    const tmp = yield* tmpdirScoped()
    const calls: string[] = []
    yield* Effect.gen(function* () {
      const config = yield* Config.Service
      const bus = yield* Bus.Service
      const watcher = yield* Watcher.Test
      expect(yield* config.entries()).toHaveLength(1)
      expect(Config.latest(yield* config.entries(), "shell")).toBe("inline")
      expect(yield* config.compatibility!()).toEqual({ claude: [], agents: [] })
      expect(config.update).toBeUndefined()
      expect(calls).toEqual([])
      expect(yield* watcher.subscriptions()).toEqual([])
      yield* bus.publish(Credential.Event.Switched, { integrationID: entry.integrationID, credentialID: null })
      yield* bus.publish(WellKnown.Event.Updated, {}, { global: true })
      yield* watcher.emit({ path: tmp.path + "/global/opencode.json", type: "update" })
      yield* TestClock.adjust("20 minutes")
      yield* drain
      expect(yield* config.entries()).toHaveLength(1)
      expect(calls).toEqual([])
      expect(yield* watcher.subscriptions()).toEqual([])
    }).pipe(Effect.provide(fixture(tmp.path, { isolated: true, content: '{"shell":"inline","plugin":[]}' }, calls)))
  }),
)

it.effect("isolated: discovery cannot be re-enabled", () =>
  Effect.gen(function* () {
    const tmp = yield* tmpdirScoped()
    yield* Effect.gen(function* () {
      expect(
        yield* ConfigDiscovery.discover({
          isolated: true,
          global: true,
          project: true,
          system: tmp.path,
          file: tmp.path + "/never",
        }),
      ).toEqual({ direct: [], project: [], claude: [], agents: [] })
    }).pipe(Effect.provide(fixture(tmp.path, { content: "{}" }, [])))
  }),
)

for (const content of [
  undefined,
  "",
  " ",
  "null",
  "[]",
  "{",
  '{"snapshot":"SECRET_SENTINEL"}',
  '{"plugin":["fixture-plugin"]}',
  '{"plugins":["-*"]}',
]) {
  it.effect(`isolated: rejects invalid inline content ${JSON.stringify(content)}`, () =>
    Effect.gen(function* () {
      const tmp = yield* tmpdirScoped()
      const calls: string[] = []
      const result = yield* Effect.gen(function* () {
        const config = yield* Config.Service
        return yield* config.entries()
      }).pipe(Effect.provide(fixture(tmp.path, { isolated: true, content }, calls)), Effect.exit)
      expect(Exit.isFailure(result)).toBe(true)
      expect(JSON.stringify(result)).not.toContain("SECRET_SENTINEL")
      expect(calls).toEqual([])
    }),
  )
}

it.effect("isolated: rejects explicit file conflict", () =>
  Effect.gen(function* () {
    const tmp = yield* tmpdirScoped()
    const result = yield* Effect.gen(function* () {
      const config = yield* Config.Service
      return yield* config.entries()
    }).pipe(
      Effect.provide(fixture(tmp.path, { isolated: true, content: "{}", file: tmp.path + "/absent.json" }, [])),
      Effect.exit,
    )
    expect(Exit.isFailure(result)).toBe(true)
  }),
)

it.effect("isolated: native/legacy payload normalizes without diagnostics", () =>
  Effect.gen(function* () {
    const tmp = yield* tmpdirScoped()
    const content = JSON.stringify({
      model: "openai/fixture",
      agent: { build: { mode: "primary" } },
      permission: { bash: "deny", edit: "deny" },
      plugin: [],
      instructions: [],
    })
    yield* Effect.gen(function* () {
      const config = yield* Config.Service
      expect(yield* config.entries()).toHaveLength(1)
      expect(Config.latest(yield* config.entries(), "permissions")).toEqual([
        { action: "shell", resource: "*", effect: "deny" },
        { action: "edit", resource: "*", effect: "deny" },
      ])
    }).pipe(Effect.provide(fixture(tmp.path, { isolated: true, content }, [])))
  }),
)

it.effect("isolated: complete legacy hook payload normalizes without dropping its authored agent", () =>
  Effect.gen(function* () {
    const tmp = yield* tmpdirScoped()
    // Immutable ai-push-hooks 8c6f5f8 opencode_support.py:166-183,245-261, read-only branch.
    const permission = Object.fromEntries(
      [
        "*",
        "read",
        "glob",
        "grep",
        "list",
        "edit",
        "bash",
        "task",
        "external_directory",
        "webfetch",
        "websearch",
        "lsp",
        "skill",
        "todowrite",
        "question",
        "doom_loop",
      ].map((name) => [name, "deny"]),
    )
    const content = JSON.stringify({
      $schema: "https://opencode.ai/config.json",
      plugin: [],
      mcp: {},
      share: "disabled",
      instructions: [],
      formatter: false,
      lsp: false,
      command: {},
      agent: {
        "hook-read-only": { mode: "primary", description: "Read-only ai-push-hooks analysis agent", permission },
      },
    })
    yield* Effect.gen(function* () {
      const config = yield* Config.Service
      const entries = yield* config.entries()
      expect(entries).toHaveLength(1)
      expect(Config.latest(entries, "agents")?.["hook-read-only"]?.permissions).toContainEqual({
        action: "*",
        resource: "*",
        effect: "deny",
      })
      expect(Config.latest(entries, "formatter")).toBe(false)
      expect(Config.latest(entries, "lsp")).toBe(false)
    }).pipe(Effect.provide(fixture(tmp.path, { isolated: true, content }, [])))
  }),
)

it.effect("isolated: default configuration still preserves system policy precedence", () =>
  Effect.gen(function* () {
    const tmp = yield* tmpdirScoped()
    const system = tmp.path + "/system"
    yield* Effect.promise(async () => {
      await fs.mkdir(system)
      await fs.writeFile(
        system + "/opencode.json",
        JSON.stringify({ shell: "system", policies: [{ action: "tool.use", resource: "shell:*", effect: "deny" }] }),
      )
    })
    yield* Effect.gen(function* () {
      const config = yield* Config.Service
      const entries = yield* config.entries()
      expect(Config.latest(entries, "shell")).toBe("system")
      expect(
        ManagedPolicy.decision(ManagedPolicy.statements(entries, { statements: [] }), "tool.use", "shell:ls"),
      ).toBe("deny")
    }).pipe(
      Effect.provide(
        fixture(
          tmp.path,
          {
            isolated: false,
            global: true,
            project: false,
            system,
            content: '{"shell":"inline","policies":[{"action":"tool.use","resource":"shell:*","effect":"allow"}]}',
          },
          [],
        ),
      ),
    )
  }),
)

it.effect("isolated: default Config.update still preserves JSONC in the global fallback", () =>
  Effect.gen(function* () {
    const tmp = yield* tmpdirScoped()
    const file = tmp.path + "/global/opencode.jsonc"
    yield* Effect.promise(async () => {
      await fs.mkdir(tmp.path + "/global")
      await fs.writeFile(file, '// keep this comment\n{ "shell": "before", "username": "fixture" }\n')
    })
    yield* Effect.gen(function* () {
      const config = yield* Config.Service
      expect(config.update).toBeDefined()
      if (!config.update) throw new Error("ordinary Config.update missing")
      yield* config.update({ shell: "after" })
      const text = yield* Effect.promise(() => fs.readFile(file, "utf8"))
      expect(text).toContain("// keep this comment")
      expect(text).toContain('"shell": "after"')
      expect(text).toContain('"username": "fixture"')
    }).pipe(Effect.provide(fixture(tmp.path, { content: "{}" }, [])))
  }),
)

it.effect("isolated: disabled WellKnown reads and mutators never touch KV or HTTP", () =>
  Effect.gen(function* () {
    const calls: string[] = []
    const refuse = (name: string) =>
      Effect.sync(() => {
        calls.push(name)
        throw new Error(name)
      })
    yield* Effect.gen(function* () {
      const service = yield* WellKnown.Service
      expect(yield* service.entries()).toEqual([])
      expect(service.snapshot()).toEqual([])
      expect(yield* service.cached(entry.origin)).toEqual([])
      expect(yield* service.refresh()).toBe(false)
      for (const effect of [Effect.asVoid(service.add(entry.origin)), Effect.asVoid(service.resolve(entry, {}))]) {
        const result = yield* Effect.exit(effect)
        expect(Exit.isFailure(result) && Cause.hasFails(result.cause)).toBe(true)
        expect(Exit.isFailure(result) && Cause.hasDies(result.cause)).toBe(false)
      }
      const removed = yield* Effect.exit(service.remove(entry.origin))
      expect(Exit.isFailure(removed) && Cause.hasDies(removed.cause)).toBe(true)
      expect(yield* service.entries()).toEqual([])
      expect(calls).toEqual([])
    }).pipe(
      Effect.provide(AppNodeBuilder.build(WellKnown.disabled)),
      Effect.provide(
        Layer.mergeAll(
          Layer.succeed(
            KV.Service,
            KV.Service.of({
              get: () => refuse("get"),
              set: () => refuse("set"),
              remove: () => refuse("remove"),
              scan: () => refuse("scan"),
            }),
          ),
          Layer.succeed(
            HttpClient.HttpClient,
            HttpClient.make(() => refuse("HTTP")),
          ),
        ),
      ),
    )
  }),
)
