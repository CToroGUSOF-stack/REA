import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import * as signatureOwner from "./ManagedMemberInspectorCore.js";
import { decodeCustomAttributeArguments } from "./ManagedCustomAttributeArguments.js";
import { managedDecodeBudget } from "./ManagedDecodeBudget.js";
import { readTypeMemberListFacts } from "./ManagedTypeMemberLists.js";
import { inspectManagedArtifactBytes } from "./ManagedArtifactInspector.js";
import {
  metadataRowOffset,
  readManagedMetadataLayout,
} from "./ManagedMetadataLayout.js";
import { readManagedPeLayout } from "./ManagedPeReader.js";
import {
  buildManagedMemberPointerFixture,
  managedPeFixtureTarget,
} from "./ManagedPe.fixture.js";

const inspect = (
  options: Parameters<typeof buildManagedMemberPointerFixture>[0] = {},
) => {
  const bytes = buildManagedMemberPointerFixture(options);
  return inspectManagedArtifactBytes(bytes, managedPeFixtureTarget(bytes));
};
const attributes = (
  options: Parameters<typeof buildManagedMemberPointerFixture>[0] = {},
) => inspect(options).attributes[0];

describe("signature-owned custom attribute arguments", () => {
  it.each([false, true])(
    "decodes a %s MemberRef constructor without a name allow-list",
    (attributeMemberRef) => {
      const result = attributes({ attributeMemberRef });
      expect(result).toMatchObject({
        constructor_token: attributeMemberRef ? "0x0a000001" : "0x06000001",
        decoded_fixed_string: null,
        arguments: {
          status: "decoded",
          reason: null,
          fixed: [
            {
              type: "string",
              value: "fixture",
              blob_offset: 2,
              status: "decoded",
              reason: null,
            },
          ],
          named: [],
        },
      });
      expect(result?.value_sha256).toBe(
        createHash("sha256")
          .update(Buffer.from("010007666978747572650000", "hex"))
          .digest("hex"),
      );
    },
  );
  it("retains named field/property, a null string and an empty string distinctly", () => {
    const attributeValue = Buffer.from(
      "0100ff0002005402034b65790153080843617061636974792a000000",
      "hex",
    );
    expect(
      attributes({
        constructorSignature: Buffer.from([0x20, 2, 1, 14, 14]),
        attributeValue,
      })?.arguments,
    ).toMatchObject({
      status: "decoded",
      fixed: [
        { value: null, blob_offset: 2 },
        { value: "", blob_offset: 3 },
      ],
      named: [
        { kind: "property", name: "Key", type: "bool", value: true },
        { kind: "field", name: "Capacity", type: "int32", value: 42 },
      ],
    });
  });
  it("decodes System.Type, a boxed string, a string array and a null array", () => {
    const type = Buffer.from("System.String, Example.Assembly", "utf8");
    const attributeValue = Buffer.concat([
      Buffer.from([1, 0, type.length]),
      type,
      Buffer.from("0e05626f786564020000000161ffffffffff0000", "hex"),
    ]);
    expect(
      attributes({
        typeReferenceName: "Type",
        constructorSignature: Buffer.from([
          0x20, 4, 1, 0x12, 5, 28, 0x1d, 14, 0x1d, 14,
        ]),
        attributeValue,
      })?.arguments,
    ).toMatchObject({
      status: "decoded",
      fixed: [
        { type: "System.Type", value: type.toString() },
        { type: "object", value: { type: "string", value: "boxed" } },
        { type: "string[]", value: ["a", null] },
        { type: "string[]", value: null },
      ],
    });
  });
  it("preserves exact signed and unsigned 64-bit values", () => {
    const values = Buffer.alloc(16);
    values.writeBigInt64LE(-9223372036854775808n);
    values.writeBigUInt64LE(18446744073709551615n, 8);
    expect(
      attributes({
        constructorSignature: Buffer.from([0x20, 2, 1, 10, 11]),
        attributeValue: Buffer.concat([
          Buffer.from([1, 0]),
          values,
          Buffer.from([0, 0]),
        ]),
      })?.arguments,
    ).toMatchObject({
      status: "decoded",
      fixed: [
        { type: "int64", value: "-9223372036854775808" },
        { type: "uint64", value: "18446744073709551615" },
      ],
    });
  });
  it("derives a local enum width from its owned value__ field", () => {
    expect(
      attributes({
        methodPointers: null,
        fieldPointers: null,
        enumUnderlyingType: 5,
        constructorSignature: Buffer.from([0x20, 1, 1, 0x11, 12]),
        attributeValue: Buffer.from([1, 0, 2, 0, 0]),
      })?.arguments,
    ).toMatchObject({
      status: "decoded",
      fixed: [
        {
          type: "Fixture.B",
          value: 2,
          enum_underlying_type: { value: "uint8", kind: "derived" },
        },
      ],
    });
  });
  it("stops at an external enum without reading another assembly or guessing a width", () => {
    const result = attributes({
      constructorSignature: Buffer.from([0x20, 3, 1, 14, 0x11, 5, 14]),
      attributeValue: Buffer.from("010001780201790000", "hex"),
    });
    expect(result?.arguments).toMatchObject({
      status: "partial",
      reason: expect.stringContaining(
        "referenced assemblies were not inspected",
      ),
      fixed: [
        { type: "string", value: "x", status: "decoded" },
        { value: null, status: "unknown", blob_offset: 4 },
        { value: null, status: "unknown", blob_offset: null },
      ],
    });
  });
});

