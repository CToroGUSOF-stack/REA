import type { PeResources } from "../../domain/native/peResources.js";

type Range = { offset: number; bytes: number };
type Resource = PeResources["resources"][number];
type StringTable = PeResources["string_tables"][number];
type VersionInfo = PeResources["version_infos"][number];
type VersionStrings = VersionInfo["string_file_info"][number];

const RT_STRING = 6;
const RT_VERSION = 16;
const FIXED_FILE_INFO_SIGNATURE = 0xfeef04bd;
const FIXED_FILE_INFO_BYTES = 52;

/** A payload that does not follow its documented layout; it is reported, not fatal. */
class MalformedPayload extends Error {}
const malformed = (message: string): never => {
  throw new MalformedPayload(message);
};

const isResourceType = (resource: Resource, type: number): boolean =>
  resource.type.kind === "id" && resource.type.id === type;

/**
 * A JSON string can need six ASCII bytes per UTF-16 code unit, so reserve the
 * worst case before decoding text into the result.
 */
const textBytes = (utf16Units: number): number => 6 * utf16Units + 256;

/**
 * Expand each RT_STRING block into its sixteen counted UTF-16LE strings.
 * Block N holds string IDs (N - 1) * 16 through (N - 1) * 16 + 15; empty
 * slots are kept so every ID in the block is accounted for.
 */
export const readStringTables = (
  bytes: Buffer,
  resources: PeResources["resources"],
  account: (value: unknown) => void,
  ensureCapacity: (projectedBytes: number) => void,
): PeResources["string_tables"] =>
  resources
    .filter((resource) => isResourceType(resource, RT_STRING))
    .map((resource) => {
      const blockId = resource.name.kind === "id" ? resource.name.id : null;
      const { offset, bytes: size } = resource.payload.location;
      let table: StringTable;
      try {
        const block =
          blockId !== null && blockId >= 1 && blockId <= 4096
            ? blockId
            : malformed(
                "RT_STRING block name is not a numeric ID from 1 to 4096.",
              );
        const first = (block - 1) * 16;
        const ranges: Array<{ offset: number; units: number }> = [];
        let cursor = offset;
        const end = offset + size;
        for (let slot = 0; slot < 16; slot++) {
          if (cursor + 2 > end)
            malformed(`RT_STRING block ends before string ${String(slot)}.`);
          const units = bytes.readUInt16LE(cursor);
          if (cursor + 2 + units * 2 > end)
            malformed(
              `RT_STRING string ${String(slot)} runs past the end of its block.`,
            );
          ranges.push({ offset: cursor, units });
          cursor += 2 + units * 2;
        }
        ensureCapacity(
          16 * 128 +
            ranges.reduce((total, range) => total + textBytes(range.units), 0),
        );
        const strings: StringTable["strings"] = ranges.map(
          ({ offset: stringOffset, units }, slot) => ({
            id: first + slot,
            value: bytes.toString(
              "utf16le",
              stringOffset + 2,
              stringOffset + 2 + units * 2,
            ),
            location: { offset: stringOffset, bytes: 2 + units * 2 },
          }),
        );
        table = {
          resource_index: resource.index,
          status: "decoded",
          block_id: block,
          first_string_id: first,
          strings,
          trailing_bytes: end - cursor,
          reason: null,
        };
      } catch (cause) {
        if (!(cause instanceof MalformedPayload)) throw cause;
        table = {
          resource_index: resource.index,
          status: "malformed",
          block_id: blockId,
          first_string_id: null,
          strings: [],
          trailing_bytes: null,
          reason: cause.message,
        };
      }
      account(table);
      return table;
    });

interface Block {
  readonly location: Range;
  readonly key: string;
  readonly type: number;
  readonly valueLength: number;
  readonly value: Range;
  readonly children: Range;
}

const align4 = (at: number, base: number): number =>
  base + Math.ceil((at - base) / 4) * 4;

