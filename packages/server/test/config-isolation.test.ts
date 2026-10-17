import { expect, spyOn } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { Context, Effect, Fiber, Layer, Logger, Stream } from "effect"
import { HttpClient, HttpClientResponse, HttpServer } from "effect/http"
import { createEmbeddedRoutes } from "../src/routes"
import { SdkInstances } from "../../sdk/src/internal/instances"
import { Config } from "@opencode/core/config"
import { Bus } from "@opencode/core/bus"
import { Credential } from "@opencode/core/credential"
import { Database } from "@opencode/core/database/database"
import { Instance } from "@opencode/core/instance"
import { InstructionDiscovery } from "@opencode/core/instruction-discovery"
import { LocationServiceMap } from "@opencode/core/location-service-map"
import { Mcp } from "@opencode/core/mcp/index"
import { Model } from "@opencode/core/model"
import { Permission } from "@opencode/core/permission"
import { Plugin } from "@opencode/core/plugin"
import { Provider } from "@opencode/core/provider"
import { Session } from "@opencode/core/session"
import { WebSearch } from "@opencode/core/websearch"
import { WellKnown } from "@opencode/core/wellknown"
import { Watcher } from "@opencode/core/filesystem/watcher"
import { Host } from "@opencode/plugin/host"
import { define } from "@opencode/plugin/effect/plugin"
import { Integration } from "@opencode/schema/integration"
import { Location } from "@opencode/schema/location"
import { AbsolutePath } from "@opencode/schema/schema"
import { LayerNodePlatform } from "@opencode/util/effect/app-node-platform"
import { Global } from "@opencode/util/global"
import { Npm } from "@opencode/util/npm"
import { AppProcess } from "@opencode/util/process"
import { tmpdirScoped } from "../../core/test/fixture/tmpdir"
import { advance, drain } from "../../core/test/lib/clock"
import { it } from "../../core/test/lib/effect"

