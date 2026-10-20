import { expect, it } from "vitest";
import {
  parseNativeAotPe,
  NATIVE_AOT_MAX_REPORT_BYTES,
} from "./nativeAotPe.js";
import {
  nativeAotPeHeaderIndirectionFixture,
  nativeAotPeOptionalHeaderFixture,
  nativeAotPeDigest,
} from "../../../tests/fixtures/nativeaotPe.js";
import { createHash } from "node:crypto";

it.each([
  { rva: 0x3f8, admitted: true },
  { rva: 0x3fc, admitted: false },
  { rva: 0x400, admitted: false },
])(
  "admits a header-backed TypeManager pointer only when all eight bytes are mapped ($rva)",
  ({ rva, admitted }) => {
    const bytes = nativeAotPeHeaderIndirectionFixture(rva);
    const result = parseNativeAotPe(
      bytes,
      nativeAotPeDigest(bytes),
      NATIVE_AOT_MAX_REPORT_BYTES,
    );
    expect(result.summary.header_address !== null).toBe(admitted);
    if (!admitted)
      expect(result.summary).toMatchObject({
        status: "not_applicable",
        method_tables: 0,
        reason:
          "No supported ReadyToRun directory signature was found in initialized non-executable PE sections.",
      });
  },
);

it.each([
  { optionalBytes: 56, admitted: false },
  { optionalBytes: 64, admitted: true },
])(
  "reads mapping fields only from the declared optional header ($optionalBytes bytes)",
  ({ optionalBytes, admitted }) => {
    const bytes = nativeAotPeOptionalHeaderFixture(optionalBytes);
    const result = parseNativeAotPe(
      bytes,
      nativeAotPeDigest(bytes),
      NATIVE_AOT_MAX_REPORT_BYTES,
    );
    expect(result.summary.header_address !== null).toBe(admitted);
    if (!admitted)
      expect(result.summary).toMatchObject({
        status: "not_applicable",
        method_tables: 0,
        reason: "PE optional header is too short for image mapping fields",
      });
  },
);
it("accepts a Tiny PE with e_lfanew inside the DOS header", () => {
  const b = Buffer.alloc(0x200);
  b.write("MZ", 0, "latin1");
  b.writeUInt32LE(4, 0x3c); // e_lfanew = 4
  b.write("PE\0\0", 4, "latin1");
  b.writeUInt16LE(0x8664, 8); // machine
  b.writeUInt16LE(1, 10); // 1 section
  b.writeUInt16LE(0xf0, 24); // SizeOfOptionalHeader
  const opt = 28;
  b.writeUInt16LE(0x20b, opt); // PE32+
  b.writeBigUInt64LE(0x140000000n, opt + 24);
  b.writeUInt32LE(0x1000, opt + 56); // SizeOfImage
  b.writeUInt32LE(0x200, opt + 60); // SizeOfHeaders
  const sec = opt + 0xf0;
  b.writeUInt32LE(0x100, sec + 8); // VirtualSize
  b.writeUInt32LE(0x200, sec + 12); // RVA
  b.writeUInt32LE(0x40000040, sec + 36);

  const sha = createHash("sha256").update(b).digest("hex");
  const { summary } = parseNativeAotPe(b, sha, 64 * 1024);

  expect(summary.reason).not.toBe("PE header overlaps the DOS header");
  expect(summary.coverage.basis).toBe("no-rtr-header");
});

it("still rejects e_lfanew below the PE signature floor", () => {
  const b = Buffer.alloc(0x200);
  b.write("MZ", 0, "latin1");
  b.writeUInt32LE(3, 0x3c); // e_lfanew = 3
  const sha = createHash("sha256").update(b).digest("hex");
  const { summary } = parseNativeAotPe(b, sha, 64 * 1024);

  expect(summary.status).toBe("not_applicable");
  expect(summary.coverage.basis).toBe("unsupported-layout");
});
