import { createHash } from "node:crypto";
import { open, stat, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { createTestTempDirectory } from "../../../tests/fixtures/temporaryDirectory.js";
import { byteEntropySchema } from "../../domain/native/byteEntropy.js";
import { ByteEntropyService } from "./ByteEntropyService.js";

it("keeps whole-file identity and entropy while selecting unaligned blocks and a partial tail", async () => {
  const root = await createTestTempDirectory("rea-entropy-");
  const path = join(root, "bytes");
  const bytes = Buffer.from(Array.from({ length: 1024 }, (_, i) => i % 256));
  await writeFile(path, bytes);
  const result = await new ByteEntropyService().inspect({
    path,
    offset: 3,
    length: 513,
    block_size: 256,
  });
  if (!result.ok) throw result.error;
  const report = byteEntropySchema.parse(result.value.normalized_result);
  expect(report.blocks).toEqual([
    { offset: 3, length: 256, entropy: 8 },
    { offset: 259, length: 256, entropy: 8 },
    { offset: 515, length: 1, entropy: 0 },
  ]);
  expect(report.file_entropy).toBe(8);
  expect(report.artifact).toEqual({
    path,
    bytes: 1024,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  });
  expect(result.value.subject?.digest.sha256).toBe(report.artifact.sha256);
  expect(result.value.confidence).toBe("observed");
});

it("rejects missing files, non-files and windows beyond EOF, but accepts empty windows", async () => {
  const root = await createTestTempDirectory("rea-entropy-input-");
  const path = join(root, "empty");
  await writeFile(path, "");
  const service = new ByteEntropyService();
  for (const input of [
    { path: join(root, "missing") },
    { path: root },
    { path, offset: 1 },
    { path, length: 1 },
    { path: "relative" },
  ]) {
    const result = await service.inspect(input);
    expect(result).toMatchObject({
      ok: false,
      error: { _tag: "AnalysisInputError" },
    });
  }
  const result = await service.inspect({ path });
  if (!result.ok) throw result.error;
  expect(result.value.normalized_result).toMatchObject({
    blocks: [],
    runs: [],
    file_entropy: 0,
    window: { offset: 0, length: 0 },
  });
  expect(
    byteEntropySchema.parse(result.value.normalized_result).limitations,
  ).toContainEqual(expect.stringContaining("reports a size of 0"));
});

it.skipIf(process.platform !== "linux")(
  "marks a generated /proc file that reports size 0 as not shown empty",
  async () => {
    const result = await new ByteEntropyService().inspect({
      path: "/proc/version",
    });
    if (!result.ok) throw result.error;
    const report = byteEntropySchema.parse(result.value.normalized_result);
    expect(report.artifact.bytes).toBe(0);
    expect(report.limitations).toContainEqual(
      expect.stringContaining("Linux /proc entries"),
    );
  },
);

it("adds no zero-size limitation to a file with content", async () => {
  const root = await createTestTempDirectory("rea-entropy-nonempty-");
  const path = join(root, "one");
  await writeFile(path, "x");
  const result = await new ByteEntropyService().inspect({ path });
  if (!result.ok) throw result.error;
  expect(
    byteEntropySchema
      .parse(result.value.normalized_result)
      .limitations.join(" "),
  ).not.toContain("reports a size of 0");
});

it("honors cancellation before and during streaming", async () => {
  const root = await createTestTempDirectory("rea-entropy-cancel-");
  const path = join(root, "bytes");
  await writeFile(path, Buffer.alloc(1024 * 1024));
  const service = new ByteEntropyService();
  expect(
    await service.inspect({ path }, { signal: AbortSignal.abort() }),
  ).toMatchObject({ ok: false, error: { _tag: "AnalysisCancelledError" } });
  const controller = new AbortController();
  let reads = 0;
  const streaming = new ByteEntropyService({
    stat,
    open: async (...args) => {
      const file = await open(...args);
      const read = file.read.bind(file);
      vi.spyOn(file, "read").mockImplementation(async (...readArgs) => {
        const result = await read(...readArgs);
        reads += 1;
        controller.abort();
        return result;
      });
      return file;
    },
  });
  const pending = streaming.inspect(
    { path, block_size: 256 },
    { signal: controller.signal },
  );
  expect(await pending).toMatchObject({
    ok: false,
    error: { _tag: "AnalysisCancelledError" },
  });
  expect(reads).toBe(1);
});

it("reports a changed artifact when its parent directory moves during streaming", async () => {
  const root = await createTestTempDirectory("rea-entropy-moved-");
  const path = join(root, "bytes");
  await writeFile(path, Buffer.alloc(512));
  let moved = false;
  const service = new ByteEntropyService({
    stat,
    open: async (...args) => {
      const file = await open(...args);
      const read = file.read.bind(file);
      vi.spyOn(file, "read").mockImplementation(async (...readArgs) => {
        const result = await read(...readArgs);
        if (!moved) {
          moved = true;
          await rename(root, `${root}-moved`);
        }
        return result;
      });
      return file;
    },
  });
  try {
    expect(await service.inspect({ path, block_size: 256 })).toMatchObject({
      ok: false,
      error: { _tag: "AnalysisArtifactChangedError" },
    });
  } finally {
    if (moved) await rename(`${root}-moved`, root);
  }
});
