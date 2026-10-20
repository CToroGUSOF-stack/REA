import { describe, expect, it } from "vitest";
import { z } from "zod";

import { ownKeyRecordSchema } from "./ownKeyRecordSchema.js";

const value = z.string().min(1, "Values must not be empty");
const schema = ownKeyRecordSchema(z.string().min(1), value);
// JSON.parse defines __proto__ as an own member, as a caller's JSON input does.
const withPrototypeMember = (member: string): unknown =>
  JSON.parse(`{"A":"a","__proto__":${JSON.stringify(member)},"B":"b"}`);

describe("own-key record boundary", () => {
  it("keeps an accepted __proto__ member as ordinary data in its position", () => {
    const parsed = schema.parse(withPrototypeMember("selected-value"));

    expect(Object.getPrototypeOf(parsed)).toBe(Object.prototype);
    expect(Object.keys(parsed)).toEqual(["A", "__proto__", "B"]);
    expect(Object.getOwnPropertyDescriptor(parsed, "__proto__")).toEqual({
      value: "selected-value",
      writable: true,
      enumerable: true,
      configurable: true,
    });
  });

  it("validates the __proto__ value at the member path", () => {
    const parsed = schema.safeParse(withPrototypeMember(""));

    expect(parsed.error?.issues).toMatchObject([
      { path: ["__proto__"], message: "Values must not be empty" },
    ]);
  });

  it("advertises the record contract it enforces", () => {
    const record = z.record(z.string().min(1), value);
    for (const io of ["input", "output"] as const)
      expect(z.toJSONSchema(schema.default({}), { io })).toEqual(
        z.toJSONSchema(record.default({}), { io }),
      );
  });
});
