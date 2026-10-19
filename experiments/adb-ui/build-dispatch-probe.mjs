import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { parseArgs } from "node:util";

const { values } = parseArgs({ options: { output: { type: "string" } } });
if (!values.output) throw new Error("Missing --output");
const output = resolve(values.output);
await mkdir(output, { mode: 0o700 });
const project = join(output, "project");
await cp(resolve(import.meta.dirname, "../../bridge/adb-ui"), project, {
  recursive: true,
  errorOnExist: true,
  force: false,
  dereference: true,
  filter: (path) => ![".gradle", "build"].includes(basename(path)),
});
const runner = join(
  project,
  "src/main/java/dev/rea/uiautomator/ReaUiRunner.java",
);
const original = await readFile(runner, "utf8");
let source = original;
const anchors = [
  "refreshNode(destination, NodeValidation.SNAPSHOT);",
  '"No captured window in the requested scope is still active or focused");',
];
for (const anchor of anchors) {
  assert.equal(
    source.split(anchor).length,
    2,
    `Expected one preparation boundary: ${anchor}`,
  );
  source = source.replace(
    anchor,
    `${anchor}
            // Verification-only state injection after the real preparation read.
            if (input.getInt("timeout_ms") == 11001) call.cancelled = true;
            if (input.getInt("timeout_ms") == 11002) call.deadline = 0;`,
  );
}
await writeFile(runner, source);
const gradle = join(project, "build.gradle");
await writeFile(
  gradle,
  `${await readFile(gradle, "utf8")}\nandroid.defaultConfig.versionName = 'dispatch-guard-probe'\n`,
);
await writeFile(
  join(output, "probe.json"),
  JSON.stringify(
    {
      purpose:
        "Controlled cancellation/deadline state after real key/drag preparation",
      source_sha256: createHash("sha256").update(original).digest("hex"),
      probe_sha256: createHash("sha256").update(source).digest("hex"),
      anchors,
      modes: {
        10000: "unchanged control",
        11001: "cancelled",
        11002: "expired",
      },
      project,
    },
    null,
    2,
  ),
  { flag: "wx" },
);
console.log(project);
