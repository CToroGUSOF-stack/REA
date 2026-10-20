import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  inspectPeResourcesInputSchema,
  peResourcesSchema,
} from "../../domain/native/peResources.js";
import { parsePeResources } from "./PeResourceParser.js";
import { peResourceFixture } from "./PeResources.fixture.js";

const parse = async (resources: Parameters<typeof peResourceFixture>[1]) =>
  parseBytes(peResourceFixture(false, resources).bytes);

const parseBytes = async (bytes: Buffer) => {
  const result = peResourcesSchema.parse(
    await parsePeResources(
      bytes,
      {
        path: "/fixtures/example.exe",
        bytes: bytes.length,
        sha256: createHash("sha256").update(bytes).digest("hex"),
      },
      inspectPeResourcesInputSchema.parse({ path: "/fixtures/example.exe" }),
    ),
  );
  return { bytes, result };
};

/** Sixteen counted UTF-16LE strings, as the resource compiler lays out one block. */
const stringBlock = (strings: Record<number, string>): Buffer =>
  Buffer.concat(
    Array.from({ length: 16 }, (_, slot) => {
      const encoded = Buffer.from(strings[slot] ?? "", "utf16le");
      const length = Buffer.alloc(2);
      length.writeUInt16LE(encoded.length / 2);
      return Buffer.concat([length, encoded]);
    }),
  );

const pad4 = (bytes: Buffer): Buffer =>
  Buffer.concat([bytes, Buffer.alloc((4 - (bytes.length % 4)) % 4)]);

/**
 * One VS_VERSIONINFO node: header, key, aligned value, aligned children. Text
 * values are counted in UTF-16 units and binary values in bytes.
 */
const versionNode = (
  key: string,
  type: 0 | 1,
  value: Buffer,
  children: readonly Buffer[] = [],
): Buffer => {
  const valueLength = type === 1 ? value.length / 2 : value.length;
  const head = Buffer.alloc(6);
  const keyBytes = Buffer.from(`${key}\0`, "utf16le");
  const body = Buffer.concat([
    pad4(Buffer.concat([head, keyBytes])),
    children.length > 0 ? pad4(value) : value,
    ...children.map((child, index) =>
      index < children.length - 1 ? pad4(child) : child,
    ),
  ]);
  body.writeUInt16LE(body.length, 0);
  body.writeUInt16LE(valueLength, 2);
  body.writeUInt16LE(type, 4);
  return body;
};

const text = (key: string, value: string): Buffer =>
  versionNode(key, 1, Buffer.from(`${value}\0`, "utf16le"));

const fixedFileInfo = (): Buffer => {
  const bytes = Buffer.alloc(52);
  bytes.writeUInt32LE(0xfeef04bd, 0);
  bytes.writeUInt32LE(0x00010000, 4);
  bytes.writeUInt32LE((6 << 16) | 6, 8);
  bytes.writeUInt32LE((3 << 16) | 0, 12);
  bytes.writeUInt32LE((6 << 16) | 6, 16);
  bytes.writeUInt32LE((3 << 16) | 1, 20);
  bytes.writeUInt32LE(0x3f, 24);
  bytes.writeUInt32LE(0x0, 28);
  bytes.writeUInt32LE(0x40004, 32);
  bytes.writeUInt32LE(1, 36);
  return bytes;
};

const versionInfo = (): Buffer => {
  const translation = Buffer.alloc(4);
  translation.writeUInt16LE(1046, 0);
  translation.writeUInt16LE(1252, 2);
  return versionNode("VS_VERSION_INFO", 0, fixedFileInfo(), [
    versionNode("StringFileInfo", 1, Buffer.alloc(0), [
      versionNode("041604E4", 1, Buffer.alloc(0), [
        text("CompanyName", "DATASUS"),
        text("FileVersion", "6.6.3.0"),
        text("Comments", ""),
      ]),
    ]),
    versionNode("VarFileInfo", 1, Buffer.alloc(0), [
      versionNode("Translation", 0, translation),
    ]),
  ]);
};

