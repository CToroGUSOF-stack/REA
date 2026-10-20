import { expect, it } from "vitest";
import { z } from "zod";

import { observeWebSessionInputSchema } from "./browserSession.js";

const input = {
  cdp_endpoint: "http://127.0.0.1:9222",
  target_id: "target",
};

it("bounds the observation window by the largest Node.js timer delay", () => {
  expect(
    observeWebSessionInputSchema.parse({
      ...input,
      observation_ms: 2_147_483_647,
    }).observation_ms,
  ).toBe(2_147_483_647);
  const rejected = observeWebSessionInputSchema.safeParse({
    ...input,
    observation_ms: 2_147_483_648,
  });
  expect(rejected.success).toBe(false);
  expect(rejected.error?.issues).toMatchObject([
    { code: "too_big", path: ["observation_ms"], maximum: 2_147_483_647 },
  ]);
  expect(
    z.toJSONSchema(observeWebSessionInputSchema, { io: "input" }).properties
      ?.observation_ms,
  ).toMatchObject({ minimum: 1, maximum: 2_147_483_647 });
});
