import { describe, expect, it } from "vitest";
import {
  normalizeBinwalkReport,
  normalizeUnblobReport,
} from "./FirmwareReports.js";

const context = {
  inputPath: "/private/input.bin",
  outputRoot: "/private/output",
  sha256: "a".repeat(64),
  length: 20,
  offset: 64,
  maxDepth: 3,
};
const root = () => ({
  task: {
    path: context.inputPath,
    depth: 0,
    blob_id: "",
    is_multi_file: false,
  },
  reports: [
    {
      __typename__: "StatReport",
      path: context.inputPath,
      size: 20,
      is_file: true,
      is_dir: false,
      is_link: false,
      link_target: null,
    },
    { __typename__: "HashReport", sha256: context.sha256 },
    {
      __typename__: "UnknownChunkReport",
      id: "unknown",
      start_offset: 0,
      end_offset: 20,
      size: 20,
      randomness: null,
    },
  ],
  subtasks: [],
});

describe("firmware producer boundaries", () => {
  it("retains unknown chunks and their selected original-file range", () => {
    const normalized = normalizeUnblobReport([root()], context);
    expect(normalized.coverage).toBe("partial");
    expect(normalized.chunks[0]).toMatchObject({
      handler: null,
      range: { offset: 0, length: 20 },
      root_file_range: { offset: 64, length: 20 },
    });
  });
  it("preserves unfamiliar report types as explicit diagnostics", () => {
    const record = root();
    const normalized = normalizeUnblobReport(
      [
        {
          ...record,
          reports: [
            ...record.reports,
            { __typename__: "FutureError", reason: "new producer facet" },
          ],
        },
      ],
      context,
    );
    expect(normalized.diagnostics).toEqual([
      {
        input_path: "$input",
        report: { __typename__: "FutureError", reason: "new producer facet" },
      },
    ]);
    expect(normalized.coverage).toBe("partial");
  });
});

describe("Unblob multi-file extraction diagnostics", () => {
  it("names a missing extractor dependency and stage while retaining the raw report", () => {
    const dependencyFailure = {
      __typename__: "ExtractorDependencyNotFoundReport",
      severity: "ERROR",
      dependencies: ["sasquatch"],
    };
    const record = root();
    const normalized = normalizeUnblobReport(
      [
        {
          ...record,
          reports: [
            ...record.reports.filter(
              (item) => item.__typename__ !== "UnknownChunkReport",
            ),
            {
              __typename__: "ChunkReport",
              id: "gzip-id",
              start_offset: 0,
              end_offset: 20,
              size: 20,
              handler_name: "gzip",
              is_encrypted: false,
              extraction_reports: [dependencyFailure],
            },
          ],
        },
      ],
      context,
    );
    expect(normalized.coverage).toBe("partial");
    expect(normalized.diagnostics).toEqual([
      {
        input_path: "$input",
        stage: "gzip",
        missing_dependencies: ["sasquatch"],
        report: dependencyFailure,
      },
    ]);
  });

  it("retains nested MultiFile extraction failures in partial coverage", () => {
    const outputPath = `${context.outputRoot}/multi`;
    const childTask = {
      path: outputPath,
      depth: 1,
      blob_id: "multi-id",
      is_multi_file: true,
    };
    const extractionFailure = {
      __typename__: "ExtractorDependencyNotFoundReport",
      severity: "ERROR",
      dependencies: ["sasquatch"],
    };
    const multiFileReport = {
      __typename__: "MultiFileReport",
      id: "multi-id",
      handler_name: "multipart-firmware",
      name: "rootfs",
      paths: [`${outputPath}/part-a`, `${outputPath}/part-b`],
      extraction_reports: [extractionFailure],
    };
    const parent = root();
    const normalized = normalizeUnblobReport(
      [
        {
          ...parent,
          reports: parent.reports.filter(
            (item) => item.__typename__ !== "UnknownChunkReport",
          ),
          subtasks: [childTask],
        },
        {
          task: childTask,
          reports: [
            {
              __typename__: "StatReport",
              path: outputPath,
              size: 0,
              is_dir: true,
              is_file: false,
              is_link: false,
              link_target: null,
            },
            multiFileReport,
          ],
          subtasks: [],
        },
      ],
      context,
    );

    expect(normalized.coverage).toBe("partial");
    expect(normalized.diagnostics).toEqual([
      {
        input_path: "$output/multi",
        stage: "multipart-firmware",
        missing_dependencies: ["sasquatch"],
        report: multiFileReport,
      },
    ]);
  });
});

