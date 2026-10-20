import {
  schemaArrays,
  schemaChildren,
  schemaMaps,
} from "../../src/contracts/jsonSchemaKeywords.js";
import { resolveLocalSchemaReference } from "../../src/contracts/inputSchemaPresentation.js";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

type SchemaChildEntry = readonly [suffix: string, child: unknown];

/** Enumerate schema-valued children with a stable path suffix. */
const schemaChildEntries = (
  schema: Readonly<Record<string, unknown>>,
): readonly SchemaChildEntry[] => {
  const entries: SchemaChildEntry[] = [];
  for (const [key, value] of Object.entries(schema)) {
    if (schemaMaps.has(key) && isRecord(value)) {
      for (const [name, child] of Object.entries(value))
        entries.push([`${key}.${name}`, child]);
    } else if (schemaArrays.has(key) && Array.isArray(value)) {
      value.forEach((child, index) =>
        entries.push([`${key}[${index}]`, child]),
      );
    } else if (schemaChildren.has(key)) {
      if (Array.isArray(value))
        value.forEach((child, index) =>
          entries.push([`${key}[${index}]`, child]),
        );
      else entries.push([key, value]);
    }
  }
  return entries;
};

/** VS Code Copilot rejects falsy `items` for any type that admits arrays. */
export const arrayItemSchemaError = (
  schema: unknown,
  path: string,
): string | undefined => {
  if (!isRecord(schema)) return undefined;
  const admitsArrays =
    schema.type === "array" ||
    (Array.isArray(schema.type) && schema.type.includes("array"));
  if (admitsArrays && !schema.items)
    return `${path}: tool parameters array type must have items`;
  for (const [suffix, child] of schemaChildEntries(schema)) {
    const error = arrayItemSchemaError(child, `${path}.${suffix}`);
    if (error !== undefined) return error;
  }
  return undefined;
};

/** Reject Gemini-incompatible boolean literals in advertised input positions. */
export const booleanLiteralSchemaError = (
  schema: unknown,
  path: string,
): string | undefined => {
  if (!isRecord(schema)) return undefined;
  if (typeof schema.const === "boolean") return `${path}.const is boolean`;
  if (
    Array.isArray(schema.enum) &&
    schema.enum.some((value) => typeof value === "boolean")
  )
    return `${path}.enum contains a boolean`;
  for (const [suffix, child] of schemaChildEntries(schema)) {
    const error = booleanLiteralSchemaError(child, `${path}.${suffix}`);
    if (error !== undefined) return error;
  }
  return undefined;
};

/** Reject Gemini-incompatible empty-string literals in advertised input positions. */
export const emptyStringLiteralSchemaError = (
  schema: unknown,
  path: string,
  root: unknown = schema,
  active: ReadonlySet<string> = new Set(),
): string | undefined => {
  if (!isRecord(schema)) return undefined;
  if (schema.const === "") return `${path}.const is an empty string`;
  if (Array.isArray(schema.enum) && schema.enum.some((value) => value === ""))
    return `${path}.enum contains an empty string`;
  if (
    typeof schema.$ref === "string" &&
    schema.$ref.startsWith("#") &&
    !active.has(schema.$ref)
  ) {
    const error = emptyStringLiteralSchemaError(
      resolveLocalSchemaReference(
        root as Record<string, unknown>,
        schema.$ref,
      )?.value,
      `${path}.$ref`,
      root,
      new Set([...active, schema.$ref]),
    );
    if (error !== undefined) return error;
  }
  for (const [suffix, child] of schemaChildEntries(schema)) {
    const error = emptyStringLiteralSchemaError(
      child,
      `${path}.${suffix}`,
      root,
      active,
    );
    if (error !== undefined) return error;
  }
  return undefined;
};
