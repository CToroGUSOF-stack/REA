import { isAbsolute } from "node:path";
import { z } from "zod";

export const selectionSchema = z.strictObject({
  channels: z.array(z.string().min(1)).min(1),
  file_paths: z
    .array(
      z
        .string()
        .refine((value) => !value.includes("\0"))
        .refine(isAbsolute),
    )
    .min(1),
  retention_bytes: z.number().int().min(1024).max(Number.MAX_SAFE_INTEGER),
});

const eventFields = {
  sequence: z.number().int().positive(),
  phase: z.enum([
    "started",
    "fulfilled",
    "rejected",
    "threw",
    "returned",
    "returned_completion_unknown",
  ]),
  within_handler: z.boolean().nullable(),
};
const eventSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    ...eventFields,
    kind: z.literal("handler"),
    invocation_id: z.number().int().positive(),
    channel: z.string(),
    registration: z
      .strictObject({
        script_name: z.string(),
        line: z.number().int().nonnegative(),
        column: z.number().int().nonnegative(),
      })
      .nullable(),
  }),
  z.strictObject({
    ...eventFields,
    kind: z.literal("file-write"),
    invocation_id: z.number().int().positive().nullable(),
    effect_id: z.number().int().positive(),
    path: z.string().refine(isAbsolute),
  }),
]);

/** An experiment format; not a canonical REA Evidence envelope. */
export const traceSchema = z
  .strictObject({
    format: z.literal("rea-electron-feature-path-prototype-v1"),
    selection: selectionSchema,
    events: z.array(eventSchema),
    coverage: z.strictObject({
      status: z.enum(["selected-probes-retained", "truncated"]),
      observed: z.number().int().nonnegative(),
      retained: z.number().int().nonnegative(),
      dropped: z.number().int().nonnegative(),
      estimated_retained_bytes: z.number().int().nonnegative(),
    }),
    limitations: z.array(z.string()),
  })
  .superRefine((trace, context) => {
    const { coverage } = trace;
    const channels = new Set(trace.selection.channels);
    const paths = new Set(trace.selection.file_paths);
    if (
      channels.size !== trace.selection.channels.length ||
      paths.size !== trace.selection.file_paths.length ||
      coverage.retained !== trace.events.length ||
      coverage.observed !== coverage.retained + coverage.dropped ||
      (coverage.status === "truncated") !== coverage.dropped > 0 ||
      coverage.estimated_retained_bytes > trace.selection.retention_bytes ||
      trace.events.some(
        (event, index) =>
          (event.kind === "handler" && !channels.has(event.channel)) ||
          (event.kind === "file-write" && !paths.has(event.path)) ||
          event.sequence > coverage.observed ||
          (index > 0 && event.sequence <= trace.events[index - 1].sequence),
      )
    )
      context.addIssue({
        code: "custom",
        message: "Inconsistent retained coverage, selection or event ordering.",
      });
  });