describe("PE string table payloads", () => {
  it("expands a block into sixteen string IDs and keeps empty slots", async () => {
    const block = stringBlock({ 0: "Ready", 3: "Disk full", 15: "Ação" });
    const { bytes, result } = await parse([
      { type: 6, name: 7, language: 1046, payload: block },
    ]);
    const [table] = result.string_tables;
    expect(table).toMatchObject({
      resource_index: 0,
      status: "decoded",
      block_id: 7,
      first_string_id: 96,
      trailing_bytes: 0,
      reason: null,
    });
    expect(table?.strings.map(({ id, value }) => [id, value])).toEqual(
      Array.from({ length: 16 }, (_, slot) => [
        96 + slot,
        ({ 0: "Ready", 3: "Disk full", 15: "Ação" } as Record<number, string>)[
          slot
        ] ?? "",
      ]),
    );
    const disk = table?.strings[3];
    if (disk === undefined) throw new Error("Missing string 99");
    expect(
      bytes.toString(
        "utf16le",
        disk.location.offset + 2,
        disk.location.offset + disk.location.bytes,
      ),
    ).toBe("Disk full");
  });

  it("reports trailing padding without rejecting the block", async () => {
    const { result } = await parse([
      {
        type: 6,
        name: 1,
        language: 1033,
        payload: Buffer.concat([stringBlock({ 1: "x" }), Buffer.alloc(6)]),
      },
    ]);
    expect(result.string_tables[0]).toMatchObject({
      status: "decoded",
      first_string_id: 0,
      trailing_bytes: 6,
    });
  });

  it.each([
    [
      "truncated block",
      { type: 6, name: 2, payload: stringBlock({ 0: "a" }).subarray(0, 20) },
      "RT_STRING block ends before string",
    ],
    [
      "string past the block end",
      {
        type: 6,
        name: 2,
        payload: (() => {
          const block = stringBlock({});
          block.writeUInt16LE(400, 0);
          return block;
        })(),
      },
      "runs past the end of its block",
    ],
    [
      "named block",
      { type: 6, name: "STRINGS", payload: stringBlock({}) },
      "numeric ID from 1 to 4096",
    ],
  ] as const)(
    "reports a %s as malformed while the inventory succeeds",
    async (_case, resource, reason) => {
      const { result } = await parse([
        { ...resource, language: 1033 },
        { type: 10, name: 1, language: 1033, payload: Buffer.from("data") },
      ]);
      expect(result.coverage.resources).toBe(2);
      expect(result.string_tables).toHaveLength(1);
      expect(result.string_tables[0]).toMatchObject({
        status: "malformed",
        first_string_id: null,
        strings: [],
        trailing_bytes: null,
      });
      expect(result.string_tables[0]?.reason).toContain(reason);
    },
  );
});

