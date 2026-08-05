# Runtime support

Ominipg separates a runtime-neutral client/workload core from database-engine
providers. Compatibility therefore has two questions:

1. Can this runtime execute the Ominipg/Oxian session?
2. Can it load and operate the selected PGlite or PostgreSQL provider?

The first is portable by design. The second depends on packages, filesystem,
network, WASM, memory, and platform bindings.

## Support matrix

| Capability                  | Deno                   | Node.js 22+             | Bun                     | Cloudflare Workers          | Browser                          |
| --------------------------- | ---------------------- | ----------------------- | ----------------------- | --------------------------- | -------------------------------- |
| Public client and session   | Supported through JSR  | Supported through npm   | Supported through npm   | Bundle-compatible core      | Bundle-compatible core           |
| Private embedded host       | Supported              | Verified locally/CI     | CI target               | Same-isolate only           | Same-isolate only                |
| Shared `WorkerHost`         | Supported              | Verified                | CI target               | Core-compatible             | Core-compatible                  |
| Ominipg workload handler    | Supported              | Verified                | CI target               | Provider-dependent          | Provider-dependent               |
| `:memory:` PGlite           | Supported provider     | Optional npm peer       | Package-dependent       | WASM/memory/provider limits | Compatible PGlite build required |
| `file://` PGlite            | Provider filesystem    | Supported provider      | Provider-dependent      | Not available               | Not available                    |
| PostgreSQL via `pg`         | Supported npm provider | Optional npm peer       | Package-dependent       | No generic adapter included | No direct TCP driver included    |
| Logical replication sync    | Supported npm provider | Optional npm peer       | Package-dependent       | No generic adapter included | Not supported directly           |
| Client to remote dispatcher | Application bridge     | Host/Hypervisor process | Host/Hypervisor process | Application bridge          | Application bridge               |

“Core-compatible” does not imply that a platform can run every database engine.
For example, a Cloudflare Worker can execute Web Streams and an in-process Oxian
workload, but it has neither a normal filesystem nor a generic node-postgres TCP
environment. Use a platform-specific provider or route the workload to a worker
runtime that owns the database capability.

## Portable core contract

The public Ominipg dependency closure relies on standard facilities:

- ECMAScript modules, promises, maps, sets, and typed arrays;
- `crypto.randomUUID()`;
- `ReadableStream`, `WritableStream`, and `TransformStream`;
- `TextEncoder` and `TextDecoder`;
- `Blob` and `ArrayBuffer`;
- `AbortSignal` and timers.

It deliberately avoids:

- `Deno.*` and Deno filesystem/server APIs;
- Node builtins and `worker_threads`;
- `Bun.*` APIs;
- Cloudflare-specific imports/bindings;
- `new Worker()`, `postMessage()`, and global worker listeners;
- runtime-global environment-variable or memory probing.

The static portability check follows all relative imports reachable from the
public client, session, and compatibility workload entrypoints and rejects those
dependencies.

## Deno

Use JSR entrypoints:

```ts
import { Ominipg } from "jsr:@oxian/ominipg";
import { autoConfigure } from "jsr:@oxian/ominipg/auto";
```

The standard providers use Deno-compatible `npm:` module descriptors. Runtime
permissions still apply to filesystem and network access. The library itself no
longer reads Deno globals to decide how to execute.

## Node.js

The npm package is ESM-only and requires Node.js 22 or newer:

```sh
npm install @oxian/ominipg @electric-sql/pglite
```

The generated package vendors the portable Oxian source used by Ominipg and maps
provider descriptors to npm package names. `@electric-sql/pglite`, `pg`, and
`pg-logical-replication` remain optional peers.

Node verification builds the npm artifact and opens an embedded Ominipg workload
with a provider-backed PostgreSQL-shaped test double. The release workflow also
runs the npm smoke suite.

## Bun

Use the npm package and Web-API-compatible core. Bun verification runs the same
built-artifact portability program as Node in CI. Actual PGlite and `pg` support
also depends on those packages' Bun behavior; applications should run an
integration test for their selected engine and version.

No Bun-specific branch exists in Ominipg.

## Cloudflare Workers

The core client/session/workload graph bundles with a browser platform target
and contains no Node or Deno runtime imports. Two patterns are possible:

- run a same-isolate workload with a provider that supports Cloudflare's WASM,
  memory, storage, and network model;
- keep the Ominipg engine in a compatible Deno/Node/Bun worker and expose an
  authenticated application bridge to an Oxian dispatcher.

Ominipg does not implicitly map Cloudflare bindings to PostgreSQL providers.
Bindings, credentials, and platform objects should stay in
`createOminipgWorkload({ dependencies })` or a metadata-selected runtime
registry; they cannot be serialized in connection options.

Cloudflare's request lifecycle may terminate background work after a response.
The embedding application must own session lifetime appropriately, for example
inside a Durable Object when a long-lived database session is required.

## Browser

The client and private host use standard Web APIs and can bundle for browsers.
In-memory PGlite requires a compatible browser PGlite build. Current Ominipg URL
selection supports `:memory:` and `file://` for PGlite; browser persistence
schemes are not exposed by this release.

A browser cannot pass provider callbacks or platform objects to a remote worker.
It also cannot connect as an Oxian worker requester merely by opening the
Hypervisor's outbound-worker WSS endpoint. Use application ingress with proper
authentication and authorization.

## Provider ownership rules

### Private embedded session

These values stay in the same process and can include callbacks:

```ts
await Ominipg.connect({
  url: ":memory:",
  pgliteProvider: {
    loadPGlite: () => import(customPGliteModule),
  },
  pgliteConfig: customConfiguration,
});
```

### External dispatcher

Prefer runtime-owned workload dependencies:

```ts
createOminipgWorkload({
  dependencies: {
    pgliteProvider: providerForThisRuntime,
    pgProvider: pgProviderForThisRuntime,
  },
});
```

Only declarative values cross the Ominipg session. Supported special values
include dates, big integers, and byte arrays. Functions, cyclic objects, and
class instances fail before dispatch.

## Filesystem and persistence

Ominipg no longer probes the host filesystem to determine whether a PGlite
database or extension exists. It asks PostgreSQL's catalogs which extensions are
active. PGlite itself still owns persistence behavior for `file://` paths.

A failed file-backed PGlite open currently logs a warning and falls back to an
in-memory database. Applications that require durable persistence should verify
the effective environment and treat this warning as an operational failure.

## Verification commands

```sh
deno task check:portability
deno task check
deno task test:deno
deno task build:npm
node scripts/check_node_portability.mjs
bun scripts/check_node_portability.mjs
npx esbuild npm/esm/client/index.js --bundle --platform=browser --format=esm
deno task check:publish
```

The repository workflow runs Deno, Node 22/24, Bun, and browser-platform bundle
jobs. Database integration tests remain separate because they require external
PostgreSQL credentials and runtime-specific infrastructure.
