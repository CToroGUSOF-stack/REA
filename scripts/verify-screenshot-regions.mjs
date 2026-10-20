#!/usr/bin/env node

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { chromium } from "playwright-core";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { Ajv2020 } from "ajv/dist/2020.js";
import { createWebScreenshotArtifact } from "../dist/domain/webScreenshot.js";
import { parseEvidence } from "../dist/domain/evidence.js";
import { finishScreenshotVerifier } from "./lib/browser-screenshot-verifier-cleanup.mjs";
import { createVerifierRun } from "./lib/verifier-run.mjs";

const executable = process.env.REA_BROWSER_EXECUTABLE;
assert.ok(
  executable && isAbsolute(executable),
  "Set absolute REA_BROWSER_EXECUTABLE",
);
const run = createVerifierRun();
const started = performance.now();
const workspace = await mkdtemp(join(tmpdir(), "rea-spatial-verifier-"));
const entrypoint = fileURLToPath(new URL("./rea.mjs", import.meta.url));
const html = await readFile(
  new URL("./fixtures/visual-coding-page.html", import.meta.url),
  "utf8",
);
const client = new Client({ name: "screenshot-regions-real", version: "1" });
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [entrypoint, "mcp"],
  stderr: "pipe",
});
let browser;
let completed;
const failures = [];
const cases = [];
try {
  await client.connect(transport);
  browser = await chromium.launch({
    executablePath: executable,
    headless: true,
  });
  const tool = (await client.listTools()).tools.find(
    ({ name }) => name === "compare_web_screenshots",
  );
  assert.ok(tool?.outputSchema);
  const ajv = new Ajv2020({ strict: false, validateFormats: false });
  const validate = ajv.compile(tool.outputSchema);
  for (const [width, scale] of [
    [800, 1],
    [390, 1],
    [800, 2],
  ]) {
    const context = await browser.newContext({
      viewport: { width, height: 600 },
      deviceScaleFactor: scale,
    });
    try {
      const page = await context.newPage();
      await page.setContent(html);
      await page.evaluate(() => document.fonts.ready);
      const before = createWebScreenshotArtifact(await page.screenshot());
      const left = width < 420 ? 40 : 64;
      const selected = {
        x: left * scale,
        y: 320 * scale,
        width: 224 * scale,
        height: 48 * scale,
      };
      const stable = { x: 0, y: 0, width: width * scale, height: 72 * scale };
      for (const mutation of ["layout", "color", "text", "missing"]) {
        await page.setContent(html);
        await page.evaluate((kind) => {
          const button = document.querySelector("button");
          if (kind === "layout") button.style.transform = "translateX(24px)";
          if (kind === "color") button.style.background = "#c53232";
          if (kind === "text")
            document.querySelector("h1").textContent = "Solo workspace";
          if (kind === "missing") button.style.visibility = "hidden";
        }, mutation);
        const after = createWebScreenshotArtifact(await page.screenshot());
        const input = { before, after, regions: [selected, stable] };
        const evidence = await compareBoth(input, workspace, validate);
        const diff = evidence.normalized_result;
        assert.equal(diff.status, "different");
        assert.equal(diff.region_diffs[1].status, "identical");
        if (mutation === "text") {
          assert.equal(diff.region_diffs[0].status, "identical");
          const bounds = diff.changed_bounds;
          assert.ok(bounds.x >= left * scale && bounds.y >= 144 * scale);
          assert.ok(
            bounds.x + bounds.width <= (left + 296) * scale &&
              bounds.y + bounds.height <= 176 * scale,
          );
        } else {
          const expected = {
            x: left * scale,
            y: 320 * scale,
            width: (mutation === "layout" ? 224 : 200) * scale,
            height: 48 * scale,
          };
          assert.deepEqual(diff.changed_bounds, expected);
          assert.deepEqual(diff.region_diffs[0].changed_bounds, expected);
          assert.equal(
            diff.region_diffs[0].changed_pixels,
            diff.changed_pixels,
          );
        }
        cases.push({
          width,
          scale,
          mutation,
          changed_pixels: diff.changed_pixels,
          changed_bounds: diff.changed_bounds,
          cli_mcp_parity: true,
        });
      }
      // A repaired component must compare equal even while another region differs.
      await page.setContent(html);
      await page.locator("header").evaluate((element) => {
        element.style.background = "#223344";
      });
      const repaired = await compareBoth(
        {
          before,
          after: createWebScreenshotArtifact(await page.screenshot()),
          regions: [selected, stable],
        },
        workspace,
        validate,
      );
      assert.equal(
        repaired.normalized_result.region_diffs[0].status,
        "identical",
      );
      assert.equal(
        repaired.normalized_result.region_diffs[1].status,
        "different",
      );
      await page.getByRole("button", { name: "Join workspace" }).click();
      assert.equal(await page.locator("output").textContent(), "Joined");
      assert.equal(
        await page.locator("button").getAttribute("aria-pressed"),
        "true",
      );
      await page.locator("button").press("Enter");
      assert.equal(await page.locator("output").textContent(), "Not joined");
      assert.equal(
        await page.locator("button").getAttribute("aria-pressed"),
        "false",
      );
      cases.push({
        width,
        scale,
        mutation: "local_repair",
        preserved_region: true,
        click_and_keyboard: true,
      });
    } finally {
      try {
        await context.close();
      } catch (cause) {
        failures.push(cause);
      }
    }
  }
} catch (cause) {
  failures.push(cause);
} finally {
  completed = await finishScreenshotVerifier(
    run,
    workspace,
    [() => client.close(), () => transport.close(), () => browser?.close()],
    failures,
  );
}
console.log(
  JSON.stringify(
    {
      suite: "source-owned-spatial-regressions",
      browser: executable,
      cases,
      elapsed_ms: performance.now() - started,
      verifier_process_resources: process.resourceUsage(),
      ...completed,
    },
    null,
    2,
  ),
);

async function compareBoth(input, workspace, validate) {
  const paths = ["before", "after", "regions"].map((key) =>
    join(workspace, `${key}.json`),
  );
  await Promise.all(
    paths.map((path, index) =>
      writeFile(
        path,
        JSON.stringify([input.before, input.after, input.regions][index]),
      ),
    ),
  );
  const { stdout } = await promisify(execFile)(
    process.execPath,
    [
      entrypoint,
      "compare-web-screenshots",
      paths[0],
      paths[1],
      "--regions",
      paths[2],
      "--json",
    ],
    { timeout: 60000, maxBuffer: 8 * 1024 * 1024 },
  );
  const cli = parseEvidence(JSON.parse(stdout));
  const response = await client.callTool({
    name: "compare_web_screenshots",
    arguments: input,
  });
  assert.notEqual(response.isError, true, JSON.stringify(response));
  assert.ok(
    validate(response.structuredContent),
    JSON.stringify(validate.errors),
  );
  const mcp = parseEvidence(response.structuredContent);
  assert.equal(cli.evidence_id, mcp.evidence_id);
  assert.deepEqual(cli.normalized_result, mcp.normalized_result);
  return mcp;
}
