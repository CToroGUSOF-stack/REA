# Electron feature-path experiment

This is a small, unregistered prototype pending a maintainer scope decision under
[CONTRIBUTING.md](../../CONTRIBUTING.md#fail-closed-integration). It is not included
in REA's runtime build or package and adds no CLI/MCP tools or target injection.
The supplied fixture explicitly installs probes around its own selected main IPC
handler and `fs.promises.writeFile` calls. Do not inject it into another app.

The analyst question is: **which selected file-write call occurred in the async
context of this main IPC invocation?** Existing Electron capture records action,
IPC and lifecycle events, but does not recover renderer/preload execution or a
handler-to-filesystem relation. This experiment tests that missing relation before
proposing a production authority or instrumentation contract.

## Observed boundary

`createRecorder` validates an explicit channel/path selection and caller-selected
retention estimate budget. `wrapHandler` and `wrapFileWriter` return tagged
success/failure results; the caller owns installation and the bound operations.
There are no global patches to restore and no process ownership in the recorder.
The existing REA capture provider owns the fixture's launch and cleanup.

Each invocation and file effect receives a recorder-local ID. Ordered start and
return/settlement records retain literal channels, selected paths and the raw
wrapper-installation call site. They do not capture payloads or the environment.
Sync results, original Promise objects, exceptions, receivers and arguments pass
through. Unselected operations and FileHandle/URL/Buffer inputs pass through
without being claimed as observed file effects.

`within_handler` is `true` while observed handler lifetime is active, `false`
after observed completion (or outside a handler), and `null` when completion
cannot be observed. Every handler terminal event updates lifetime before recording:
primitive returns, throws and Promise settlement report `false`; unobservable
completion reports `null`. File-effect events report the parent handler's lifetime
when that effect is observed. Detached callbacks retain their invocation lineage; that
lineage does not prove a business cause or a UI association. Opaque thenables
are not inspected. Promise completion observation can read constructor/species
and affect unhandled-rejection reporting. Failed observer installation preserves
the original return and marks lifetime unknown.

Coverage counts examined, retained and dropped probe events. Selection strings,
fixed metadata and escaped-string expansion participate in admission before event
serialization/copying. The budget is a conservative retention estimate, not a
process-memory ceiling. A snapshot allocates another bounded copy. Missing events
remain truncation; `selected-probes-retained` never claims all application activity.
The experimental JSON contract validates selection, counts and ordering. It is
not authenticated canonical REA Evidence and must not be imported as such.

## Run

Use the repository's pinned Node/npm and existing locked dependencies. Build the
normal runtime first, then supply your own Electron executable. The verifier
accepts only a new absolute output directory and preserves its artifacts.

```sh
nvm use
npm run build:cached
node --test experiments/electron-feature-path/*.test.mjs
node experiments/electron-feature-path/verify-mcp.mjs \
  --electron /absolute/path/to/Electron \
  --output /absolute/path/to/new-prototype-output
```

The verifier uses actual stdio MCP discovery and validates advertised input/output
schemas and canonical Evidence. It analyzes the fixture, traces the literal IPC
channel, captures clicks through `capture_electron_scenario`, and compares the
experimental trace to the resulting file. A second explicit IPC round trip and a
visible UI barrier flush observations after the export handler; no sleep is used
to infer that relation. Source bytes are checked before and after the run.
Before capture in every mode, `evidence-checkpoint.json` is exported and validated
to contain the complete static parent. A checkpoint failure prevents capture.
Successful capture also exports `evidence-bundle.json`; the two exports retain
separate stage-named raw requests/replies. Thus a settled failed capture still
leaves the complete parent available after server shutdown.
Complete canonical Evidence is exported alongside the raw MCP replies; the
experimental trace has a separate digest and authority. Cancellation requests
are relayed to the observed JSON-RPC request ID. The MCP server suppresses the
cancelled request's final reply, so cancellation uses an independent
`close_binary` admission-drain acknowledgement followed by REA's process ownership
check against the fixture's explicit run-token receipt and a prelaunch identity
baseline. Neither a missing reply nor a drain acknowledgement alone proves
cleanup. Unrelated unreadable processes remain explicit in the ownership result.
Only that dedicated ownership token is recorded, not the ambient environment.
Uncertain cleanup keeps the verifier and server owned rather than force-closing
them. Cleanup facts are parsed and latched before reply serialization or artifact
writes. Diagnostic failures are collected independently and cannot bypass final
owner retention; a referenced timer keeps Node alive even when resource handles
have disappeared. Malformed cleanup replies remain unknown. Bounded stderr includes
complete/truncated accounting.

Exercise real cancellation after the fixture acknowledges readiness with another
new directory and `--cancel-after-ready`. The verifier deliberately waits on a
missing button, sends cancellation, and checks the independent cleanup proof;
it never manufactures a canonical tool error or a partial capture reply.

For an equivalent output-producing baseline with the experiment's wrappers
disabled, run with a different new output directory and `--baseline`. Both modes
still use REA's existing Electron main hook. Compare completed tasks rather than
record counts; this baseline does not offer the new invocation/effect relation.

## Verification and integration decision

Tests cover concurrent same-channel invocations, return/error identity, opaque
completion, detached work, selected boundaries, metadata/event retention and
malformed experimental data. The real fixture must establish source identity,
actual IPC/file behavior, coexistence with the existing main hook, and verified
owned-process cleanup. Node-only callback tests do not establish Electron behavior.

Before production integration, maintainers must decide the selected targets,
probe-installation mechanism, effects, compatibility, resource and cleanup
verification. Renderer/preload source locations and execution, cross-process
invocation identity, native calls and arbitrary application compatibility remain
unimplemented. Matching static channel names or temporal adjacency does not
bridge these gaps. A production result would need per-edge Evidence authority and
unknowns rather than presenting this partial relation as a complete execution path.

## Local verification record

### Current macOS verification — 2026-10-15

Executed PR head `c05c082bf700f719c4efd5f60f103bf45b293292` in a fresh
worktree, preserving the existing checkout. This head includes the main merge;
the historical results below do not establish validation of that merge.
Follow-up changes only add this record, an independent CI experiment-test step,
and a workflow/gate regression. No recorder, fixture, verifier or production
runtime source changed. Related tracking: [#4027](https://github.com/morluto/rea/issues/4027).
That tracker and green CI do not resolve the pending maintainer scope decision.
The latest human review's integration hold remains in effect.

Host: macOS 27.0.1 (26A434), arm64; pinned Node 24.18.0 / npm 11.16.0;
installed MCP client/server 2.3.1, REA 6.5.0. Explicitly selected the already
present Electron 44.4.3 executable at
`/var/folders/77/dq5wbzgs7kj56bkcbcjwz3t40000gn/T/rea-feature-path-electron-zfcbaaxv/Electron.app/Contents/MacOS/Electron`.
Its resolved executable SHA-256 is
`52591945c62a357a093d45bab2a13ef95636e5e16c40ea960e428123ce58365e`.
No Electron download or host security-setting change was performed.

Executed commands and observed results:

- `npm ci` and `npm run build:cached`: passed with the locked dependencies;
  initial build had three cache misses. Existing bundler warnings remain.
- `node --test experiments/electron-feature-path/*.test.mjs`: **61 passed,
  0 failed, 0 skipped** across all five files, including the actual SDK,
  retention subprocess and failed-capture/checkpoint regressions.
- `npm run test:focused -- tests/boundary/mcp/electronMcp.test.ts tests/boundary/browser/electronActiveHook.test.ts tests/boundary/cli/electronCli.test.ts`:
  **16 passed, 0 failed, 0 skipped** in three files.
- `node experiments/electron-feature-path/verify-mcp.mjs --electron ABS --output NEW_ABS_DIR`,
  with `--baseline`, no mode flag (prototype), and `--cancel-after-ready`:
  all three passed. Repeated all three with a local SDK-message recorder;
  every invocation used a fresh absolute output directory/profile.
- `node scripts/rea.mjs capture-electron-scenario ABS_REQUEST_JSON --json`:
  actual compiled CLI baseline and prototype both passed with the same
  export/flush/barrier actions and separate fresh directories.
- CI regression plus related workflow/selection/cache/report/gate files:
  **254 passed, 0 failed, 0 skipped** in five files. The new regression first
  failed on the missing experiment step; it also checks that failed, cancelled,
  skipped or absent build jobs cannot pass the required gate.
- `npm run check` and `npm run verify:test-discovery`: passed (1,321 Vitest
  files discovered exactly once). Existing repository lint warnings remain.
- `npm run docs:check`: passed, including all five README consistency cases.
- `npm pack --dry-run --ignore-scripts --json`: 1,678 package files,
  **zero experimental files**. Runtime import/build/catalog inspection found
  no experiment registration or inclusion; the catalog contains 207 existing tools.

Normal MCP runs preserved and parsed the complete static parent in the
pre-capture checkpoint and the final four-record Evidence bundle. Both stage
exports and all five tool requests/replies remain separately available. The
baseline wrote exactly `fixture exported\n` with zero experimental events;
the prototype wrote the same bytes with four events, one matching invocation /
fulfilled file-effect ID, the selected output path and `within_handler: true`.
The observed authority remains fixture async context; UI causality remains unknown.
Nine source digests and the executable digest were checked unchanged, including
after the CLI runs. CLI Evidence, actions, IPC invocation and file effects were
independently parsed and checked, with `terminated-owned-process` cleanup.

Cancellation observed the fixture's ready receipt, sent cancellation for the
actual request ID, received an independent `close_binary` drain acknowledgement
and verified run-token process absence against the prelaunch baseline:
`cleaned: true`, `signaled: false`. The recorded run retained 14 unrelated
unreadable-process observations rather than declaring them inspected. The capture
reply was suppressed/unavailable; it is not cleanup proof. Cancellation retains
the complete checkpoint, not a fabricated final capture reply or post-drain bundle.
No run required unresolved resource-owner retention.

Completed workflow samples (fresh processes/profiles, prepared build and warm
filesystem; no performance improvement claim):

| Workflow                                  | Elapsed s | Child wait4 CPU s | Sampled family RSS MiB | Request / reply tokenx estimates |
| ----------------------------------------- | --------: | ----------------: | ---------------------: | -------------------------------: |
| Baseline MCP                              |      7.28 |              8.48 |                  1,332 |              See recorded repeat |
| Prototype MCP                             |      7.33 |              8.67 |                  1,437 |              See recorded repeat |
| Baseline MCP, SDK messages recorded       |      6.91 |              8.24 |                  1,405 |                  789 / 1,094,470 |
| Prototype MCP, SDK messages recorded      |      6.11 |              7.64 |                  1,419 |                  786 / 1,094,462 |
| Cancellation proof, SDK messages recorded |      7.11 |              8.54 |                  1,417 |                  728 / 1,063,923 |
| Baseline CLI                              |      2.30 |              2.76 |                    881 |                     278 / 12,873 |
| Prototype CLI                             |      2.87 |              3.03 |                    852 |                     275 / 15,279 |

CPU is child `wait4` user+system, subject to OS descendant/reaping accounting.
Family RSS is summed from `ps` every 30 ms plus process-table-read time; shared
pages can count multiple times and brief children/peaks may be missed. The local
recorder retains parsed SDK JSON values until exit; its overhead is included in
recorded samples. Those values include initialization, the full 207-tool catalog,
notifications, tool calls/replies and cancellation drain, not original wire bytes.
`tokenx` 1.3.0 is a heuristic over their JSON serializations, **not actual model
token usage or billing**. The catalog alone estimates 974,771 tokens. CLI estimates
cover the capture input/Evidence only. No model is called by these workflows;
agent prompt/rendering/reasoning, hosted CI cost, OS-cold execution, warm live
session caching and general instrumentation overhead are unmeasured. Repeats can
benefit from OS caches; brief CI-regression work overlapped some probes. These
samples neither isolate overhead nor establish a speed/memory/token improvement.

Local-only evidence root:
`/Users/jntmtmtm/Documents/Codex/2026-10-15/https-github-com-morluto-rea-pull/outputs/macos-c05c082-20261015/`.
It retains exact command/exit/measurement logs, selections and digests, SDK JSON
messages, raw tool replies, CLI input/output, checkpoints/bundles and
`evidence-audit.json`. Large evidence, profiles, binaries and dependencies are
not committed. CI now runs every experiment `.test.mjs` in a separate uncached
step after `test:prepare` builds its runtime; failure stops the existing build
gate. Ordinary CI installs no Electron. Real-provider verification keeps the
explicit executable prerequisite and the platform/target limitations above.

### Historical macOS verification — before the main merge

On macOS arm64, Node 24.18.0 and caller-supplied Electron 44.4.3, the real compiled
CLI and stdio MCP fixture runs produced the expected file and reported
`terminated-owned-process`. The cancellation lane independently drained the
session and verified token-owned process absence, preserving unrelated unreadable
process observations. The earlier cancellation experiment exposed the SDK's
suppressed-reply behavior; it is not counted as a passing cleanup test.

The prototype has 61 passing Node tests, including actual installed MCP SDK
cancellation, ENOSPC/diagnostic failure injection, a real Node retention subprocess,
and real stdio MCP failed-capture/checkpoint-collision regressions. The latter use
a self-authored non-executable file and do not launch Electron; their POSIX
permission checks are skipped on Windows. Existing Electron CLI/MCP/main-hook
boundary tests contribute another 16 passing cases. These results do not establish other Electron versions,
Linux/Windows, arbitrary applications, renderer/preload execution or native calls.

The following completed-task measurements use the same fixture and five normal
MCP calls (static summary, channel trace, checkpoint export, capture, final bundle
export), including full catalog discovery/schema validation. The baseline disables only the experimental
wrappers and produces the same file; it cannot report the new relation.

| Mode                      | Elapsed s | Reported CPU s | Sampled family RSS MiB | Payload token estimate |
| ------------------------- | --------: | -------------: | ---------------------: | ---------------------: |
| Baseline, first measured  |      6.28 |           7.18 |                  1,348 |              1,097,108 |
| Prototype, first measured |      5.27 |           6.77 |                  1,289 |              1,092,963 |
| Baseline, repeated        |      5.28 |           6.74 |                  1,261 |              1,105,396 |
| Prototype, repeated       |      5.22 |           6.77 |                  1,274 |              1,105,385 |
| Cancellation proof        |      5.22 |           6.65 |                  1,316 |             Unmeasured |

Before the checkpoint/retention fixes, four-call normal runs of the same completed
fixture workflow measured 4.82–5.82 s elapsed, 6.15–6.80 s reported CPU,
1,316–1,589 MiB sampled family RSS and 1,092,789–1,092,802 estimated payload tokens.
The checkpoint adds an export; metadata and host conditions also vary, so these
samples do not isolate its overhead. Cancellation includes a separate drain request.

Every run starts fresh Node/MCP/Electron processes and a new profile. Repeats may
benefit from OS file caches; true OS-cold and warm-result-cache runs are unmeasured.
CPU is `wait4` user+system accounting; descendant accumulation depends on OS/reaping.
Memory is the sampled sum of family RSS at about 30 ms plus process-table-read
time: shared pages count in each process and short peaks can be missed. It is an
estimate, not a unique-resident or hard-limit measurement. `tokenx` estimates
serialized catalog plus request/reply payloads, including both tool-result
representations. The unchanged catalog alone estimates 974,705 tokens; actual
agent rendering/billed tokens are unmeasured and the verifier uses no model.
Single samples and differing capture metadata do not establish a speed, memory,
or token improvement or a general upper bound on instrumentation overhead.