describe("custom attribute enum ownership uncertainty", () => {
  it.each([0, 4])(
    "does not derive an enum width from invalid FieldList start %s",
    (start) => {
      const bytes = buildManagedMemberPointerFixture({
        methodPointers: null,
        fieldPointers: null,
        enumUnderlyingType: 5,
        constructorSignature: Buffer.from([0x20, 1, 1, 0x11, 12]),
        attributeValue: Buffer.from([1, 0, 2, 0, 0]),
      });
      const pe = readManagedPeLayout(bytes);
      if (pe.cli === null) throw new Error("fixture has no CLI header");
      const { rva, size } = pe.cli.metadata;
      const layout = readManagedMetadataLayout(
        bytes,
        pe.rvaToOffset(rva, size, "cli.metadata"),
        size,
      );
      const offset =
        metadataRowOffset(layout, 2, 3) +
        4 +
        2 * layout.stringIndexSize +
        layout.codedIndexSize("TypeDefOrRef");
      if (layout.tableIndexSize(4) === 2) bytes.writeUInt16LE(start, offset);
      else bytes.writeUInt32LE(start, offset);
      const result = inspectManagedArtifactBytes(
        bytes,
        managedPeFixtureTarget(bytes),
      );
      expect(result.attributes[0]?.arguments).toMatchObject({
        status: "unsupported",
        reason: expect.stringContaining("no proven owned value__ field"),
        fixed: [{ status: "unknown", value: null, enum_underlying_type: null }],
      });
      expect(result.coverage.issues).toContainEqual(
        expect.objectContaining({
          code: "invalid-row",
          detail: expect.stringContaining(
            `TypeDef FieldList start ${String(start)}`,
          ),
        }),
      );
    },
  );
});

