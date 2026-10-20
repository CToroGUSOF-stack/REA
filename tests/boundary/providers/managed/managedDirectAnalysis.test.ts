import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { createTestTempDirectory } from "../../../fixtures/temporaryDirectory.js";

import { createDirectAnalysis } from "../../../../src/composition/directAnalysis.js";
import { parseEvidence } from "../../../../src/domain/evidence.js";
import {
  buildManagedMemberPointerFixture,
  buildManagedPeFixture,
} from "../../../../src/dotnet/ManagedPe.fixture.js";

const { runProviderAnalysis } = createDirectAnalysis({});

describe("managed direct-analysis path boundary", () => {
  it("returns provider evidence through the shared analysis service", async () => {
    const directory = await createTestTempDirectory("rea-managed-cli-");
    const path = join(directory, "fixture.exe");
    await writeFile(path, buildManagedPeFixture());

    const evidence = parseEvidence(
      await runProviderAnalysis(path, "inspect_managed_artifact", {}),
    );
    expect(evidence).toMatchObject({
      operation: "inspect_managed_artifact",
      provider: { id: "rea-dotnet-static" },
      subject: { local_path: path, format: "pe" },
      normalized_result: {
        classification: { status: "managed", runtime_family: "modern-dotnet" },
        references: [expect.objectContaining({ name: "System.Runtime" })],
      },
    });

    const memberEvidence = parseEvidence(
      await runProviderAnalysis(path, "inspect_managed_members", {}),
    );
    expect(memberEvidence).toMatchObject({
      operation: "inspect_managed_members",
      provider: { id: "rea-dotnet-static" },
      subject: { local_path: path, format: "pe" },
      normalized_result: {
        identity_scope: { token_identity: "build-local" },
        methods: [expect.objectContaining({ token: expect.any(String) })],
      },
    });

    const boundaryEvidence = parseEvidence(
      await runProviderAnalysis(path, "inspect_managed_native_boundaries", {}),
    );
    expect(boundaryEvidence).toMatchObject({
      operation: "inspect_managed_native_boundaries",
      provider: { id: "rea-dotnet-static" },
      subject: { local_path: path, format: "pe" },
      normalized_result: {
        identity_scope: { token_identity: "build-local" },
        pinvoke_imports: [],
      },
    });
  });
});

it("carries decoded attribute arguments and blob identity in authenticated Evidence", async () => {
  const directory = await createTestTempDirectory("rea-managed-arguments-");
  const path = join(directory, "attribute.dll");
  await writeFile(path, buildManagedMemberPointerFixture());
  const evidence = parseEvidence(
    await runProviderAnalysis(path, "inspect_managed_artifact", {}),
  );
  expect(evidence).toMatchObject({
    operation: "inspect_managed_artifact",
    subject: { local_path: path },
    normalized_result: {
      attributes: [
        {
          value_sha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
          arguments: {
            status: "decoded",
            fixed: [{ type: "string", value: "fixture" }],
          },
        },
      ],
    },
  });
});
