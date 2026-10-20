import { PassThrough } from "node:stream";

import { expect, it } from "vitest";
import { readGuardianReadyLine } from "../../../src/android/JadxWorkspaceRoot.js";

it("preserves a Windows parent path when UTF-8 bytes cross stdout chunks", async () => {
  const stdout = new PassThrough();
  const line = JSON.stringify({
    path: "C:\\Users\\测试\\rea-android-0123456789abcdef0123456789abcdef",
  });
  const bytes = Buffer.from(`${line}\n`, "utf8");
  const split = bytes.indexOf(Buffer.from("测", "utf8")) + 1;
  const ready = readGuardianReadyLine(stdout);

  stdout.write(bytes.subarray(0, split));
  stdout.write(bytes.subarray(split));

  await expect(ready).resolves.toBe(line);
  expect(stdout.listenerCount("data")).toBe(0);
});

it("bounds guardian readiness by UTF-8 bytes", async () => {
  const stdout = new PassThrough();
  const ready = readGuardianReadyLine(stdout);

  stdout.write(`${"测".repeat(1400)}\n`);

  await expect(ready).rejects.toThrow("exceeded 4 KiB");
  expect(stdout.listenerCount("data")).toBe(0);
});

it("counts readiness bytes across stdout chunks", async () => {
  const stdout = new PassThrough();
  const ready = readGuardianReadyLine(stdout);

  stdout.write("a".repeat(2048));
  stdout.write("b".repeat(2049));

  await expect(ready).rejects.toThrow("exceeded 4 KiB");
  expect(stdout.listenerCount("data")).toBe(0);
});

it("counts the newline toward the 4 KiB readiness limit", async () => {
  const withinLimit = new PassThrough();
  const accepted = readGuardianReadyLine(withinLimit);
  withinLimit.write(`${"a".repeat(4095)}\n`);
  await expect(accepted).resolves.toBe("a".repeat(4095));

  const overLimit = new PassThrough();
  const rejected = readGuardianReadyLine(overLimit);
  overLimit.write(`${"a".repeat(4096)}\n`);
  await expect(rejected).rejects.toThrow("exceeded 4 KiB");
});

it("rejects invalid UTF-8 before accepting a guardian path", async () => {
  const stdout = new PassThrough();
  const ready = readGuardianReadyLine(stdout);

  stdout.write(Buffer.from([0xff, 0x0a]));

  await expect(ready).rejects.toThrow();
  expect(stdout.listenerCount("data")).toBe(0);
});
