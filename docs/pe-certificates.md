# PE Authenticode certificate tables

`inspect_pe_certificates` / `inspect-pe-certificates` answers whether one
selected local PE32/PE32+ image declares an `IMAGE_DIRECTORY_ENTRY_SECURITY`
table, which `WIN_CERTIFICATE` entries that table stores, and which PKCS#7
signer and X.509 fields those entries carry. It reads the file without
executing it and does not require a Windows SDK, catalog file, or disassembler.

```bash
rea inspect-pe-certificates /absolute/path/to/application.exe --json
```

The CLI resolves relative paths against the caller's working directory. MCP
requires an absolute filesystem path and preserves that exact selection:

```json
{
  "name": "inspect_pe_certificates",
  "arguments": { "path": "/artifacts/application.exe" }
}
```

## Observations

The inline Evidence result contains the artifact path, SHA-256, and byte length.
`table` is the file-offset security directory, or `null` when the directory is
absent or zero. Each `entries[]` item reports `WIN_CERTIFICATE` length,
revision, type, and the payload SHA-256.

For `WIN_CERTIFICATE` type 2 (PKCS#7 signedData) `pkcs7` contains digest
algorithm OIDs, embedded X.509 serial/issuer/subject/validity fields, and
signer identifier facts. Other certificate types keep `pkcs7` null.

A missing table is observed absence of that directory. It is not proof the
image is unsigned in every catalog or overlay sense.

## Limits and failures

The selected file is limited to 64 MiB by default (512 MiB maximum). At most
eight `WIN_CERTIFICATE` entries are examined by default. Malformed PE headers,
truncated certificate entries, and PKCS#7 that is not structurally signedData
fail without partial success.

This workflow does not verify signatures, certificate chains, timestamps, or
Authenticode digest coverage of image bytes.