describe("firmware producer boundaries", () => {
  it("rejects unknown tasks outside the owned output and disconnected task graphs", () => {
    const record = root();
    for (const path of [
      "/private/output/../escaped",
      "/private/output/unconnected",
    ]) {
      const child = { ...record, task: { ...record.task, path, depth: 1 } };
      expect(() => normalizeUnblobReport([record, child], context)).toThrow();
    }
  });
  it("rejects absent root identity, inconsistent chunk bounds and duplicate tasks", () => {
    const record = root();
    expect(() => normalizeUnblobReport([], context)).toThrow("exactly one");
    expect(() =>
      normalizeUnblobReport(
        [
          {
            ...record,
            reports: record.reports.filter(
              (report) => report.__typename__ !== "HashReport",
            ),
          },
        ],
        context,
      ),
    ).toThrow("hash");
    expect(() =>
      normalizeUnblobReport(
        [
          {
            ...record,
            reports: [
              ...record.reports,
              {
                __typename__: "UnknownChunkReport",
                id: "bad",
                start_offset: 10,
                end_offset: 21,
                size: 11,
              },
            ],
          },
        ],
        context,
      ),
    ).toThrow("bounds");
    expect(() => normalizeUnblobReport([record, record], context)).toThrow(
      "exactly one",
    );
  });
  it("rejects empty, combined and extracting Binwalk reports", () => {
    const record = {
      Analysis: { file_path: context.inputPath, file_map: [], extractions: {} },
    };
    expect(normalizeBinwalkReport([record], context.inputPath, 20)).toEqual([]);
    for (const report of [
      [],
      [record, record],
      [
        {
          Analysis: {
            ...record.Analysis,
            extractions: { hit: { status: "success" } },
          },
        },
      ],
    ])
      expect(() =>
        normalizeBinwalkReport(report, context.inputPath, 20),
      ).toThrow();
  });
});

describe("Binwalk firmware region normalization and bounds", () => {
  it("normalizes reported firmware signature regions across valid offsets", () => {
    const hits = [
      {
        id: "uimage-1",
        offset: 0,
        size: 64,
        name: "uimage",
        description: "u-boot legacy uImage header",
        confidence: 100,
        always_display: true,
        extraction_declined: false,
      },
      {
        id: "gzip-1",
        offset: 64,
        size: 100,
        name: "gzip",
        description: "gzip compressed data",
        confidence: 90,
        always_display: false,
        extraction_declined: false,
      },
    ];
    const record = {
      Analysis: {
        file_path: context.inputPath,
        file_map: hits,
        extractions: {},
      },
    };
    const regions = normalizeBinwalkReport([record], context.inputPath, 200);
    expect(regions).toEqual([
      {
        provider_id: "uimage-1",
        offset: 0,
        reported_size: 64,
        signature: "uimage",
        description: "u-boot legacy uImage header",
        reported_confidence: 100,
        size_basis: "provider_reported_validation_unknown",
      },
      {
        provider_id: "gzip-1",
        offset: 64,
        reported_size: 100,
        signature: "gzip",
        description: "gzip compressed data",
        reported_confidence: 90,
        size_basis: "provider_reported_validation_unknown",
      },
    ]);
  });

  it("rejects Binwalk reported regions outside the selected file bounds", () => {
    const atEofZeroSize = {
      Analysis: {
        file_path: context.inputPath,
        file_map: [
          {
            id: "overflow-0",
            offset: 20,
            size: 0,
            name: "sig",
            description: "starts at eof with zero size",
            confidence: 50,
            always_display: true,
            extraction_declined: false,
          },
        ],
        extractions: {},
      },
    };
    expect(() =>
      normalizeBinwalkReport([atEofZeroSize], context.inputPath, 20),
    ).toThrow("outside the selected file");

    const pastEof = {
      Analysis: {
        file_path: context.inputPath,
        file_map: [
          {
            id: "overflow-2",
            offset: 10,
            size: 15,
            name: "sig",
            description: "extends past eof",
            confidence: 50,
            always_display: true,
            extraction_declined: false,
          },
        ],
        extractions: {},
      },
    };
    expect(() =>
      normalizeBinwalkReport([pastEof], context.inputPath, 20),
    ).toThrow("outside the selected file");
  });

  it("rejects Binwalk reports with mismatched input file paths", () => {
    const mismatched = {
      Analysis: {
        file_path: "/different/path.bin",
        file_map: [],
        extractions: {},
      },
    };
    expect(() =>
      normalizeBinwalkReport([mismatched], context.inputPath, 20),
    ).toThrow(
      "Expected one inspection-only report for the selected immutable input",
    );
  });
});
