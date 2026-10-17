import { expect, spyOn, test } from "bun:test"
import { Effect, Exit, Layer, Option } from "effect"
import { Service } from "@opencode/client/effect/service"
import { Global } from "@opencode/util/global"
import { NodeFileSystem } from "@effect/platform-node"
import { ServiceConfig } from "../src/services/service-config"
import { Standalone } from "../src/services/standalone"
import { ServerConnection } from "../src/services/server-connection"
import { ServerProcess } from "../src/server-process"
import { runV1Bridge } from "../src/run/v1"
import pair from "../src/commands/handlers/pair"
import start from "../src/commands/handlers/service/start"
import restart from "../src/commands/handlers/service/restart"
import status from "../src/commands/handlers/service/status"
import stop from "../src/commands/handlers/service/stop"
import get from "../src/commands/handlers/service/get"
import set from "../src/commands/handlers/service/set"
import unset from "../src/commands/handlers/service/unset"
import acp from "../src/commands/handlers/acp"
import serve from "../src/commands/handlers/serve"
import models from "../src/commands/handlers/models"

async function withValue(value: string | undefined, body: () => Promise<void>) {
  const previous = process.env.OPENCODE_CONFIG_ISOLATED
  const client = process.env.OPENCODE_CLIENT
  const exitCode = process.exitCode
  if (value === undefined) delete process.env.OPENCODE_CONFIG_ISOLATED
  else process.env.OPENCODE_CONFIG_ISOLATED = value
  try {
    await body()
  } finally {
    process.exitCode = exitCode ?? 0
    if (client === undefined) delete process.env.OPENCODE_CLIENT
    else process.env.OPENCODE_CLIENT = client
    if (previous === undefined) delete process.env.OPENCODE_CONFIG_ISOLATED
    else process.env.OPENCODE_CONFIG_ISOLATED = previous
  }
}

const options = { file: "never-read", command: ["never-execute"], version: undefined, env: undefined }
const cases = [
  ["pair", () => pair({ remote: true, yes: true, url: Option.none() }), "read"],
  ["service start", () => start({}), "options"],
  ["service restart", () => restart({}), "options"],
  ["service status", () => status({}), "options"],
  ["service stop", () => stop({}), "options"],
  ["service get", () => get({ key: Option.none(), name: Option.none() }), "get"],
  ["service set", () => set({ key: "remote", value: "true", nestedValue: Option.none() }), "set"],
  ["service unset", () => unset({ key: "remote", name: Option.none() }), "unset"],
  ["ACP", () => acp({ login: false }), "child"],
  ["ACP login", () => acp({ login: true }), "read"],
  [
    "serve service",
    () => serve({ service: true, stdio: false, hostname: Option.none(), port: Option.none(), cors: [] }),
    "owner-layer",
  ],
  ["direct managed owner", () => ServerProcess.run({ mode: "service" }), "owner-layer"],
  ["direct PTY shutdown", () => ServerConnection.shutdownPersistentPty(options), "discover"],
] as const

