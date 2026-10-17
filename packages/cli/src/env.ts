import { Config, Effect } from "effect"

// Every environment variable the CLI reads, in one place. Consumers yield
// these instead of touching process.env so the full surface stays visible,
// typed, and redacted where secret.

// The opencode server password: sent by clients connecting to an explicit
// --server, and adopted by a manually run or standalone server. The legacy
// name is still honored.
export const password = Config.Redacted("OPENCODE_PASSWORD").pipe(
  Config.orElse(() => Config.Redacted("OPENCODE_SERVER_PASSWORD")),
  Config.withDefault(undefined),
)

/** Deliberately stricter than legacy truthy flags; never echo an invalid value. */
export const configIsolated = Effect.suspend(() => {
  const value = process.env.OPENCODE_CONFIG_ISOLATED
  if (value === undefined) return Effect.succeed(undefined)
  if (value === "true") return Effect.succeed(true)
  if (value === "false") return Effect.succeed(false)
  return Effect.fail(new Error("OPENCODE_CONFIG_ISOLATED must be true or false"))
})

/** Ownership must be explicit at the command boundary, not inferred from a new child or saved settings. */
export const requireConfigOwner = Effect.fnUntraced(function* (owned: boolean) {
  if ((yield* configIsolated) && !owned)
    return yield* Effect.fail(
      new Error("Isolated config requires explicit --standalone without --server; unsupported for this command"),
    )
})

export function session() {
  return Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] =>
        entry[1] !== undefined && entry[0] !== "OPENCODE_PASSWORD" && entry[0] !== "OPENCODE_SERVER_PASSWORD",
    ),
  )
}

export * as Env from "./env"