/** Read one length-prefixed VS_VERSIONINFO node inside `[at, end)`. */
const readBlock = (
  bytes: Buffer,
  at: number,
  end: number,
  base: number,
): Block => {
  if (at + 6 > end) malformed("Version block header leaves its parent.");
  const length = bytes.readUInt16LE(at);
  if (length < 6 || at + length > end)
    malformed("Version block length leaves its parent.");
  const blockEnd = at + length;
  const valueLength = bytes.readUInt16LE(at + 2);
  const type = bytes.readUInt16LE(at + 4);
  if (type !== 0 && type !== 1) malformed("Version block type is not 0 or 1.");
  let keyEnd = at + 6;
  while (keyEnd + 2 <= blockEnd && bytes.readUInt16LE(keyEnd) !== 0)
    keyEnd += 2;
  if (keyEnd + 2 > blockEnd) malformed("Version block key is not terminated.");
  const key = bytes.toString("utf16le", at + 6, keyEnd);
  const valueAt = Math.min(align4(keyEnd + 2, base), blockEnd);
  // Text values count UTF-16 units and binary values count bytes. Some
  // resource compilers count text in bytes, or leave out the terminator, so a
  // text value is read up to its terminator inside its own block instead.
  const available = blockEnd - valueAt;
  if (type === 1 && valueLength > available)
    malformed(`Version value for ${JSON.stringify(key)} leaves its block.`);
  const declared =
    type === 1 ? Math.min(valueLength * 2, available) : valueLength;
  if (declared > available)
    malformed(`Version value for ${JSON.stringify(key)} leaves its block.`);
  return {
    location: { offset: at, bytes: length },
    key,
    type,
    valueLength,
    value: { offset: valueAt, bytes: declared },
    children: {
      offset: Math.min(align4(valueAt + declared, base), blockEnd),
      bytes: blockEnd - Math.min(align4(valueAt + declared, base), blockEnd),
    },
  };
};

/** Children of one block, skipping the zero padding between them. */
const readChildren = (bytes: Buffer, parent: Block, base: number): Block[] => {
  const children: Block[] = [];
  const end = parent.children.offset + parent.children.bytes;
  let cursor = parent.children.offset;
  while (cursor < end) {
    cursor = align4(cursor, base);
    if (cursor >= end) break;
    if (cursor + 2 > end) malformed("Version child length leaves its parent.");
    if (bytes.readUInt16LE(cursor) === 0) {
      if (bytes.subarray(cursor, end).some((byte) => byte !== 0))
        malformed("Version block has a zero length before nonzero bytes.");
      break;
    }
    const child = readBlock(bytes, cursor, end, base);
    children.push(child);
    cursor = child.location.offset + child.location.bytes;
  }
  return children;
};

const textValue = (bytes: Buffer, value: Range): string => {
  let end = value.offset;
  while (end + 2 <= value.offset + value.bytes && bytes.readUInt16LE(end) !== 0)
    end += 2;
  return bytes.toString("utf16le", value.offset, end);
};

const versionText = (most: number, least: number): string =>
  [most >>> 16, most & 0xffff, least >>> 16, least & 0xffff].join(".");

const readFixedFileInfo = (
  bytes: Buffer,
  value: Range,
): NonNullable<VersionInfo["fixed_file_info"]> => {
  const at = value.offset;
  if (bytes.readUInt32LE(at) !== FIXED_FILE_INFO_SIGNATURE)
    malformed("VS_FIXEDFILEINFO signature is not 0xFEEF04BD.");
  const fileMost = bytes.readUInt32LE(at + 8);
  const fileLeast = bytes.readUInt32LE(at + 12);
  const productMost = bytes.readUInt32LE(at + 16);
  const productLeast = bytes.readUInt32LE(at + 20);
  return {
    location: value,
    struct_version: bytes.readUInt32LE(at + 4),
    file_version: versionText(fileMost, fileLeast),
    product_version: versionText(productMost, productLeast),
    file_version_ms: fileMost,
    file_version_ls: fileLeast,
    product_version_ms: productMost,
    product_version_ls: productLeast,
    file_flags_mask: bytes.readUInt32LE(at + 24),
    file_flags: bytes.readUInt32LE(at + 28),
    file_os: bytes.readUInt32LE(at + 32),
    file_type: bytes.readUInt32LE(at + 36),
    file_subtype: bytes.readUInt32LE(at + 40),
    file_date_ms: bytes.readUInt32LE(at + 44),
    file_date_ls: bytes.readUInt32LE(at + 48),
  };
};

