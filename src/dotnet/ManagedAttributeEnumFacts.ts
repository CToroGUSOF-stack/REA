import { managedDecodeBudget } from "./ManagedDecodeBudget.js";
import {
  metadataCodedToken,
  metadataRowCursor,
  readMetadataString,
} from "./ManagedMetadataHeaps.js";
import type { ManagedMetadataLayout } from "./ManagedMetadataLayout.js";
import { memberDeclaringTypeRowLookup } from "./ManagedMemberOwnership.js";
import {
  ManagedReaderFailure,
  managedFailure,
} from "./ManagedReaderFailure.js";
import type { TypeMemberListFacts } from "./ManagedTypeMemberLists.js";
import { readManagedTypeNesting } from "./ManagedTypeNesting.js";

interface TypeIdentity {
  readonly table: number;
  readonly row: number;
  readonly name: string;
  readonly nestingDepth: number;
}

// Serialized type names escape punctuation in metadata identifiers; '+' only
// separates enclosing types, and an unescaped ',' introduces an assembly scope.
const escapeName = (name: string): string =>
  name.replace(/[\\,+&*[\]]/gu, "\\$&");

/** Inspection-owned indexes, shared across all fixed, boxed and named enums. */
class AttributeEnumFacts {
  readonly widths = new Map<number, number | ManagedReaderFailure>();
  readonly identities = new Map<number, TypeIdentity | ManagedReaderFailure>();
  #names: Map<string, number | null> | undefined;
  #fields: Map<number, number[]> | undefined;
  #nesting: ReturnType<typeof readManagedTypeNesting> | undefined;

  constructor(
    readonly bytes: Buffer,
    readonly layout: ManagedMetadataLayout,
    readonly memberLists: TypeMemberListFacts,
  ) {}

  identity(operand: number, depth = 0): TypeIdentity {
    const cached = this.identities.get(operand);
    if (cached instanceof ManagedReaderFailure) throw cached;
    if (cached !== undefined) {
      if (cached.nestingDepth + depth > 64)
        throw managedFailure(
          "unsupported-signature",
          "custom-attribute.arguments",
          "attribute type nesting exceeds naming capacity",
        );
      return cached;
    }
    const budget = managedDecodeBudget(this.layout);
    budget.reserve(256, null);
    try {
      if (depth >= 64)
        throw managedFailure(
          "unsupported-signature",
          "custom-attribute.arguments",
          "attribute type nesting is cyclic or exceeds naming capacity",
        );
      const token = metadataCodedToken(
        operand,
        2,
        [2, 1, 27],
        this.layout.rowCounts,
      );
      if (token === null)
        throw managedFailure(
          "unsupported-signature",
          "custom-attribute.arguments",
          "unresolved custom attribute parameter type",
        );
      const table = Number.parseInt(token.slice(2, 4), 16);
      const row = Number.parseInt(token.slice(4), 16);
      if (table !== 1 && table !== 2)
        throw managedFailure(
          "unsupported-signature",
          "custom-attribute.arguments",
          "custom attribute TypeSpec is not supported",
        );
      const cursor = metadataRowCursor(this.bytes, this.layout, table, row);
      const flagsOrScope =
        table === 1
          ? cursor.readIndex(this.layout.codedIndexSize("ResolutionScope"))
          : cursor.readUInt32();
      const name = readMetadataString(
        this.bytes,
        this.layout,
        cursor.readIndex(this.layout.stringIndexSize),
        this.layout.strings.size,
      );
      const namespace = readMetadataString(
        this.bytes,
        this.layout,
        cursor.readIndex(this.layout.stringIndexSize),
        this.layout.strings.size,
      );
      let enclosing: number | undefined;
      if (table === 2) {
        this.#nesting ??= readManagedTypeNesting(this.bytes, this.layout, []);
        enclosing = this.#nesting.enclosing.get(row);
        if (
          !this.#nesting.complete ||
          (flagsOrScope & 7) >= 2 !== (enclosing !== undefined)
        )
          throw managedFailure(
            "unsupported-signature",
            "custom-attribute.arguments",
            "local enum enclosing identity is not proven",
          );
      } else if ((flagsOrScope & 3) === 3)
        enclosing = Math.floor(flagsOrScope / 4);
      const parent =
        enclosing === undefined
          ? undefined
          : this.identity(enclosing * 4 + (table === 1 ? 1 : 0), depth + 1);
      const fullName =
        parent === undefined
          ? namespace.length === 0
            ? escapeName(name)
            : `${escapeName(namespace)}.${escapeName(name)}`
          : `${parent.name}+${escapeName(name)}`;
      budget.reserveString(Buffer.byteLength(fullName), cursor.start);
      const identity = {
        table,
        row,
        name: fullName,
        nestingDepth: (parent?.nestingDepth ?? 0) + 1,
      };
      this.identities.set(operand, identity);
      return identity;
    } catch (cause: unknown) {
      if (depth === 0 && cause instanceof ManagedReaderFailure)
        this.identities.set(operand, cause);
      throw cause;
    }
  }

  namedRow(name: string): number | null {
    if (this.#names === undefined) {
      const names = new Map<string, number | null>();
      for (let row = 1; row <= (this.layout.table(2)?.rowCount ?? 0); row++) {
        try {
          const identity = this.identity(row * 4);
          names.set(identity.name, names.has(identity.name) ? null : row);
        } catch (cause: unknown) {
          if (
            !(cause instanceof ManagedReaderFailure) ||
            cause.issue.code === "resource-limit"
          )
            throw cause;
          // Unreadable identities cannot prove that a readable name is unique.
          this.#names = new Map();
          return null;
        }
      }
      this.#names = names;
    }
    return this.#names.get(name) ?? null;
  }

  fields(row: number): readonly number[] {
    if (this.#fields === undefined) {
      const owner = memberDeclaringTypeRowLookup(
        this.bytes,
        this.layout,
        4,
        this.memberLists,
      );
      const fields = new Map<number, number[]>();
      managedDecodeBudget(this.layout).reserve(
        (this.layout.table(4)?.rowCount ?? 0) * 256 + 256,
        null,
      );
      for (
        let field = 1;
        field <= (this.layout.table(4)?.rowCount ?? 0);
        field++
      ) {
        const declaring = owner(field);
        if (declaring === 0) continue;
        const owned = fields.get(declaring);
        if (owned === undefined) fields.set(declaring, [field]);
        else owned.push(field);
      }
      this.#fields = fields;
    }
    return this.#fields.get(row) ?? [];
  }
}

const inspections = new WeakMap<TypeMemberListFacts, AttributeEnumFacts>();

export const attributeEnumFacts = (
  bytes: Buffer,
  layout: ManagedMetadataLayout,
  memberLists: TypeMemberListFacts,
): AttributeEnumFacts => {
  let facts = inspections.get(memberLists);
  if (facts === undefined) {
    managedDecodeBudget(layout).reserve(256, null);
    facts = new AttributeEnumFacts(bytes, layout, memberLists);
    inspections.set(memberLists, facts);
  }
  return facts;
};
