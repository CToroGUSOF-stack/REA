import type {
  WebScreenshotRegion,
  WebScreenshotRegionDiff,
} from "../domain/screenshotRegion.js";
import { containsScreenshotRegion } from "../domain/screenshotRegion.js";
import {
  AnalysisInputError,
  AnalysisResourceConstraintError,
} from "../domain/analysisErrorCore.js";

interface ScreenshotDimensions {
  readonly width: number;
  readonly height: number;
}
interface ScreenshotPixels extends ScreenshotDimensions {
  readonly rgba: Buffer;
}

// Bound synchronous ROI work separately from decoder memory. A 2048 x 1024
// local probe with 32 full-image regions exercises this 64 Mi-pixel allowance.
const PNG_REGION_PIXEL_VISITS = 64 * 1024 * 1024;
// Each entry contains two rectangles and scalar metrics. 1 KiB conservatively
// covers their JSON plus the echoed request rectangle, including numeric text.
// This is a region payload budget, not an estimate of total Evidence memory.
const PNG_REGION_RESULT_BYTES = 1024;
const PNG_REGION_PAYLOAD_BYTES = 1024 * 1024;

export const admitScreenshotRegionPayload = (
  regions: readonly WebScreenshotRegion[],
): void => {
  const estimatedBytes = regions.length * PNG_REGION_RESULT_BYTES;
  if (estimatedBytes > PNG_REGION_PAYLOAD_BYTES)
    throw new AnalysisResourceConstraintError(
      "compare_web_screenshots",
      "capacity",
      "Selected screenshot regions exceed the region payload budget.",
      {
        boundary: "png-screenshot-regions",
        requested_regions: regions.length,
        estimated_region_payload_bytes: estimatedBytes,
        maximum_region_payload_bytes: PNG_REGION_PAYLOAD_BYTES,
        estimated_bytes_per_region: PNG_REGION_RESULT_BYTES,
      },
      { remediationAction: "Request fewer regions per call." },
    );
};

export const admitScreenshotRegions = (
  beforePlan: ScreenshotDimensions,
  afterPlan: ScreenshotDimensions,
  regions: readonly WebScreenshotRegion[],
): void => {
  let regionPixelVisits = 0n;
  for (const [index, region] of regions.entries()) {
    for (const [field, plan] of [
      ["before", beforePlan],
      ["after", afterPlan],
    ] as const) {
      if (
        !containsScreenshotRegion(
          { x: 0, y: 0, width: plan.width, height: plan.height },
          region,
        )
      )
        throw new AnalysisInputError("compare_web_screenshots", undefined, [
          {
            path: ["regions", index],
            reason: "out_of_range",
            message: `Region must fit within the ${field} PNG dimensions (${String(plan.width)} x ${String(plan.height)}).`,
          },
        ]);
    }
    regionPixelVisits += BigInt(region.width) * BigInt(region.height);
  }
  if (
    beforePlan.width === afterPlan.width &&
    beforePlan.height === afterPlan.height &&
    regionPixelVisits > BigInt(PNG_REGION_PIXEL_VISITS)
  )
    throw new AnalysisResourceConstraintError(
      "compare_web_screenshots",
      "cpu",
      "Selected screenshot regions exceed the pixel-comparison work budget.",
      {
        boundary: "png-screenshot-regions",
        requested_region_pixel_visits: regionPixelVisits.toString(),
        maximum_region_pixel_visits: PNG_REGION_PIXEL_VISITS,
      },
      { remediationAction: "Compare fewer or smaller regions per call." },
    );
};

/** Compare already-decoded, admitted equal-sized images without cropping buffers. */
export const compareScreenshotRegions = (
  before: ScreenshotPixels,
  after: ScreenshotPixels,
  threshold: number,
  regions?: readonly WebScreenshotRegion[],
) => {
  const full = compareRegion(before, after, threshold, {
    x: 0,
    y: 0,
    width: before.width,
    height: before.height,
  });
  const { region: _region, ...metrics } = full;
  const context = {
    ...metrics,
    ...(regions === undefined
      ? {}
      : {
          region_diffs: regions.map((region) =>
            compareRegion(before, after, threshold, region),
          ),
        }),
  };
  if (full.changed_bounds === null)
    return {
      ...context,
      status: "identical" as const,
      changed_pixels: 0 as const,
      changed_ratio: 0 as const,
      changed_bounds: null,
    };
  return {
    ...context,
    status: "different" as const,
    changed_bounds: full.changed_bounds,
  };
};

const compareRegion = (
  before: ScreenshotPixels,
  after: ScreenshotPixels,
  threshold: number,
  region: WebScreenshotRegion,
): WebScreenshotRegionDiff => {
  let changedPixels = 0;
  let maximumDelta = 0;
  let totalDelta = 0;
  let minX = region.x + region.width;
  let minY = region.y + region.height;
  let maxX = -1;
  let maxY = -1;
  for (let y = region.y; y < region.y + region.height; y += 1) {
    for (let x = region.x; x < region.x + region.width; x += 1) {
      const offset = (y * before.width + x) * 4;
      let changed = false;
      for (let channel = 0; channel < 4; channel += 1) {
        const delta = Math.abs(
          (before.rgba[offset + channel] ?? 0) -
            (after.rgba[offset + channel] ?? 0),
        );
        totalDelta += delta;
        maximumDelta = Math.max(maximumDelta, delta);
        if (delta > threshold) changed = true;
      }
      if (changed) {
        changedPixels += 1;
        minX = Math.min(minX, x);
        minY = Math.min(minY, y);
        maxX = Math.max(maxX, x);
        maxY = Math.max(maxY, y);
      }
    }
  }
  const pixels = region.width * region.height;
  return {
    region,
    status: changedPixels === 0 ? "identical" : "different",
    compared_pixels: pixels,
    maximum_channel_delta: maximumDelta,
    mean_absolute_channel_delta: totalDelta / (pixels * 4),
    changed_pixels: changedPixels,
    changed_ratio: changedPixels / pixels,
    changed_bounds:
      changedPixels === 0
        ? null
        : {
            x: minX,
            y: minY,
            width: maxX - minX + 1,
            height: maxY - minY + 1,
          },
  };
};