describe("attribute argument boundaries and unknowns", () => {
  it.each([
    ["prolog", "0200000000", "invalid custom attribute prolog"],
    ["truncation", "01000561", "truncated"],
    ["UTF-8", "010001ff0000", "invalid UTF-8"],
    ["trailing bytes", "010000000001", "trailing"],
  ])(
    "reports malformed %s without losing raw identity",
    (_name, hex, reason) => {
      const result = attributes({ attributeValue: Buffer.from(hex, "hex") });
      expect(result).toMatchObject({
        value_length: hex.length / 2,
        value_sha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
        arguments: {
          status: "malformed",
          reason: expect.stringContaining(reason),
        },
      });
    },
  );
  it("rejects an impossible array count before allocation", () => {
    expect(
      attributes({
        constructorSignature: Buffer.from([0x20, 1, 1, 0x1d, 14]),
        attributeValue: Buffer.from("0100feffffff0000", "hex"),
      })?.arguments,
    ).toMatchObject({
      status: "malformed",
      reason: expect.stringContaining("array count"),
    });
  });
  it("keeps generic and unresolved constructor shapes explicit", () => {
    expect(
      attributes({ constructorSignature: Buffer.from([0x20, 1, 1, 0x13, 0]) })
        ?.arguments,
    ).toMatchObject({ status: "unsupported", fixed: [{ status: "unknown" }] });
  });
  it.each([
    [2, "01", true],
    [3, "41d8", "\ud841"],
    [4, "80", -128],
    [5, "ff", 255],
    [6, "0080", -32768],
    [7, "ffff", 65535],
    [8, "00000080", -2147483648],
    [9, "ffffffff", 4294967295],
    [12, "0000c03f", 1.5],
    [13, "000000000000f03f", 1],
    [12, "0000807f", "Infinity"],
  ])(
    "retains element %i at its exact numeric boundary",
    (element, hex, value) => {
      const result = attributes({
        constructorSignature: Buffer.from([0x20, 1, 1, Number(element)]),
        attributeValue: Buffer.concat([
          Buffer.from([1, 0]),
          Buffer.from(String(hex), "hex"),
          Buffer.from([0, 0]),
        ]),
      });
      expect(result?.arguments).toMatchObject({
        status: "decoded",
        fixed: [{ value }],
      });
    },
  );
  it("represents an examined empty attribute compactly", () => {
    expect(
      attributes({
        constructorSignature: Buffer.from([0x20, 0, 1]),
        attributeValue: Buffer.from([1, 0, 0, 0]),
      })?.arguments,
    ).toBeNull();
  });
  it("bounds deeply nested parameter interpretation without overflowing the call stack", () => {
    const constructorSignature = Buffer.concat([
      Buffer.from([0x20, 1, 1]),
      Buffer.alloc(600, 0x1d),
      Buffer.from([14]),
    ]);
    expect(attributes({ constructorSignature })?.arguments).toMatchObject({
      status: "unsupported",
      reason: expect.stringContaining("nesting capacity"),
    });
  });
});

const serializedString = (value: string): Buffer => {
  const bytes = Buffer.from(value);
  const prefix =
    bytes.length < 128
      ? Buffer.from([bytes.length])
      : Buffer.from([0x80 | (bytes.length >> 8), bytes.length & 0xff]);
  return Buffer.concat([prefix, bytes]);
};
const namedEnum = (name: string, value: Buffer): Buffer =>
  Buffer.concat([
    Buffer.from([1, 0, 1, 0, 0x54, 0x55]),
    serializedString(name),
    serializedString("Mode"),
    value,
  ]);
const prepareDecoder = (
  options: Parameters<typeof buildManagedMemberPointerFixture>[0],
) => {
  const bytes = buildManagedMemberPointerFixture(options);
  const pe = readManagedPeLayout(bytes);
  if (pe.cli === null) throw new Error("fixture has no CLI header");
  const { rva, size } = pe.cli.metadata;
  const layout = readManagedMetadataLayout(
    bytes,
    pe.rvaToOffset(rva, size, "cli.metadata"),
    size,
  );
  const facts = readTypeMemberListFacts(bytes, layout);
  return {
    layout,
    decode: (value: Buffer, constructor = "0x06000001") =>
      decodeCustomAttributeArguments(bytes, layout, value, constructor, facts),
  };
};

describe("attribute enum review regressions", () => {
  it("admits an enum field signature before parsing while retaining the constructor budget", () => {
    const { layout, decode } = prepareDecoder({
      fieldPointers: null,
      methodPointers: null,
      enumUnderlyingType: 5,
      constructorSignature: Buffer.from([0x20, 1, 1, 0x11, 12]),
      types: [
        { name: "A" },
        {
          name: "B",
          enumUnderlyingType: 5,
          fieldSignature: Buffer.concat([
            Buffer.from([6]),
            Buffer.alloc(30000, 0x1d),
            Buffer.from([5]),
          ]),
        },
      ],
    });
    managedDecodeBudget(layout).reserve(60 * 1024 * 1024, null);
    expect(() => decode(Buffer.from([1, 0, 2, 0, 0]))).toThrow(
      /representation budget/u,
    );
  });
  it("reuses enum-name and owned-field indexes for repeated attributes within one budget", () => {
    const names = Array.from(
      { length: 128 },
      (_, index) => `Enum${index}_${"x".repeat(150)}`,
    );
    const { layout, decode } = prepareDecoder({
      fieldPointers: null,
      methodPointers: null,
      typeReferenceName: "Enum",
      constructorSignature: Buffer.from([0x20, 0, 1]),
      types: names.map((name) => ({ name, enumUnderlyingType: 5 })),
    });
    managedDecodeBudget(layout).reserve(60 * 1024 * 1024, null);
    for (let index = 0; index < 64; index++) {
      const name = `Fixture.${names[127 - index]}`;
      expect(decode(namedEnum(name, Buffer.from([42])))).toMatchObject({
        status: "decoded",
        named: [{ value: 42, type: name }],
      });
    }
  });
});