// Real handlers and admission stay intact. Every potential external operation is
// fail-hard, so a bypass cannot start a child, inspect service state or use HTTP.
for (const [name, invoke, first] of cases) {
  for (const value of ["true", "SECRET_SENTINEL", undefined, "false"]) {
    test(`ownership: ${name} ${value === "SECRET_SENTINEL" ? "invalid" : (value ?? "unset")}`, () =>
      withValue(value, async () => {
        const calls: string[] = []
        const refuse = (name: string) => () =>
          Effect.sync(() => {
            calls.push(name)
            throw new Error("external boundary")
          })
        const spies = [
          spyOn(ServiceConfig, "read").mockImplementation(refuse("read")),
          spyOn(ServiceConfig, "options").mockImplementation(refuse("options")),
          spyOn(ServiceConfig, "get").mockImplementation(refuse("get")),
          spyOn(ServiceConfig, "set").mockImplementation(refuse("set")),
          spyOn(ServiceConfig, "unset").mockImplementation(refuse("unset")),
          spyOn(ServiceConfig, "acceptRemote").mockImplementation(refuse("consent")),
          spyOn(Service, "ensure").mockImplementation(refuse("ensure")),
          spyOn(Service, "discover").mockImplementation(refuse("discover")),
          spyOn(Service, "incumbent").mockImplementation(refuse("incumbent")),
          spyOn(Service, "stop").mockImplementation(refuse("stop")),
          spyOn(Standalone, "start").mockImplementation(refuse("child")),
          spyOn(Global, "layerWith").mockImplementation(() => {
            calls.push("owner-layer")
            return Layer.effect(Global.Service, Effect.die(new Error("external boundary")))
          }),
          spyOn(globalThis, "fetch").mockImplementation(
            Object.assign(
              async () => {
                calls.push("HTTP")
                throw new Error("external boundary")
              },
              {
                preconnect: () => {
                  calls.push("HTTP preconnect")
                  throw new Error("unexpected HTTP preconnect")
                },
              },
            ),
          ),
        ]
        try {
          const result = await Effect.runPromise(
            invoke().pipe(
              Effect.exit,
              Effect.provide(NodeFileSystem.layer),
              Effect.provideService(Global.Service, Global.make()),
              Effect.scoped,
            ),
          )
          if (name === "ACP login" && (value === undefined || value === "false")) {
            expect(Exit.isSuccess(result)).toBe(true)
            expect(process.exitCode).toBe(1)
            expect(calls).toEqual([])
            return
          }
          expect(Exit.isFailure(result)).toBe(true)
          expect(String(result)).not.toContain("SECRET_SENTINEL")
          if (value === "true" || value === "SECRET_SENTINEL") {
            expect(String(result)).toContain(value === "true" ? "--standalone" : "OPENCODE_CONFIG_ISOLATED")
            expect(calls).toEqual([])
          } else {
            expect(String(result)).toContain("external boundary")
            expect(calls).toEqual([first])
          }
        } finally {
          spies.forEach((spy) => spy.mockRestore())
        }
      }))
  }
}

for (const mode of ["default", "stdio"] as const) {
  test(`ownership: actual serve ${mode} handler accepts explicit owner`, () =>
    withValue("true", async () => {
      const layer = spyOn(Global, "layerWith").mockImplementation(() =>
        Layer.effect(Global.Service, Effect.die(new Error("owned boundary"))),
      )
      try {
        const result = await Effect.runPromise(
          serve({
            service: false,
            stdio: mode === "stdio",
            hostname: Option.none(),
            port: Option.none(),
            cors: [],
          }).pipe(Effect.exit),
        )
        expect(String(result)).toContain("owned boundary")
        expect(layer).toHaveBeenCalledTimes(1)
      } finally {
        layer.mockRestore()
      }
    }))
  for (const value of [undefined, "false", "true", "SECRET_SENTINEL"]) {
    test(`ownership: explicit direct ${mode} owner ${value?.length ?? "unset"}`, () =>
      withValue(value, async () => {
        const layer = spyOn(Global, "layerWith").mockImplementation(() =>
          Layer.effect(Global.Service, Effect.die(new Error("owned boundary"))),
        )
        try {
          const result = await Effect.runPromise(ServerProcess.run({ mode }).pipe(Effect.exit))
          expect(String(result)).toContain(value === "SECRET_SENTINEL" ? "OPENCODE_CONFIG_ISOLATED" : "owned boundary")
          expect(String(result)).not.toContain("SECRET_SENTINEL")
          expect(layer).toHaveBeenCalledTimes(value === "SECRET_SENTINEL" ? 0 : 1)
        } finally {
          layer.mockRestore()
        }
      }))
  }
}

for (const value of [undefined, "false", "true"]) {
  test(`ownership: actual models explicit standalone handler ${value ?? "unset"}`, () =>
    withValue(value, async () => {
      const child = spyOn(Standalone, "start").mockImplementation(() => Effect.die(new Error("owned child boundary")))
      try {
        const result = await Effect.runPromise(
          models({ standalone: true, server: Option.none() }).pipe(
            Effect.exit,
            Effect.provide(NodeFileSystem.layer),
            Effect.provideService(Global.Service, Global.make()),
            Effect.scoped,
          ),
        )
        expect(String(result)).toContain("owned child boundary")
        expect(child).toHaveBeenCalledTimes(1)
      } finally {
        child.mockRestore()
      }
    }))
}

