import { crc32, deflateSync } from "node:zlib";

import { describe, expect, it } from "vitest";

import { comparePngScreenshots } from "./PngVisualDiff.js";
import {
  AnalysisResourceConstraintError,
  AnalysisInputError,
} from "../domain/analysisErrorCore.js";
import {
  compareWebScreenshotsInputSchema,
  createWebScreenshotArtifact,
  webScreenshotDiffSchema,
} from "../domain/webScreenshot.js";

describe("PNG spatial diff", () => {
  it("locates disjoint changes and compares overlapping and unchanged regions independently", () => {
    const pixels = Array.from({ length: 24 }, () => [0, 0, 0, 255]).flat();
    const changed = [...pixels];
    changed[(1 * 6 + 2) * 4] = 30;
    changed[(3 * 6 + 5) * 4 + 3] = 0;
    const regions = [
      { x: 1, y: 1, width: 3, height: 2 },
      { x: 2, y: 1, width: 4, height: 3 },
      { x: 0, y: 0, width: 2, height: 1 },
    ];
    const result = comparePngScreenshots(
      compareWebScreenshotsInputSchema.parse({
        before: artifact(6, 4, pixels),
        after: artifact(6, 4, changed),
        regions,
      }),
    );
    expect(result).toMatchObject({
      changed_pixels: 2,
      compared_pixels: 24,
      changed_bounds: { x: 2, y: 1, width: 4, height: 3 },
      region_diffs: [
        {
          region: regions[0],
          status: "different",
          compared_pixels: 6,
          changed_pixels: 1,
          changed_ratio: 1 / 6,
          maximum_channel_delta: 30,
          mean_absolute_channel_delta: 30 / 24,
          changed_bounds: { x: 2, y: 1, width: 1, height: 1 },
        },
        {
          region: regions[1],
          compared_pixels: 12,
          changed_pixels: 2,
          changed_ratio: 2 / 12,
          maximum_channel_delta: 255,
          mean_absolute_channel_delta: 285 / 48,
          changed_bounds: { x: 2, y: 1, width: 4, height: 3 },
        },
        {
          region: regions[2],
          status: "identical",
          changed_pixels: 0,
          changed_bounds: null,
        },
      ],
    });
    expect(webScreenshotDiffSchema.safeParse(result).success).toBe(true);
    expect(
      webScreenshotDiffSchema.safeParse({ ...result, changed_bounds: null })
        .success,
    ).toBe(false);
    expect(
      webScreenshotDiffSchema.safeParse({
        ...result,
        region_diffs: [
          {
            ...result.region_diffs?.[0],
            changed_bounds: { x: 0, y: 0, width: 1, height: 1 },
          },
        ],
      }).success,
    ).toBe(false);
  });

  it("applies the strict channel threshold to bounds, keeping raw channel metrics", () => {
    const before = artifact(2, 1, [0, 0, 0, 255, 0, 0, 0, 255]);
    const after = artifact(2, 1, [10, 0, 0, 255, 11, 0, 0, 255]);
    const regions = [{ x: 0, y: 0, width: 1, height: 1 }];
    expect(
      comparePngScreenshots(
        compareWebScreenshotsInputSchema.parse({
          before,
          after,
          channel_threshold: 10,
          regions,
        }),
      ),
    ).toMatchObject({
      changed_pixels: 1,
      changed_bounds: { x: 1, y: 0, width: 1, height: 1 },
      region_diffs: [
        {
          status: "identical",
          changed_bounds: null,
          maximum_channel_delta: 10,
          mean_absolute_channel_delta: 2.5,
        },
      ],
    });
    expect(
      comparePngScreenshots(
        compareWebScreenshotsInputSchema.parse({
          before,
          after,
          channel_threshold: 255,
        }),
      ),
    ).toMatchObject({ status: "identical", changed_bounds: null });
  });

  it("keeps dimension mismatch unknown even for regions inside both images", () => {
    const before = artifact(1, 1, [0, 0, 0, 255]);
    const after = artifact(2, 1, [0, 0, 0, 255, 0, 0, 0, 255]);
    const result = comparePngScreenshots(
      compareWebScreenshotsInputSchema.parse({
        before,
        after,
        regions: [{ x: 0, y: 0, width: 1, height: 1 }],
      }),
    );
    expect(result).toMatchObject({
      status: "dimension_mismatch",
      changed_bounds: null,
      region_diffs: null,
    });
    expect(webScreenshotDiffSchema.safeParse(result).success).toBe(true);
  });
});

describe("spatial result consistency", () => {
  const result = () =>
    comparePngScreenshots(
      compareWebScreenshotsInputSchema.parse({
        before: artifact(3, 1, [0, 0, 0, 255, 0, 0, 0, 255, 0, 0, 0, 255]),
        after: artifact(3, 1, [30, 0, 0, 255, 30, 0, 0, 255, 0, 0, 0, 255]),
        regions: [{ x: 0, y: 0, width: 3, height: 1 }],
      }),
    );

  it.each([
    {
      status: "identical",
      changed_pixels: 0,
      changed_ratio: 0,
      changed_bounds: null,
    },
    { status: "different", changed_pixels: 1, changed_ratio: 1 / 3 },
  ])("rejects a region count exceeding the $status whole image", (whole) => {
    const parsed = webScreenshotDiffSchema.safeParse({ ...result(), ...whole });
    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: ["region_diffs", 0] }),
      ]),
    );
  });

  it("rejects regional bounds inside the region but outside whole-image bounds", () => {
    const diff = result();
    const parsed = webScreenshotDiffSchema.safeParse({
      ...diff,
      region_diffs: diff.region_diffs?.map((region) => ({
        ...region,
        changed_bounds: { x: 1, y: 0, width: 2, height: 1 },
      })),
    });
    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: ["region_diffs", 0] }),
      ]),
    );
  });

  it("accepts independently counted duplicate regions and missing historical bounds", () => {
    const diff = result();
    const overlapping = {
      ...diff,
      region_diffs: [
        ...(diff.region_diffs ?? []),
        ...(diff.region_diffs ?? []),
      ],
    };
    expect(webScreenshotDiffSchema.parse(overlapping)).toEqual(overlapping);
    const { changed_bounds: _bounds, ...historical } = overlapping;
    expect(webScreenshotDiffSchema.parse(historical)).toEqual(historical);
  });
});