describe("attribute representation and constructor reuse", () => {
  it("charges every retained box across repeated attributes before collecting the inventory", () => {
    const { layout, decode } = prepareDecoder({
      constructorSignature: Buffer.from([0x20, 1, 1, 28]),
    });
    managedDecodeBudget(layout).reserve(63 * 1024 * 1024, null);
    const value = Buffer.concat([
      Buffer.from([1, 0]),
      Buffer.alloc(399, 0x51),
      Buffer.from([5, 42, 0, 0]),
    ]);
    const retained = [];
    expect(() => {
      for (let index = 0; index < 32; index++) {
        const result = decode(value);
        expect(result.status).toBe("decoded");
        retained.push(result);
      }
    }).toThrow(/representation budget/u);
    expect(retained.length).toBeGreaterThan(0);

    const scalar = prepareDecoder({
      constructorSignature: Buffer.from([0x20, 1, 1, 5]),
    });
    managedDecodeBudget(scalar.layout).reserve(63 * 1024 * 1024, null);
    for (let index = 0; index < 32; index++)
      expect(scalar.decode(Buffer.from([1, 0, 42, 0, 0]))).toMatchObject({
        status: "decoded",
        fixed: [{ value: 42 }],
      });
  });

  it.each([false, true])(
    "parses a shared constructor once, including parser failure %s",
    (malformed) => {
      const constructorSignature = Buffer.concat([
        Buffer.from([0x20, 1, 1]),
        Buffer.alloc(12000, 0x1d),
        malformed ? Buffer.alloc(0) : Buffer.from([14]),
      ]);
      const first = prepareDecoder({ constructorSignature });
      const second = prepareDecoder({ constructorSignature });
      const parse = vi.spyOn(signatureOwner, "methodSignatureTypes");
      try {
        const value = Buffer.from([1, 0, 0, 0]);
        for (let index = 0; index < 64; index++)
          expect(first.decode(value).status).toBe(
            malformed ? "malformed" : "unsupported",
          );
        expect(parse).toHaveBeenCalledTimes(1);
        // Distinct constructor identities and inspections cannot share facts.
        first.decode(value, "0x0a000001");
        expect(parse).toHaveBeenCalledTimes(2);
        second.decode(value);
        expect(parse).toHaveBeenCalledTimes(3);
      } finally {
        parse.mockRestore();
      }
    },
  );

  it("does not release a caller's live reservation after decoding an attribute", () => {
    const { layout, decode } = prepareDecoder({
      constructorSignature: Buffer.from([0x20, 1, 1, 5]),
    });
    const budget = managedDecodeBudget(layout);
    budget.admitTransient(60 * 1024 * 1024, null);
    expect(decode(Buffer.from([1, 0, 42, 0, 0])).status).toBe("decoded");
    expect(() => budget.reserve(8 * 1024 * 1024, null)).toThrow(
      /representation budget/u,
    );
  });
});
describe("serialized enum identities", () => {
  it.each([
    ["Fixture.Outer+Mode", [42], "uint8"],
    ["Fixture.Mode", [42, 0, 0, 0], "int32"],
  ])(
    "resolves serialized enum identity %s independently of a nested name collision",
    (name, value, width) => {
      expect(
        attributes({
          fieldPointers: null,
          methodPointers: null,
          typeReferenceName: "Enum",
          constructorSignature: Buffer.from([0x20, 0, 1]),
          types: [
            { name: "Mode", enumUnderlyingType: 5, enclosingRow: 3 },
            { name: "Outer" },
            { name: "Mode", enumUnderlyingType: 8 },
          ],
          attributeValue: namedEnum(name, Buffer.from(value)),
        })?.arguments,
      ).toMatchObject({
        status: "decoded",
        named: [
          {
            type: name,
            value: 42,
            enum_underlying_type: { value: width, kind: "derived" },
          },
        ],
      });
    },
  );
  it.each(["Fixture.Mode", "Fixture.Mode, Foreign.Assembly"])(
    "does not guess a width for ambiguous or external identity %s",
    (name) => {
      expect(
        attributes({
          fieldPointers: null,
          methodPointers: null,
          typeReferenceName: "Enum",
          constructorSignature: Buffer.from([0x20, 0, 1]),
          types: [
            { name: "Mode", enumUnderlyingType: 5 },
            { name: "Mode", enumUnderlyingType: 8 },
          ],
          attributeValue: namedEnum(name, Buffer.from([42, 0, 0, 0])),
        })?.arguments,
      ).toMatchObject({
        status: "unsupported",
        named: [
          {
            type: name,
            name: "Mode",
            kind: "property",
            status: "unknown",
            value: null,
          },
        ],
      });
    },
  );
  it.each([
    [
      "enum array",
      [0x1d, 0x11, 5],
      Buffer.from([1, 0, 0, 0, 42]),
      "System.Attribute[]",
    ],
    [
      "boxed enum",
      [28],
      Buffer.concat([
        Buffer.from([0x55]),
        serializedString("External.Mode"),
        Buffer.from([42]),
      ]),
      "object",
    ],
  ])(
    "keeps the original start and declared type of an unsupported %s",
    (_label, signature, value, type) => {
      expect(
        attributes({
          constructorSignature: Buffer.from([0x20, 1, 1, ...signature]),
          attributeValue: Buffer.concat([
            Buffer.from([1, 0]),
            value,
            Buffer.from([0, 0]),
          ]),
        })?.arguments,
      ).toMatchObject({
        status: "unsupported",
        fixed: [{ blob_offset: 2, type, status: "unknown" }],
      });
    },
  );
  it("retains a malformed named value and previously decoded named facts", () => {
    expect(
      attributes({
        constructorSignature: Buffer.from([0x20, 0, 1]),
        attributeValue: Buffer.concat([
          Buffer.from([1, 0, 2, 0, 0x53, 2]),
          serializedString("Enabled"),
          Buffer.from([1, 0x54, 8]),
          serializedString("Capacity"),
          Buffer.from([42]),
        ]),
      })?.arguments,
    ).toMatchObject({
      status: "malformed",
      named: [
        { name: "Enabled", kind: "field", value: true, status: "decoded" },
        {
          name: "Capacity",
          kind: "property",
          type: "int32",
          status: "unknown",
          value: null,
          reason: expect.stringContaining("truncated"),
        },
      ],
    });
  });
});

