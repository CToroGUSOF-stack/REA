# Rust binary dependency metadata

`inspect_rust_binary` / `inspect-rust-binary` answers which crate names,
versions, sources, and dependency edges are embedded by cargo-auditable in one
selected local executable, library, or WebAssembly module. It reads the file
without running it and requires no Rust installation, active binary target,
Hopper, Ghidra, or IDA.

```bash
rea inspect-rust-binary /absolute/path/to/application --json
```

The CLI resolves relative paths against the caller's working directory. MCP
requires an absolute filesystem path and preserves that exact selection:

```json
{
  "name": "inspect_rust_binary",
  "arguments": { "path": "/artifacts/application" }
}
```

## Observations

The inline Evidence result contains the artifact path, SHA-256, byte length,
container format, architecture, word size, and byte order. When a `.dep-v0`
section is present, `auditable_metadata` contains:

- `section_name`, `.dep-v0` for ELF, PE, and WebAssembly or `__DATA,.dep-v0`
  for thin Mach-O;
- `file_offset` and `section_bytes`, the exact file range of the compressed
  section; for WebAssembly, the custom-section payload after its name;
- `compressed_bytes` and `uncompressed_bytes`;
- `format_version`, the embedded integer, or `null` when the field is omitted;
- `packages`, in the section's original order, with `name`, `version`, `source`,
  `kind`, `dependencies`, and `root`;
- `root_package_index`, the single package marked `root`, or `null` when none is marked;
- `dependency_edges`, pairs of package indices in package-then-dependency order;
- `cyclic_dependency_indices`, sorted unique indices that participate in a cycle.

An omitted `kind` stays `null`. The embedded format treats that omission as
runtime, and that default is not stored in the section. An omitted dependency
list is an empty array. An omitted `root` flag is false.

`rustc_commit` is present only when a `/rustc/<40-hex>/` path is found in
read-only data, or in the data section of a WebAssembly module. Its
`evidence_kind` is `inferred`. The hash is not a claim that that compiler
produced the binary. Several distinct hashes leave a single commit unknown.

## WebAssembly modules

cargo-auditable stores the same zlib-compressed JSON in a WebAssembly custom
section named `.dep-v0`. For a version 1 core module, such as
`wasm32-unknown-unknown` or `wasm32-wasip1` output, the reader walks the
section framing without validating, instantiating, or executing the module.
The report's `format` and `architecture` are `wasm` and its `byte_order` is
`little`. `bits` is `null`: WebAssembly declares no container word size, and
memory address types are not inspected. The Evidence subject format is
`file`, as for `inspect_wasm_artifact`.

A section or custom-section name that extends past its enclosing range, a size
that is not a 32-bit LEB128 integer, a custom-section name that is not UTF-8, a
second `.dep-v0` section, or a second data section is malformed. WebAssembly
components, such as `wasm32-wasip2` output, embed core modules. Like universal
Mach-O containers, they are unsupported rather than inspected through one
selected module.

## Limits and failures

The selected file is limited to 256 MiB. A dependency section is limited to 1
MiB compressed. Inflated JSON is limited to the smaller of 8 MiB and 64 times
the compressed size. The complete report is limited to 8 MiB. Empty sections,
truncated or trailing zlib bytes, invalid JSON, unknown fields, dependency
indices outside the package list, more than one root package, and compressed
dependency sections are typed failures. A cycle is reported and is not walked.

A missing section returns success with `auditable_metadata: null` and a
limitation. Absence of `.dep-v0` does not mean the binary has no dependencies.
Unknown embedded format revisions are retained in `format_version` and
interpreted using the highest known preceding revision, following the
cargo-auditable schema. The output includes a limitation that identifies this
fallback and notes that the particular revision has not been independently
verified. An omitted revision remains `null` and follows revision 0 semantics.
Embedded names and versions are file content. They do not authenticate the
packages or the compiler.

Universal Mach-O containers are unsupported. Select a thin slice first. ELF,
PE, thin Mach-O, and WebAssembly core modules are the supported containers.

Package and dependency counts are checked against the minimum required JSON
representation before graph allocation or schema cloning. Oversized graphs
report the output byte budget; the compiler-path capacity reports
`maximum_rustc_hashes` in hashes, independently of byte limits.

WebAssembly section framing is walked synchronously, and the format sets no
section count, so a module with more than 65,536 sections is refused with a
`cpu` resource constraint that reports `maximum_wasm_sections`. Producer output
holds a few dozen sections.