it.effect(
  "isolated: owning routes and lazy private instance retain Console policy and datastore but exclude authored authority",
  () =>
    Effect.gen(function* () {
      const tmp = yield* tmpdirScoped()
      const directories = [path.join(tmp.path, "first"), path.join(tmp.path, "second")]
      yield* Effect.promise(() => Promise.all(directories.map((directory) => fs.mkdir(directory))))
      const configDirectory = path.join(tmp.path, "config")
      yield* Effect.promise(async () => {
        await fs.mkdir(configDirectory)
        await fs.writeFile(
          path.join(configDirectory, "opencode.json"),
          '{"shell":"ambient","plugin":["fixture-plugin"]}',
        )
        await fs.writeFile(path.join(configDirectory, "AGENTS.md"), "AMBIENT BOOT INSTRUCTION")
        for (const directory of directories)
          await fs.writeFile(path.join(directory, "AGENTS.md"), "PROJECT BOOT INSTRUCTION")
      })
      const violations: string[] = []
      const imports: string[] = []
      const installs: string[] = []
      const exclusions: unknown[] = []
      const logger = Logger.map(Logger.formatStructured, (entry) => {
        if (Array.isArray(entry.message) && entry.message[0] === "isolated configuration excludes account domains")
          exclusions.push(entry.message)
      })
      let activations = 0
      let requests = 0
      let failing = false
      let remove = false
      const watcher = Watcher.testLayer
      const refuse = (name: string) =>
        Effect.sync(() => {
          violations.push(name)
          throw new Error(name)
        })
      const http = HttpClient.make((request) => {
        // Preserved native-provider discovery is not a ConfigPluginSource import. No request leaves this fake.
        if (
          [
            "http://127.0.0.1:1234/api/v1/models",
            "http://127.0.0.1:11434/api/tags",
            "http://127.0.0.1:8000/health",
          ].includes(request.url)
        )
          return Effect.succeed(HttpClientResponse.fromWeb(request, new Response(null, { status: 404 })))
        if (request.url === "https://stored.invalid/.well-known/opencode")
          return Effect.succeed(
            HttpClientResponse.fromWeb(
              request,
              Response.json({
                auth: { command: ["never-execute"], env: "FIXTURE_AUTH" },
                config: {
                  shell: "stored",
                  plugins: remove ? ["fixture-plugin", "-*"] : ["fixture-plugin"],
                  policies: [{ action: "provider.use", resource: "remote", effect: "deny" }],
                },
              }),
            ),
          )
        if (request.url !== "https://console.invalid/api/v2/config") return refuse("unexpected HTTP " + request.url)
        requests++
        return Effect.succeed(
          HttpClientResponse.fromWeb(
            request,
            failing
              ? new Response("Unavailable", { status: 502 })
              : Response.json({
                  providers: {
                    remote: {
                      name: "Remote",
                      package: "aisdk:retained-executable-provider",
                      models: { fixture: { name: "Fixture" } },
                    },
                    forbidden: {
                      name: "Forbidden",
                      package: "aisdk:never-load",
                      models: { fixture: { name: "Fixture" } },
                    },
                  },
                  mcp: { servers: { account: { type: "remote", url: "https://mcp.invalid", enabled: false } } },
                  websearch: { providerID: "account-search" },
                  policies: [{ action: "provider.use", resource: "forbidden", effect: "deny" }],
                  experimental: {
                    policies: [
                      { action: "tool.use", resource: "shell:*", effect: "deny", message: "Organization deny" },
                    ],
                  },
                }),
          ),
        )
      })
      const global = Global.layerWith({
        home: tmp.path,
        config: configDirectory,
        data: path.join(tmp.path, "data"),
        cache: path.join(tmp.path, "cache"),
        state: path.join(tmp.path, "state"),
        tmp: path.join(tmp.path, "tmp"),
      })
      const database = Database.configured({ path: path.join(tmp.path, "same-datastore.db") })
      const npm = Layer.succeed(
        Npm.Service,
        Npm.Service.of({
          add: (name) => {
            installs.push(name)
            return refuse("unexpected install")
          },
          resolve: (name) =>
            Effect.sync(() => {
              if (name !== "fixture-plugin") {
                violations.push("unexpected package " + name)
                throw new Error(name)
              }
              return { directory: configDirectory, name }
            }),
          check: (name) =>
            name === "fixture-plugin" ? Effect.succeed(false) : refuse("unexpected package check " + name),
          update: () => refuse("unexpected package update"),
          which: () => Effect.undefined,
        }),
      )
      yield* Effect.promise(async () => {
        await fs.writeFile(
          path.join(configDirectory, "package.json"),
          JSON.stringify({ name: "fixture-plugin", exports: { ".": "./fixture.ts" } }),
        )
        await fs.writeFile(path.join(configDirectory, "fixture.ts"), "// Import boundary is faked; never evaluated.\n")
      })
      const load = spyOn(Host, "load").mockImplementation(async (url) => {
        imports.push(url)
        return {
          default: define({
            id: "fixture-plugin",
            effect: () =>
              Effect.sync(() => {
                activations++
              }),
          }),
        }
      })
      yield* Effect.addFinalizer(() => Effect.sync(() => load.mockRestore()))
      let credentialID: Credential.ID | undefined
      for (const scenario of [
        { isolated: undefined },
        { isolated: false },
        { isolated: false, remove: true },
        { isolated: true },
        { isolated: false },
      ]) {
        const isolated = scenario.isolated
        remove = scenario.remove ?? false
        failing = false
        yield* Effect.scoped(
          Effect.gen(function* () {
            const context = yield* Layer.build(
              createEmbeddedRoutes(
                {
                  config: {
                    isolated,
                    directory: configDirectory,
                    content: JSON.stringify({
                      shell: "inline",
                      plugin: remove ? ["-*"] : [],
                      policies: [{ action: "tool.use", resource: "shell:*", effect: "allow" }],
                    }),
                  },
                  database: { path: path.join(tmp.path, "same-datastore.db") },
                  models: { fetch: false },
                  fs: { filewatcher: false, fff: false },
                },
                [
                  Global.node.replace(global),
                  Database.node.replace(database),
                  LayerNodePlatform.httpClient.replace(Layer.succeed(HttpClient.HttpClient, http)),
                  Npm.node.replace(npm),
                  Watcher.node.replace(watcher),
                  AppProcess.node.replace(
                    Layer.succeed(
                      AppProcess.Service,
                      AppProcess.Service.of({
                        spawn: () => refuse("unexpected process spawn"),
                        exitCode: () => refuse("unexpected process exitCode"),
                        string: () => refuse("unexpected process string"),
                        lines: () => refuse("unexpected process lines"),
                        streamString: () => Stream.fromEffect(refuse("unexpected process streamString")),
                        streamLines: () => Stream.fromEffect(refuse("unexpected process streamLines")),
                        run: (command) =>
                          command._tag === "StandardCommand" &&
                          command.command === "git" &&
                          command.args.join(" ") === "rev-parse --git-dir --git-common-dir --show-toplevel"
                            ? Effect.succeed({
                                command: "fixture git discovery",
                                exitCode: 128,
                                stdout: Buffer.alloc(0),
                                stderr: Buffer.alloc(0),
                                stdoutTruncated: false,
                                stderrTruncated: false,
                              })
                            : refuse("unexpected process run " + JSON.stringify(command)),
                        runStream: () => Stream.fromEffect(refuse("unexpected process stream")),
                      }),
                    ),
                  ),
                ],
                (replacements) =>
                  SdkInstances.node(
                    { key: (session) => session.id, configure: () => Effect.succeed({ plugins: [] }) },
                    replacements,
                  ),
              ).pipe(
                Layer.provide(HttpServer.layerServices),
                Layer.provide(Logger.layer([logger])),
                Layer.provideMerge(watcher),
              ),
            )
            const credentials = Context.get(context, Credential.Service)
            const wellknown = Context.get(context, WellKnown.Service)
            if (!isolated) {
              if (credentialID === undefined)
                credentialID = (yield* credentials.create({
                  integrationID: Integration.ID.make("opencode"),
                  value: Credential.Key.make({
                    type: "key",
                    key: "fixture-key",
                    metadata: { server: "https://console.invalid", orgName: "Fixture org" },
                  }),
                })).id
              const stored = yield* wellknown.add("https://stored.invalid")
              yield* wellknown.resolve(stored, {})
              expect(yield* wellknown.cached(stored.origin)).toHaveLength(1)
            }
            expect((yield* credentials.list(Integration.ID.make("opencode"))).at(-1)?.id).toBe(credentialID)
            expect((yield* credentials.list(Integration.ID.make("opencode"))).at(-1)?.value).toMatchObject({
              type: "key",
              key: "fixture-key",
            })
            const before = imports.length
            const activated = activations
            const locations = Context.get(context, LocationServiceMap.Service)
            const selector = Context.get(context, Instance.Service)
            const sessions = Context.get(context, Session.Service)
            const inspect = (sessionID: Session.ID) =>
              Effect.gen(function* () {
                const plugin = yield* Plugin.Service
                yield* plugin.awaitActivation
                expect((yield* plugin.list()).filter((item) => item.state.status === "failed")).toEqual([])
                const config = yield* Config.Service
                const instructions = yield* InstructionDiscovery.Service
                const providers = yield* Provider.Service
                const models = yield* Model.Service
                const search = yield* WebSearch.Service
                const mcp = yield* Mcp.Service
                if (!isolated) {
                  expect((yield* config.entries()).length).toBeGreaterThan(1)
                  expect(
                    (yield* config.entries()).some(
                      (entry) => entry.type === "document" && entry.info.shell === "stored",
                    ),
                  ).toBe(true)
                  return
                }
                expect(yield* config.entries()).toHaveLength(1)
                expect(config.isolated).toBe(true)
                expect(config.update).toBeUndefined()
                expect(yield* config.compatibility!()).toEqual({ claude: [], agents: [] })
                expect(instructions.project).toBe(false)
                expect(instructions.global).toBe(false)
                expect(yield* instructions.list()).toEqual([])
                expect(yield* wellknown.entries()).toEqual([])
                expect(yield* wellknown.cached("https://stored.invalid")).toEqual([])
                expect(yield* providers.get(Provider.ID.make("remote"))).toMatchObject({
                  package: "aisdk:retained-executable-provider",
                  integrationID: "opencode",
                })
                expect(yield* models.get(Provider.ID.make("remote"), Model.ID.make("fixture"))).toMatchObject({
                  package: "aisdk:retained-executable-provider",
                })
                expect(yield* providers.get(Provider.ID.make("forbidden"))).toBeUndefined()
                expect((yield* search.providers()).some((provider) => provider.id === "account-search")).toBe(false)
                expect(yield* mcp.servers()).toEqual([])
                const permission = yield* Permission.Service
                const result = yield* permission.ask({ sessionID, action: "shell", resources: ["anything"] })
                expect(result.effect).toBe("deny")
                expect(
                  (yield* Context.get(context, Watcher.Test).subscriptions()).filter((subscription) =>
                    subscription.path.startsWith(configDirectory),
                  ),
                ).toEqual([])
              })
            // Real ordinary location graph, followed by a second graph constructed lazily by the owning selector.
            const settle = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
              Effect.gen(function* () {
                let done = false
                const fiber = yield* effect.pipe(
                  Effect.ensuring(
                    Effect.sync(() => {
                      done = true
                    }),
                  ),
                  Effect.forkChild({ startImmediately: true }),
                )
                yield* advance(() => done)
                return yield* Fiber.join(fiber)
              })
            const first = yield* sessions.create({
              location: Location.Ref.make({ directory: AbsolutePath.make(directories[0]!) }),
              permissions: [{ action: "*", resource: "*", effect: "allow" }],
            })
            yield* settle(inspect(first.id).pipe(Effect.provide(locations.get(first.location))))
            const session = yield* sessions.create({
              location: Location.Ref.make({ directory: AbsolutePath.make(directories[1]!) }),
              permissions: [{ action: "*", resource: "*", effect: "allow" }],
            })
            yield* settle(inspect(session.id).pipe(selector.provide(session)))
            if (isolated) {
              expect(exclusions).toEqual([
                ["isolated configuration excludes account domains", { categories: ["mcp", "websearch"] }],
                ["isolated configuration excludes account domains", { categories: ["mcp", "websearch"] }],
              ])
              expect(imports.length).toBe(before)
              expect(activations).toBe(activated)
              // Successful reload must not register the excluded account domains either.
              const loaded = requests
              yield* Context.get(context, Bus.Service).publish(Credential.Event.Switched, {
                integrationID: Integration.ID.make("opencode"),
                credentialID: credentialID!,
              })
              yield* advance(() => requests > loaded)
              yield* drain
              yield* settle(inspect(first.id).pipe(Effect.provide(locations.get(first.location))))
              yield* settle(inspect(session.id).pipe(selector.provide(session)))
              const fetched = requests
              failing = true
              yield* Context.get(context, Bus.Service).publish(Credential.Event.Switched, {
                integrationID: Integration.ID.make("opencode"),
                credentialID: credentialID!,
              })
              yield* advance(() => requests > fetched)
              yield* drain
              expect(requests).toBeGreaterThan(fetched)
              yield* settle(inspect(session.id).pipe(selector.provide(session)))
              expect(imports.length).toBe(before)
              expect(activations).toBe(activated)
            } else {
              expect(imports.length).toBeGreaterThan(before)
              // Removal is too late to prevent module import, even though it suppresses activation.
              expect(activations - activated).toBe(remove ? 0 : 2)
            }
          }),
        )
      }
      expect(installs).toEqual([])
      expect(violations).toEqual([])
    }),
)
