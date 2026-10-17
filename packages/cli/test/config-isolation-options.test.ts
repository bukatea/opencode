import { expect, test, spyOn } from "bun:test"
import { Effect, Exit, FileSystem, Layer, Schema, Scope } from "effect"
import { NodeFileSystem } from "@effect/platform-node"
import { ProcessId } from "effect/process/ChildProcessSpawner"
import { Global } from "@opencode/util/global"
import { Env } from "../src/env"
import { ServerConnection } from "../src/services/server-connection"
import { ServiceConfig } from "../src/services/service-config"
import { Standalone } from "../src/services/standalone"
import { Service } from "@opencode/client/effect/service"
import { ServerProcess } from "../src/server-process"
import { ServerOptions } from "@opencode/server/options"
import { OPENCODE_VERSION } from "../src/version"

const run = <A, E>(effect: Effect.Effect<A, E, FileSystem.FileSystem | Global.Service | Scope.Scope>) =>
  Effect.runPromise(
    effect.pipe(
      Effect.provide(NodeFileSystem.layer),
      Effect.provide(Layer.succeed(Global.Service, Global.make())),
      Effect.scoped,
    ),
  )

async function withValue(value: string | undefined, body: () => Promise<void>) {
  const previous = process.env.OPENCODE_CONFIG_ISOLATED
  if (value === undefined) delete process.env.OPENCODE_CONFIG_ISOLATED
  else process.env.OPENCODE_CONFIG_ISOLATED = value
  try {
    await body()
  } finally {
    if (previous === undefined) delete process.env.OPENCODE_CONFIG_ISOLATED
    else process.env.OPENCODE_CONFIG_ISOLATED = previous
  }
}

for (const [value, expected] of [
  [undefined, undefined],
  ["false", false],
  ["true", true],
] as const) {
  test(`isolated: strict optional boolean ${value}`, () =>
    withValue(value, async () => {
      expect(await Effect.runPromise(Env.configIsolated)).toBe(expected)
      const options = await Effect.runPromise(ServerProcess.configOptions)
      expect(options.isolated).toBe(expected)
      expect(Schema.decodeUnknownSync(ServerOptions)({ config: options }).config?.isolated).toBe(expected)
    }))
}

for (const value of ["", "TRUE", "1", "yes", "false ", "SECRET_SENTINEL"]) {
  test(`isolated: invalid value fails without disclosure ${value.length}`, () =>
    withValue(value, async () => {
      const result = await Effect.runPromise(Env.configIsolated.pipe(Effect.exit))
      expect(Exit.isFailure(result)).toBe(true)
      expect(JSON.stringify(result)).not.toContain("SECRET_SENTINEL")
    }))
}

for (const [value, args] of [
  ["true", {}],
  ["true", { standalone: false }],
  ["true", { server: "https://must-not-connect.invalid" }],
  ["true", { server: "https://must-not-connect.invalid", standalone: true }],
  [undefined, { server: "https://must-not-connect.invalid", standalone: true }],
  ["false", { server: "https://must-not-connect.invalid", standalone: true }],
  ...["", "TRUE", "1", "yes", "false ", "SECRET_SENTINEL"].flatMap((value) =>
    [{}, { standalone: true }, { server: "https://must-not-connect.invalid" }].map((args) => [value, args] as const),
  ),
] as const) {
  test(`isolated: reject invalid or unowned mode before service/child/HTTP ${JSON.stringify(args)} ${value?.length ?? "unset"}`, () =>
    withValue(value, async () => {
      const calls: string[] = []
      const refuse = (name: string) => () =>
        Effect.sync(() => {
          calls.push(name)
          throw new Error(name)
        })
      const spies = [
        spyOn(ServiceConfig, "read").mockImplementation(refuse("read")),
        spyOn(ServiceConfig, "options").mockImplementation(refuse("options")),
        spyOn(Standalone, "start").mockImplementation(refuse("standalone")),
        spyOn(Service, "ensure").mockImplementation(refuse("ensure")),
        spyOn(Service, "discover").mockImplementation(refuse("discover")),
        // The promise client owns global fetch; intercept its external boundary, not resolution logic.
        spyOn(globalThis, "fetch").mockImplementation(
          Object.assign(
            async () => {
              calls.push("HTTP")
              throw new Error("HTTP")
            },
            {
              preconnect: () => {
                calls.push("HTTP preconnect")
                throw new Error("HTTP preconnect")
              },
            },
          ),
        ),
      ]
      try {
        const result = await run(ServerConnection.resolve(args).pipe(Effect.exit))
        expect(Exit.isFailure(result)).toBe(true)
        expect(String(result)).toContain(
          value === "true"
            ? "--standalone"
            : value === undefined || value === "false"
              ? "--server and --standalone"
              : "OPENCODE_CONFIG_ISOLATED",
        )
        expect(String(result)).not.toContain("SECRET_SENTINEL")
        expect(calls).toEqual([])
      } finally {
        spies.forEach((spy) => spy.mockRestore())
      }
    }))
}

for (const value of [undefined, "false"]) {
  test(`isolated: default explicit remote path is unchanged ${value}`, () =>
    withValue(value, async () => {
      const calls: string[] = []
      // This is the external HTTP boundary used by the real promise client, never a listener.
      const fetch = spyOn(globalThis, "fetch").mockImplementation(
        Object.assign(
          async () => {
            calls.push("HTTP")
            return Response.json({ version: OPENCODE_VERSION, pid: 1, urls: [] })
          },
          {
            preconnect: () => {
              throw new Error("unexpected preconnect")
            },
          },
        ),
      )
      const read = spyOn(ServiceConfig, "read").mockImplementation(() =>
        Effect.die(new Error("unexpected service read")),
      )
      try {
        const result = await run(ServerConnection.resolve({ server: "https://fixture.invalid" }))
        expect(result.endpoint.url).toBe("https://fixture.invalid")
        expect(result.service).toBeUndefined()
        expect(calls).toEqual(["HTTP"])
        expect(read).not.toHaveBeenCalled()
      } finally {
        fetch.mockRestore()
        read.mockRestore()
      }
    }))

  test(`isolated: default managed service path is unchanged ${value}`, () =>
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
            return { file: "fixture-registration", command: ["never-execute"], version: undefined, env: undefined }
          }),
        ),
        spyOn(Service, "ensure").mockImplementation(() =>
          Effect.sync(() => {
            calls.push("ensure")
            return { url: "http://fake.invalid", auth: undefined }
          }),
        ),
        spyOn(Standalone, "start").mockImplementation(() => Effect.die(new Error("unexpected standalone"))),
      ]
      try {
        const result = await run(ServerConnection.resolve())
        expect(result.endpoint).toEqual({ url: "http://fake.invalid", auth: undefined })
        expect(result.service).toBeDefined()
        expect(calls).toEqual(["read", "options", "ensure"])
      } finally {
        spies.forEach((spy) => spy.mockRestore())
      }
    }))
}

for (const value of [undefined, "false", "true"]) {
  test(`isolated: explicit standalone preserves path ${value}`, () =>
    withValue(value, async () => {
      const endpoint = {
        url: "http://fake.invalid",
        auth: { type: "basic" as const, username: "fixture", password: "not-a-secret" },
        pid: ProcessId(0),
        exited: Effect.never,
      }
      const start = spyOn(Standalone, "start").mockImplementation(() => Effect.succeed(endpoint))
      try {
        expect((await run(ServerConnection.resolve({ standalone: true }))).endpoint).toBe(endpoint)
        expect(start).toHaveBeenCalledTimes(1)
      } finally {
        start.mockRestore()
      }
    }))
}