describe("PE version payloads", () => {
  it("decodes fixed file info, string tables and translations", async () => {
    const { bytes, result } = await parse([
      { type: 16, name: 1, language: 1046, payload: versionInfo() },
    ]);
    const [info] = result.version_infos;
    expect(info).toMatchObject({
      resource_index: 0,
      status: "decoded",
      reason: null,
      fixed_file_info: {
        file_version: "6.6.3.0",
        product_version: "6.6.3.1",
        struct_version: 0x00010000,
        file_flags_mask: 0x3f,
        file_os: 0x40004,
        file_type: 1,
      },
      translations: [{ language: 1046, code_page: 1252 }],
    });
    expect(info?.string_file_info).toHaveLength(1);
    const [table] = info?.string_file_info ?? [];
    expect(table).toMatchObject({
      key: "041604E4",
      language: 0x0416,
      code_page: 0x04e4,
    });
    expect(table?.strings.map(({ key, value }) => [key, value])).toEqual([
      ["CompanyName", "DATASUS"],
      ["FileVersion", "6.6.3.0"],
      ["Comments", ""],
    ]);
    const fixed = info?.fixed_file_info;
    if (fixed === null || fixed === undefined) throw new Error("No fixed info");
    expect(bytes.readUInt32LE(fixed.location.offset)).toBe(0xfeef04bd);
    expect(fixed.location.bytes).toBe(52);
  });

  it("projects repeated payload ranges as independent version records", async () => {
    const payload = versionInfo();
    const fixture = peResourceFixture(false, [
      { type: 16, name: 1, language: 1033, payload },
      { type: 16, name: 2, language: 1033, payload },
    ]);
    const [first, second] = fixture.dataOffsets;
    if (first === undefined || second === undefined)
      throw new Error("Missing version data entries");
    // Point the second data entry at the first payload's RVA and size.
    fixture.bytes.copy(fixture.bytes, second, first, first + 8);
    const { result } = await parseBytes(fixture.bytes);
    expect(
      result.version_infos.map(({ resource_index }) => resource_index),
    ).toEqual([0, 1]);
    expect(result.version_infos[0]).toEqual({
      ...result.version_infos[1],
      resource_index: 0,
    });
    expect(result.version_infos[0]?.string_file_info).not.toBe(
      result.version_infos[1]?.string_file_info,
    );
    expect(result.version_infos[0]?.string_file_info[0]?.strings).not.toBe(
      result.version_infos[1]?.string_file_info[0]?.strings,
    );
  });

  it("reads text values whose length a resource compiler counted in bytes", async () => {
    const companyName = text("CompanyName", "Embarcadero");
    // Count the value in bytes instead of UTF-16 units, as some compilers do.
    companyName.writeUInt16LE(("Embarcadero".length + 1) * 2, 2);
    const payload = versionNode("VS_VERSION_INFO", 0, fixedFileInfo(), [
      versionNode("StringFileInfo", 1, Buffer.alloc(0), [
        versionNode("040904E4", 1, Buffer.alloc(0), [companyName]),
      ]),
    ]);
    const { result } = await parse([
      { type: 16, name: 1, language: 1033, payload },
    ]);
    expect(result.version_infos[0]).toMatchObject({ status: "decoded" });
    expect(
      result.version_infos[0]?.string_file_info[0]?.strings[0]?.value,
    ).toBe("Embarcadero");
  });

  it("rejects text lengths larger than the containing block", async () => {
    const companyName = text("CompanyName", "Embarcadero");
    companyName.writeUInt16LE(0xffff, 2);
    const payload = versionNode("VS_VERSION_INFO", 0, fixedFileInfo(), [
      versionNode("StringFileInfo", 1, Buffer.alloc(0), [
        versionNode("040904E4", 1, Buffer.alloc(0), [companyName]),
      ]),
    ]);
    const { result } = await parse([
      { type: 16, name: 1, language: 1033, payload },
    ]);
    expect(result.version_infos[0]).toMatchObject({
      status: "malformed",
      reason: expect.stringContaining("leaves its block"),
    });
  });

  it.each([
    [
      "bad signature",
      (payload: Buffer) => payload.writeUInt32LE(0, 40),
      "signature",
    ],
    [
      "wrong root key",
      (payload: Buffer) => payload.write("X", 6, "utf16le"),
      "VS_VERSION_INFO",
    ],
    [
      "length past the payload",
      (payload: Buffer) => payload.writeUInt16LE(payload.length + 8, 0),
      "length leaves its parent",
    ],
  ] as const)(
    "reports a %s as malformed while the inventory succeeds",
    async (_case, corrupt, reason) => {
      const payload = versionInfo();
      corrupt(payload);
      const { result } = await parse([
        { type: 16, name: 1, language: 1046, payload },
      ]);
      expect(result.coverage.resources).toBe(1);
      expect(result.version_infos[0]).toMatchObject({
        status: "malformed",
        fixed_file_info: null,
        string_file_info: [],
        translations: [],
      });
      expect(result.version_infos[0]?.reason).toContain(reason);
    },
  );
});