describe("historical screenshot results", () => {
  it.each([
    {
      status: "identical",
      compared_pixels: 2,
      changed_pixels: 0,
      changed_ratio: 0,
      maximum_channel_delta: 0,
      mean_absolute_channel_delta: 0,
    },
    {
      status: "different",
      compared_pixels: 2,
      changed_pixels: 1,
      changed_ratio: 0.5,
      maximum_channel_delta: 24,
      mean_absolute_channel_delta: 3,
    },
    {
      status: "dimension_mismatch",
      compared_pixels: 0,
      changed_pixels: null,
      changed_ratio: null,
      maximum_channel_delta: null,
      mean_absolute_channel_delta: null,
    },
  ])("preserves missing spatial evidence for $status", (metrics) => {
    const historical = {
      before: { width: 2, height: 1 },
      after: {
        width: metrics.status === "dimension_mismatch" ? 1 : 2,
        height: 1,
      },
      channel_threshold: 0,
      limitations: [],
      ...metrics,
    };
    const parsed = webScreenshotDiffSchema.parse(historical);
    expect(parsed).toEqual(historical);
    expect(parsed).not.toHaveProperty("changed_bounds");
    expect(parsed).not.toHaveProperty("region_diffs");
  });
});

describe("PNG region admission", () => {
  it("bounds region payloads without truncating accepted selections", () => {
    const image = artifact(1, 1, [0, 0, 0, 255]);
    const region = { x: 0, y: 0, width: 1, height: 1 };
    const input = compareWebScreenshotsInputSchema.parse({
      before: image,
      after: image,
      regions: Array.from({ length: 1024 }, () => region),
    });
    expect(comparePngScreenshots(input).region_diffs).toHaveLength(1024);
    expect(() =>
      comparePngScreenshots({
        ...input,
        regions: [...(input.regions ?? []), region],
      }),
    ).toThrow(AnalysisResourceConstraintError);
  });

  it("rejects excess overlapping work before inflating image data", () => {
    // Deliberately incomplete scanlines: admission must run before decode.
    const image = createWebScreenshotArtifact(headerOnlyPng(1024, 1024));
    const region = { x: 0, y: 0, width: 1024, height: 1024 };
    const input = compareWebScreenshotsInputSchema.parse({
      before: image,
      after: image,
      regions: Array.from({ length: 65 }, () => region),
    });
    expect(() => comparePngScreenshots(input)).toThrow(
      AnalysisResourceConstraintError,
    );
    // Exactly 64 Mi pixel visits pass admission and reach the invalid scanlines.
    expect(() =>
      comparePngScreenshots({ ...input, regions: input.regions?.slice(0, 64) }),
    ).toThrow(TypeError);
  });
});

describe("PNG region validation", () => {
  it.each([
    { x: -1, y: 0, width: 1, height: 1 },
    { x: 0.5, y: 0, width: 1, height: 1 },
    { x: 0, y: 0, width: 0, height: 1 },
    { x: 0, y: 0, width: 1, height: -1 },
    { x: Number.MAX_SAFE_INTEGER + 1, y: 0, width: 1, height: 1 },
    { x: 0, y: 0, width: 1, height: 1, unknown: true },
  ])("rejects malformed rectangle %j", (region) => {
    const before = artifact(1, 1, [0, 0, 0, 255]);
    expect(
      compareWebScreenshotsInputSchema.safeParse({
        before,
        after: before,
        regions: [region],
      }).success,
    ).toBe(false);
  });

  it.each([
    { x: 1, y: 0, width: 1, height: 1 },
    { x: 0, y: 1, width: 1, height: 1 },
    { x: 0, y: 0, width: Number.MAX_SAFE_INTEGER, height: 1 },
  ])("rejects out-of-bounds rectangle %j without clipping", (region) => {
    const before = artifact(1, 1, [0, 0, 0, 255]);
    expect(() =>
      comparePngScreenshots(
        compareWebScreenshotsInputSchema.parse({
          before,
          after: before,
          regions: [region],
        }),
      ),
    ).toThrow(AnalysisInputError);
  });
});

const artifact = (width: number, height: number, pixels: readonly number[]) =>
  createWebScreenshotArtifact(png(width, height, pixels));

const png = (
  width: number,
  height: number,
  pixels: readonly number[],
): Buffer => {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6;
  const rows: number[] = [];
  for (let row = 0; row < height; row += 1)
    rows.push(0, ...pixels.slice(row * width * 4, (row + 1) * width * 4));
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(Buffer.from(rows))),
    chunk("IEND", Buffer.alloc(0)),
  ]);
};

const headerOnlyPng = (width: number, height: number): Buffer => {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 6, 0, 0, 0], 8);
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(Buffer.from([0]))),
    chunk("IEND", Buffer.alloc(0)),
  ]);
};

const chunk = (type: string, data: Buffer): Buffer => {
  const result = Buffer.alloc(12 + data.byteLength);
  result.writeUInt32BE(data.byteLength, 0);
  result.write(type, 4, 4, "ascii");
  data.copy(result, 8);
  result.writeUInt32BE(
    crc32(result.subarray(4, 8 + data.byteLength)),
    8 + data.byteLength,
  );
  return result;
};
