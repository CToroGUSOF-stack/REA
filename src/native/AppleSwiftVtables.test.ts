import { describe, expect, it } from "vitest";

import { objcSwiftMetadataSchema } from "../domain/native/objcSwiftMetadata.js";
import { pushDispatchCoverage } from "./AppleDispatchCoverage.js";
import { decodeSwiftClassVtables } from "./AppleSwiftVtables.js";
import { decodeSwiftDispatchFacets } from "./AppleSwiftDispatchFacets.js";
import type { DispatchRecordBudget } from "./AppleSwiftDispatchFacets.js";
import { issue } from "./AppleDispatchDecodeFacts.js";

describe("Swift vtable coverage facts: unresolved Swift dispatch slots", () => {
  it("returns a located issue for an emitted unresolved async slot", () => {
    const result = objcSwiftMetadataSchema.parse({ db_save_result: null });
    const values = new Map<bigint, number>([
      [0x200n, 0x80000010], // class descriptor with a vtable
      [0x22cn, 0], // table offset
      [0x230n, 1], // slot count
      [0x21cn, 1], // descriptor positive words
      [0x234n, 0x40], // async method flag
    ]);
    const facts = decodeSwiftClassVtables({
      entries: [0x100n],
      result,
      readers: {
        u32: (address) => values.get(address) ?? 0,
        relative: (address) =>
          address === 0x100n ? 0x200n : address === 0x208n ? 0x300n : 0x400n,
        string: () => "Widget",
        location: (address) => ({
          address: `0x${address.toString(16)}`,
          file_offset: Number(address),
        }),
        evidence: (address, description) => [
          {
            kind: "binary_metadata",
            description,
            location: {
              address: `0x${address.toString(16)}`,
              file_offset: Number(address),
            },
            artifact_path: "/fixture",
            artifact_sha256: "a".repeat(64),
          },
        ],
        executable: () => false,
        admit: () => true,
      },
    });

    expect(result.swift_dispatch_slots[0]?.decode.status).toBe("partial");
    expect(facts).toMatchObject({
      facet: "swift_class_vtable_descriptors",
      exhaustive: false,
      issues: [{ code: "vtable_implementation_unresolved", location: "0x234" }],
    });

    pushDispatchCoverage({
      result,
      failures: [],
      categoryIssues: [],
      examined: 0,
      categoriesExamined: 0,
      truncated: false,
      objcListScanTruncated: false,
      objcClassListScanTruncated: false,
      fixups: {
        kind: "none",
        formats: [],
        failures: [],
        issues: [],
        decode: (_address, raw) => ({ kind: "rebase", target: raw }),
        examined: 0,
        decoded: 0,
        unreadRebaseBytes: 0,
      },
      swift: {
        facet: "swift_conformances_static_witness_slots",
        examined: 0,
        decoded: 0,
        exhaustive: true,
        issues: [],
      },
      vtables: facts,
    });

    expect(
      result.coverage.find(
        ({ facet }) => facet === "swift_class_vtable_descriptors",
      ),
    ).toMatchObject({
      status: "partial",
      reason: expect.stringContaining("0x234"),
    });
  });

  it("returns a located issue for an emitted unresolved witness slot", () => {
    const result = objcSwiftMetadataSchema.parse({ db_save_result: null });
    const values = new Map<bigint, number>([
      [0x20cn, 0], // simple, unconditional conformance
      [0x500n, 3], // protocol descriptor kind
      [0x50cn, 0], // signature count
      [0x510n, 1], // witness requirement count
      [0x2b0n, 16], // nominal type descriptor kind
      [0x518n, 1], // function witness requirement
    ]);
    const budget: DispatchRecordBudget = {
      truncated: false,
      isFull: () => false,
      markTruncated: () => {
        budget.truncated = true;
      },
      admit: () => true,
    };
    const facts = decodeSwiftDispatchFacets({
      sections: [{ name: "__swift5_proto", address: 0x100n, size: 4 }],
      segments: [],
      readers: {
        u32: (address) => values.get(address) ?? 0,
        pointer: (address) => (address === 0x380n ? 0x200n : 0x900n),
        string: (address) => (address === 0x600n ? "Proto" : "Widget"),
        location: (address) => ({
          address: `0x${address.toString(16)}`,
          file_offset: Number(address),
        }),
        evidence: (address, description) => [
          {
            kind: "binary_metadata",
            description,
            location: {
              address: `0x${address.toString(16)}`,
              file_offset: Number(address),
            },
            artifact_path: "/fixture",
            artifact_sha256: "a".repeat(64),
          },
        ],
        offset: (address) => Number(address),
      },
      relative: (field) =>
        new Map<bigint, bigint>([
          [0x100n, 0x200n],
          [0x200n, 0x500n],
          [0x508n, 0x600n],
          [0x204n, 0x2b0n],
          [0x2b8n, 0x700n],
          [0x208n, 0x380n],
        ]).get(field) ?? 0n,
      budget,
      result,
    });

    expect(result.swift_dispatch_slots[0]?.decode.status).toBe("partial");
    expect(facts).toMatchObject({
      facet: "swift_conformances_static_witness_slots",
      exhaustive: false,
      issues: [{ code: "witness_slot_unresolved", location: "0x388" }],
    });
  });
});

