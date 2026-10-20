import { z } from "zod";

/** Half-open rectangle in decoded PNG pixels, relative to the image origin. */
export const webScreenshotRegionSchema = z.strictObject({
  x: z.number().int().nonnegative(),
  y: z.number().int().nonnegative(),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
});
export type WebScreenshotRegion = z.infer<typeof webScreenshotRegionSchema>;

const pixelMetricsShape = {
  compared_pixels: z.number().int().positive(),
  changed_pixels: z.number().int().nonnegative(),
  changed_ratio: z.number().min(0).max(1),
  maximum_channel_delta: z.number().int().min(0).max(255),
  mean_absolute_channel_delta: z.number().min(0).max(255),
  changed_bounds: webScreenshotRegionSchema.nullable(),
};

export const webScreenshotRegionDiffSchema = z.object({
  region: webScreenshotRegionSchema,
  status: z.enum(["identical", "different"]),
  ...pixelMetricsShape,
});
export type WebScreenshotRegionDiff = z.infer<
  typeof webScreenshotRegionDiffSchema
>;

interface ScreenshotSpatialMetrics {
  readonly before: { readonly width: number; readonly height: number };
  readonly status: "identical" | "different" | "dimension_mismatch";
  readonly compared_pixels: number;
  readonly changed_pixels: number | null;
  readonly changed_ratio: number | null;
  readonly changed_bounds?: WebScreenshotRegion | null | undefined;
  readonly region_diffs?: readonly WebScreenshotRegionDiff[] | null | undefined;
}

/** Validate spatial fields without inventing values absent from historical evidence. */
export const validateScreenshotSpatialMetrics = (
  diff: ScreenshotSpatialMetrics,
  context: z.RefinementCtx,
): void => {
  if (diff.status === "dimension_mismatch") return;
  const image = { x: 0, y: 0, ...diff.before };
  const comparisons = [
    { ...diff, region: image },
    ...(diff.region_diffs ?? []),
  ];
  for (const [index, comparison] of comparisons.entries()) {
    const { region, changed_bounds: bounds } = comparison;
    if (
      comparison.changed_pixels === null ||
      comparison.changed_ratio === null ||
      !containsScreenshotRegion(image, region) ||
      comparison.compared_pixels !== region.width * region.height ||
      comparison.changed_pixels > comparison.compared_pixels ||
      (diff.changed_pixels !== null &&
        comparison.changed_pixels > diff.changed_pixels) ||
      comparison.changed_ratio !==
        comparison.changed_pixels / comparison.compared_pixels ||
      (comparison.status === "identical") !==
        (comparison.changed_pixels === 0) ||
      (bounds !== undefined &&
        (bounds === null) !== (comparison.changed_pixels === 0)) ||
      (bounds !== undefined &&
        bounds !== null &&
        (!containsScreenshotRegion(region, bounds) ||
          bounds.width * bounds.height < comparison.changed_pixels ||
          (diff.changed_bounds != null &&
            !containsScreenshotRegion(diff.changed_bounds, bounds))))
    )
      context.addIssue({
        code: "custom",
        path: index === 0 ? [] : ["region_diffs", index - 1],
        message:
          "Pixel metrics and changed bounds must match their comparison region",
      });
  }
};

/** Subtraction keeps containment checks safe for large caller coordinates. */
export const containsScreenshotRegion = (
  outer: WebScreenshotRegion,
  inner: WebScreenshotRegion,
): boolean =>
  inner.x >= outer.x &&
  inner.y >= outer.y &&
  inner.width <= outer.width - (inner.x - outer.x) &&
  inner.height <= outer.height - (inner.y - outer.y);
