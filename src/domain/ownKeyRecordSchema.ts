import { z } from "zod";

const PROTOTYPE_KEY = "__proto__";
// Nested issues keep their input; the enclosing parse decides whether to report it.
const NESTED_PARSE = { reportInput: true } as const;

type RawIssue = z.core.$ZodRawIssue;
type Parsed<Data> =
  | { readonly success: true; readonly data: Data }
  | { readonly success: false; readonly issues: readonly RawIssue[] };

// Finalized nested issues keep their messages and record-relative paths.
const rawIssue = (issue: z.core.$ZodIssue): RawIssue =>
  ({ ...issue, input: issue.input }) as RawIssue;

/** An own enumerable member's value and its position among the own keys. */
const ownEnumerableMember = (
  input: unknown,
  name: string,
): { readonly value: unknown; readonly position: number } | undefined => {
  if (typeof input !== "object" || input === null) return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(input, name);
  return descriptor?.enumerable === true
    ? { value: descriptor.value, position: Object.keys(input).indexOf(name) }
    : undefined;
};

/**
 * String-keyed record that keeps an own `__proto__` member as ordinary data.
 *
 * Zod's record parser skips that key without validating or reporting it, so a
 * caller-selected entry silently disappears. This boundary validates the
 * member with the same key and value schemas, defines it as a data property in
 * its original position, and advertises the `z.record` JSON Schema it enforces.
 * Keys and values must not change type, so input and output projections agree.
 * Wrap the result (`.default()`, `.optional()`); derivations such as
 * `.describe()` clone it and drop the projection.
 */
export const ownKeyRecordSchema = <Element>(
  key: z.ZodType<string, string>,
  value: z.ZodType<Element, Element>,
) => {
  const record = z.record(key, value);

  const parsePrototypeEntry = (member: unknown): Parsed<[string, Element]> => {
    const parsedKey = key.safeParse(PROTOTYPE_KEY, NESTED_PARSE);
    const parsedValue = value.safeParse(member, NESTED_PARSE);
    if (parsedKey.success && parsedValue.success)
      return { success: true, data: [parsedKey.data, parsedValue.data] };
    return {
      success: false,
      issues: [
        ...(parsedKey.success
          ? []
          : [
              {
                code: "invalid_key" as const,
                origin: "record" as const,
                issues: parsedKey.error.issues,
                input: PROTOTYPE_KEY,
                path: [PROTOTYPE_KEY],
              },
            ]),
        ...(parsedValue.success
          ? []
          : parsedValue.error.issues.map((issue) =>
              rawIssue({ ...issue, path: [PROTOTYPE_KEY, ...issue.path] }),
            )),
      ],
    };
  };

  const parse = (input: unknown): Parsed<Record<string, Element>> => {
    const parsed = record.safeParse(input, NESTED_PARSE);
    const member = ownEnumerableMember(input, PROTOTYPE_KEY);
    const entry =
      member === undefined ? undefined : parsePrototypeEntry(member.value);
    if (!parsed.success || entry?.success === false)
      return {
        success: false,
        issues: [
          ...(parsed.success ? [] : parsed.error.issues.map(rawIssue)),
          ...(entry?.success === false ? entry.issues : []),
        ],
      };
    if (member === undefined || entry === undefined)
      return { success: true, data: parsed.data };
    // Zod omits only this member and keeps every other own key in order.
    return {
      success: true,
      data: Object.fromEntries(
        Object.entries(parsed.data).toSpliced(member.position, 0, entry.data),
      ),
    };
  };

  // A refinement plus overwrite, rather than a transform, keeps the schema
  // non-transforming, so input projections retain an enclosing default.
  const base = z.custom<Record<string, Element>>();
  const schema = base.check(
    z.superRefine((input, context) => {
      const parsed = parse(input);
      // Uncontinued issues also skip the overwrite.
      if (!parsed.success) context.issues.push(...parsed.issues);
    }),
    z.overwrite((input) => {
      const parsed = parse(input);
      return parsed.success ? parsed.data : input;
    }),
  );
  // Zod projects a derived schema together with its parent. Both advertise
  // the record contract they enforce instead of an unrepresentable custom type.
  for (const advertised of [base, schema])
    advertised._zod.processJSONSchema = record._zod.processJSONSchema;
  return schema;
};