describe("serialized enum name boundaries", () => {
  it.each([
    ["Fixture.Mode\\+Kind", "Mode+Kind", "decoded"],
    ["Fixture.Mode+Kind", "Mode+Kind", "unsupported"],
    ["Fixture.Mode\\,Foreign", "Mode,Foreign", "decoded"],
    ["Fixture.Mode,Foreign", "Mode,Foreign", "unsupported"],
  ])(
    "separates serialized punctuation %s from metadata identifiers",
    (serialized, name, status) => {
      expect(
        attributes({
          fieldPointers: null,
          methodPointers: null,
          typeReferenceName: "Enum",
          types: [{ name, enumUnderlyingType: 5 }, { name: "Other" }],
          constructorSignature: Buffer.from([0x20, 0, 1]),
          attributeValue: namedEnum(serialized, Buffer.from([42])),
        })?.arguments,
      ).toMatchObject({ status });
    },
  );
  it("leaves cyclic nesting unknown", () => {
    expect(
      attributes({
        fieldPointers: null,
        methodPointers: null,
        typeReferenceName: "Enum",
        types: [
          { name: "Mode", enumUnderlyingType: 5, enclosingRow: 3 },
          { name: "Outer", enclosingRow: 2 },
        ],
        constructorSignature: Buffer.from([0x20, 0, 1]),
        attributeValue: namedEnum("Fixture.Outer+Mode", Buffer.from([42])),
      })?.arguments,
    ).toMatchObject({ status: "unsupported" });
  });
});