for (const value of [undefined, "false"]) {
  test(`ownership: ordinary pair and managed handler functions complete ${value ?? "unset"}`, () =>
    withValue(value, async () => {
      const calls: string[] = []
      const spies = [
        spyOn(ServiceConfig, "read").mockImplementation(() =>
          Effect.sync(() => {
            calls.push("read")
            return {}
          }),
        ),
        spyOn(ServiceConfig, "options").mockImplementation(() =>
          Effect.sync(() => {
            calls.push("options")
            return options
          }),
        ),
        spyOn(Service, "ensure").mockImplementation(() =>
          Effect.sync(() => {
            calls.push("ensure")
            return { url: "https://fixture.invalid", auth: undefined }
          }),
        ),
        spyOn(Service, "discover").mockImplementation(() =>
          Effect.sync(() => {
            calls.push("discover")
            return undefined
          }),
        ),
        spyOn(Service, "stop").mockImplementation(() =>
          Effect.sync(() => {
            calls.push("stop")
          }),
        ),
        spyOn(process.stdout, "write").mockImplementation(() => true),
        spyOn(globalThis, "fetch").mockImplementation(
          Object.assign(
            async () => {
              calls.push("HTTP pair")
              return Response.json({ code: "disposable-fixture-code", expires_in: 60 })
            },
            {
              preconnect: () => {
                throw new Error("unexpected preconnect")
              },
            },
          ),
        ),
      ]
      try {
        const invoke = Effect.gen(function* () {
          yield* pair({ remote: false, yes: false, url: Option.some("https://fixture.invalid") })
          yield* start({})
          yield* restart({})
          yield* status({})
          yield* stop({})
        })
        await Effect.runPromise(
          invoke.pipe(Effect.provide(NodeFileSystem.layer), Effect.provideService(Global.Service, Global.make())),
        )
        expect(calls).toEqual([
          "read",
          "options",
          "ensure",
          "HTTP pair",
          "options",
          "ensure",
          "options",
          "discover",
          "stop",
          "ensure",
          "options",
          "discover",
          "options",
          "discover",
          "stop",
        ])
      } finally {
        spies.forEach((spy) => spy.mockRestore())
      }
    }))
}

for (const value of ["true", "SECRET_SENTINEL", undefined, "false"]) {
  for (const server of [undefined, "https://must-not-connect.invalid"]) {
    test(`ownership: V1 API without explicit ownership ${value?.length ?? "unset"} ${server === undefined ? "child" : "remote"}`, () =>
      withValue(value, async () => {
        const calls: string[] = []
        const child = spyOn(Standalone, "start").mockImplementation(() => {
          calls.push("child")
          return Effect.die(new Error("unexpected child"))
        })
        const chdir = spyOn(process, "chdir").mockImplementation(() => {
          calls.push("chdir")
          throw new Error("unexpected chdir")
        })
        const stderr = spyOn(process.stderr, "write").mockImplementation(() => true)
        const previous = process.exitCode
        try {
          await runV1Bridge({ message: [], format: "default", file: [], server })
          if (value === undefined || value === "false") {
            expect(calls).toEqual(["chdir"])
            expect(stderr.mock.calls.map((call) => String(call[0])).join("")).toContain("Failed to change directory")
            return
          }
          expect(calls).toEqual([])
          expect(stderr.mock.calls.map((call) => String(call[0])).join("")).toContain(
            value === "true" ? "--standalone" : "OPENCODE_CONFIG_ISOLATED",
          )
          expect(stderr.mock.calls.map((call) => String(call[0])).join("")).not.toContain("SECRET_SENTINEL")
        } finally {
          process.exitCode = previous ?? 0
          child.mockRestore()
          chdir.mockRestore()
          stderr.mockRestore()
        }
      }))
  }
}
