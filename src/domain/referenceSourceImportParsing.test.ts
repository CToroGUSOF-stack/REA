import assert from "node:assert/strict";
import { describe, it } from "vitest";

import { parseReferenceSourceImports } from "./referenceSourceImportParsing.js";

const parse = (source: string) =>
  parseReferenceSourceImports(
    "fixture.cjs",
    new TextEncoder().encode(source),
    "JavaScript",
  );

describe("reference source CommonJS template specifiers", () => {
  it("retains exact no-substitution template requires like quoted strings", () => {
    assert.equal(parse('require("mod")').relationships[0]?.to, "mod");
    const template = parse("require(`mod`)");
    assert.equal(template.relationships[0]?.to, "mod");
    assert.equal(template.relationships[0]?.kind, "requires");
    assert.equal(template.relationships[0]?.resolution, "external");
    assert.equal(template.relationships[0]?.parse_state, "parsed");
    assert.deepEqual(template.parse_failures, []);
  });

  it("keeps dynamic import() templates partial and rejects static ESM templates", () => {
    const dynamic = parse("import(`mod`)");
    assert.equal(dynamic.relationships[0]?.to, "<dynamic-import>");
    assert.equal(dynamic.relationships[0]?.parse_state, "partial");
    assert.equal(
      parse("import(`./${name}.js`)").relationships[0]?.resolution,
      "unknown",
    );
    assert.ok(parse("import x from `mod`;").parse_failures.length > 0);
    assert.ok(parse("export * from `mod`;").parse_failures.length > 0);
  });
});