const emptyNameConformance = (stringReader: (address: bigint) => string) => {
  const result = objcSwiftMetadataSchema.parse({ db_save_result: null });
  const values = new Map<bigint, number>([
    [0x20cn, 0],
    [0x500n, 3],
    [0x50cn, 0],
    [0x510n, 1],
    [0x2b0n, 16],
    [0x518n, 1],
    [0x24cn, 0],
    [0x520n, 3],
    [0x52cn, 0],
    [0x530n, 0],
    [0x2c0n, 16],
  ]);
  const budget: DispatchRecordBudget = {
    truncated: false,
    isFull: () => false,
    markTruncated: () => {
      budget.truncated = true;
    },
    admit: () => true,
  };
  const facts = decodeSwiftDispatchFacets({
    sections: [{ name: "__swift5_proto", address: 0x100n, size: 8 }],
    segments: [],
    readers: {
      u32: (address) => values.get(address) ?? 0,
      pointer: (address) => {
        if (address === 0x380n) return 0x200n;
        if (address === 0x390n) return 0x240n;
        return 0x900n;
      },
      string: (address) => {
        if (address === 0x610n) return "ValidProto";
        if (address === 0x710n) return "ValidWidget";
        return stringReader(address);
      },
      location: (address) => ({
        address: `0x${address.toString(16)}`,
        file_offset: Number(address),
      }),
      evidence: (address, description) => [
        {
          kind: "binary_metadata",
          description,
          location: {
            address: `0x${address.toString(16)}`,
            file_offset: Number(address),
          },
          artifact_path: "/fixture",
          artifact_sha256: "a".repeat(64),
        },
      ],
      offset: (address) => Number(address),
    },
    relative: (field) =>
      new Map<bigint, bigint>([
        [0x100n, 0x200n],
        [0x200n, 0x500n],
        [0x508n, 0x600n],
        [0x204n, 0x2b0n],
        [0x2b8n, 0x700n],
        [0x208n, 0x380n],
        [0x104n, 0x240n],
        [0x240n, 0x520n],
        [0x528n, 0x610n],
        [0x244n, 0x2c0n],
        [0x2c8n, 0x710n],
        [0x248n, 0x390n],
      ]).get(field) ?? 0n,
    budget,
    result,
  });
  return { result, facts };
};

describe("Swift conformance coverage facts: empty name handling", () => {
  it.each([
    ["protocol", (address: bigint) => (address === 0x600n ? "" : "Widget")],
    ["type", (address: bigint) => (address === 0x600n ? "Proto" : "")],
  ])(
    "rejects an empty Swift %s name and preserves coverage and later siblings",
    (_kind, reader) => {
      const { result, facts } = emptyNameConformance(reader);
      expect(
        result.swift_conformances.map(
          ({ protocol_name, type_name }) => `${type_name}: ${protocol_name}`,
        ),
      ).toEqual(["ValidWidget: ValidProto"]);
      expect(objcSwiftMetadataSchema.parse(result)).toBeDefined();
      expect(facts).toMatchObject({
        facet: "swift_conformances_static_witness_slots",
        examined: 2,
        decoded: 1,
        exhaustive: false,
        issues: [{ code: "conformance_decode_failed", location: "0x100" }],
      });
    },
  );
});

describe("Swift vtable coverage facts: unsupported pointer fixup coverage", () => {
  it("marks pointer fixup coverage partial for an unsupported format with no decoded pointers", () => {
    const result = objcSwiftMetadataSchema.parse({ db_save_result: null });
    pushDispatchCoverage({
      result,
      failures: [],
      categoryIssues: [],
      examined: 0,
      categoriesExamined: 0,
      truncated: false,
      objcListScanTruncated: false,
      objcClassListScanTruncated: false,
      fixups: {
        kind: "chained",
        formats: ["format-99"],
        failures: ["Unsupported chained pointer format 99"],
        issues: [
          issue(
            "pointer_fixups",
            "unsupported_pointer_format",
            "Unsupported chained pointer format 99",
            "0x1000",
          ),
        ],
        decode: () => ({
          kind: "unsupported",
          reason: "Unsupported chained pointer format 99",
        }),
        examined: 0,
        decoded: 0,
        unreadRebaseBytes: 0,
      },
      swift: {
        facet: "swift_conformances_static_witness_slots",
        examined: 0,
        decoded: 0,
        exhaustive: true,
        issues: [],
      },
      vtables: {
        facet: "swift_class_vtable_descriptors",
        examined: 0,
        decoded: 0,
        exhaustive: true,
        issues: [],
      },
    });

    expect(
      result.coverage.find(({ facet }) => facet === "pointer_fixups"),
    ).toMatchObject({
      status: "partial",
      examined: 0,
      decoded: 0,
      reason: expect.stringContaining("0x1000"),
    });
  });
});