const readStringFileInfo = (
  bytes: Buffer,
  block: Block,
  base: number,
  ensureCapacity: (projectedBytes: number) => void,
): VersionStrings[] =>
  readChildren(bytes, block, base).map((table) => {
    const code = /^[0-9a-fA-F]{8}$/.test(table.key)
      ? Number.parseInt(table.key, 16)
      : null;
    return {
      key: table.key,
      language: code === null ? null : code >>> 16,
      code_page: code === null ? null : code & 0xffff,
      location: table.location,
      strings: readChildren(bytes, table, base).map((entry) => {
        ensureCapacity(textBytes(entry.location.bytes / 2));
        return {
          key: entry.key,
          value: entry.type === 1 ? textValue(bytes, entry.value) : null,
          location: entry.location,
        };
      }),
    };
  });

const readTranslations = (
  bytes: Buffer,
  block: Block,
  base: number,
): VersionInfo["translations"] =>
  readChildren(bytes, block, base)
    .filter((entry) => entry.key === "Translation")
    .flatMap((entry) => {
      if (entry.value.bytes % 4 !== 0)
        malformed(
          "Translation value is not a list of language and code page pairs.",
        );
      return Array.from({ length: entry.value.bytes / 4 }, (_, index) => {
        const at = entry.value.offset + index * 4;
        return {
          language: bytes.readUInt16LE(at),
          code_page: bytes.readUInt16LE(at + 2),
          location: { offset: at, bytes: 4 },
        };
      });
    });

/** Decode VS_VERSIONINFO: the fixed file info, string tables and translations. */
export const readVersionInfos = (
  bytes: Buffer,
  resources: PeResources["resources"],
  account: (value: unknown) => void,
  ensureCapacity: (projectedBytes: number) => void,
): PeResources["version_infos"] => {
  const decodedByRange = new Map<string, VersionInfo>();
  const decode = (resource: Resource): VersionInfo => {
    const { offset, bytes: size } = resource.payload.location;
    let info: VersionInfo;
    try {
      const root = readBlock(bytes, offset, offset + size, offset);
      if (root.key !== "VS_VERSION_INFO")
        malformed("Version root key is not VS_VERSION_INFO.");
      if (root.type !== 0) malformed("Version root value is not binary.");
      if (
        root.valueLength !== 0 &&
        (root.valueLength !== FIXED_FILE_INFO_BYTES ||
          root.value.bytes !== FIXED_FILE_INFO_BYTES)
      )
        malformed("VS_FIXEDFILEINFO is not 52 bytes.");
      const fixed =
        root.valueLength === 0 ? null : readFixedFileInfo(bytes, root.value);
      const stringFileInfo: VersionStrings[] = [];
      const translations: VersionInfo["translations"] = [];
      for (const child of readChildren(bytes, root, offset)) {
        if (child.key === "StringFileInfo")
          stringFileInfo.push(
            ...readStringFileInfo(bytes, child, offset, ensureCapacity),
          );
        else if (child.key === "VarFileInfo")
          translations.push(...readTranslations(bytes, child, offset));
      }
      info = {
        resource_index: resource.index,
        status: "decoded",
        fixed_file_info: fixed,
        string_file_info: stringFileInfo,
        translations,
        reason: null,
      };
    } catch (cause) {
      if (!(cause instanceof MalformedPayload)) throw cause;
      info = {
        resource_index: resource.index,
        status: "malformed",
        fixed_file_info: null,
        string_file_info: [],
        translations: [],
        reason: cause.message,
      };
    }
    return info;
  };
  const clone = (info: VersionInfo, resourceIndex: number): VersionInfo => ({
    ...info,
    resource_index: resourceIndex,
    fixed_file_info:
      info.fixed_file_info === null
        ? null
        : {
            ...info.fixed_file_info,
            location: { ...info.fixed_file_info.location },
          },
    string_file_info: info.string_file_info.map((table) => ({
      ...table,
      location: { ...table.location },
      strings: table.strings.map((string) => ({
        ...string,
        location: { ...string.location },
      })),
    })),
    translations: info.translations.map((translation) => ({
      ...translation,
      location: { ...translation.location },
    })),
  });
  return resources
    .filter((resource) => isResourceType(resource, RT_VERSION))
    .map((resource) => {
      const { offset, bytes: size } = resource.payload.location;
      const key = `${String(offset)}:${String(size)}`;
      let cached = decodedByRange.get(key);
      if (cached === undefined) {
        cached = decode(resource);
        decodedByRange.set(key, cached);
      }
      account({ ...cached, resource_index: resource.index });
      return clone(cached, resource.index);
    });
};
