import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { parseEvidence } from "../../../dist/domain/evidence.js";
import { hashAndroidFile } from "./digest.mjs";

const initializers = [
  {
    class_name: "fixture.InitializationPolicy",
    witnesses: [
      "declared-policy",
      "->singletonList",
      "->POLICY:Ljava/util/List;",
    ],
  },
  {
    class_name: "fixture.MixedInitialization",
    witnesses: ["field-value", "->LABEL:Ljava/lang/String;", "->touch()V"],
  },
];
const cases = [
  ...initializers.map((scenario) => ({
    ...scenario,
    method_name: "<clinit>",
    overload_index: 0,
    overload_count: 1,
    body_status: "available",
    representation: "smali",
    fell_back: true,
    markers: ["static_initializer_disassembly"],
  })),
  ...[
    ["fixture.NativeOverload", "readBuffer", 2, "native_method"],
    ["fixture.NativeOverload", "zLastNative", 1, "native_method"],
    ["fixture.AbstractShape", "area", 1, "abstract_method"],
  ].map(([class_name, method_name, overload_count, marker]) => ({
    class_name,
    method_name,
    overload_index: 0,
    overload_count,
    body_status: "not_available",
    representation: null,
    body_unavailable_reason: marker === "native_method" ? "native" : "abstract",
    fell_back: false,
    markers: [marker],
    witnesses: [],
  })),
  {
    class_name: "fixture.MergedMethod",
    method_name: "highlightText",
    overload_index: 0,
    overload_count: 2,
    body_status: "available",
    representation: "smali",
    fell_back: true,
    markers: ["java_body_unavailable"],
    witnesses: [".method private highlightText()V", "0x77", "if-nez", ".catch"],
  },
  {
    class_name: "fixture.MergedMethod",
    method_name: "highlightText",
    overload_index: 1,
    overload_count: 2,
    body_status: "available",
    representation: "java",
    fell_back: false,
    markers: [],
    witnesses: ["42"],
  },
  {
    class_name: "fixture.MergedMethod",
    method_name: "decoy",
    overload_index: 0,
    overload_count: 1,
    body_status: "available",
    representation: "java",
    fell_back: false,
    markers: [],
    witnesses: ["renamed from: highlightText,"],
  },
  {
    class_name: "fixture.NativeOverload",
    method_name: "readBuffer",
    overload_index: 1,
    overload_count: 2,
    body_status: "available",
    representation: "java",
    fell_back: false,
    markers: [],
    witnesses: ["readBuffer(byteBuffer, 0)"],
  },
];

/** Verify original method instructions, missing Java and parsed absence through both adapters. */
export const verifyAndroidMethodBodies = async ({
  apk,
  repository,
  entrypoint,
  environment,
  execute,
}) => {
  const digest = await hashAndroidFile(apk);
  const check = (value, scenario) => {
    const evidence = parseEvidence(value);
    assert.equal(evidence.subject.digest.sha256, digest);
    const result = evidence.normalized_result;
    assert.equal(result.class_name, scenario.class_name);
    assert.equal(result.method.name, scenario.method_name);
    assert.equal(result.method.overload_index, scenario.overload_index);
    assert.equal(result.overload_count, scenario.overload_count);
    assert.equal(result.body_status, scenario.body_status);
    assert.equal(result.representation, scenario.representation);
    assert.equal(
      result.body_unavailable_reason,
      scenario.body_unavailable_reason ?? null,
    );
    assert.equal(result.fell_back, scenario.fell_back);
    assert.deepEqual(result.markers, scenario.markers);
    if (scenario.body_status === "not_available")
      assert.equal(result.source.text, "");
    assert.equal(result.source.status, "complete");
    for (const witness of scenario.witnesses)
      assert.ok(
        result.source.text.includes(witness),
        `Missing method evidence: ${witness}`,
      );
    return evidence;
  };
  const flagCases = [
    {
      operation: "inspect_android_class",
      args: [],
      input: {},
      check: (result) => {
        const methods = new Map(
          result.methods.map((method) => [method.name, method]),
        );
        assert.equal(methods.get("nativeCall").access_flags, 0x101);
        assert.deepEqual(methods.get("nativeCall").access_flag_names, [
          "public",
          "native",
        ]);
        assert.equal(methods.get("missing").access_flags, 0x401);
        assert.deepEqual(methods.get("missing").access_flag_names, [
          "public",
          "abstract",
        ]);
        assert.equal(methods.get("generated").access_flags, 0x1049);
        assert.deepEqual(methods.get("generated").access_flag_names, [
          "public",
          "static",
          "bridge",
          "synthetic",
        ]);
      },
    },
    ...[
      ["nativeCall", "native"],
      ["missing", "abstract"],
      ["generated", null],
    ].map(([method, reason]) => ({
      operation: "inspect_android_method",
      args: [method],
      input: { method_name: method },
      check: (result) => {
        assert.equal(result.body_unavailable_reason, reason);
        assert.equal(
          result.body_status,
          reason === null ? "available" : "not_available",
        );
        assert.equal(result.representation, reason === null ? "java" : null);
        if (reason !== null) assert.equal(result.source.text, "");
      },
    })),
  ];
  const flagEvidence = [];
  for (const scenario of flagCases) {
    const response = await execute(
      process.execPath,
      [
        entrypoint,
        scenario.operation.replaceAll("_", "-"),
        apk,
        "fixture.AccessFlags",
        ...scenario.args,
        "--format",
        "json",
      ],
      {
        cwd: repository,
        env: environment,
        timeout: 150_000,
        maxBuffer: 8 * 1024 * 1024,
      },
    );
    const evidence = parseEvidence(JSON.parse(response.stdout));
    assert.equal(evidence.subject.digest.sha256, digest);
    scenario.check(evidence.normalized_result);
    flagEvidence.push(evidence);
  }
  const cli = new Map();
  for (const scenario of cases) {
    const response = await execute(
      process.execPath,
      [
        entrypoint,
        "inspect-android-method",
        apk,
        scenario.class_name,
        scenario.method_name,
        "--overload-index",
        String(scenario.overload_index),
        "--format",
        "json",
      ],
      {
        cwd: repository,
        env: environment,
        timeout: 150_000,
        maxBuffer: 8 * 1024 * 1024,
      },
    );
    cli.set(scenario, check(JSON.parse(response.stdout), scenario));
  }
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [entrypoint, "mcp"],
    cwd: repository,
    env: environment,
    stderr: "pipe",
  });
  let stderr = "";
  transport.stderr?.on("data", (chunk) => {
    stderr += chunk.toString();
  });
  const client = new Client({
    name: "rea-real-android-method-bodies",
    version: "1",
  });
  try {
    await client.connect(transport, { timeout: 30_000 });
    for (const [index, scenario] of flagCases.entries()) {
      const response = await client.callTool(
        {
          name: scenario.operation,
          arguments: {
            path: apk,
            class_name: "fixture.AccessFlags",
            ...scenario.input,
          },
        },
        { timeout: 150_000 },
      );
      assert.notEqual(response.isError, true, JSON.stringify(response));
      const evidence = parseEvidence(response.structuredContent);
      scenario.check(evidence.normalized_result);
      assert.deepEqual(
        evidence.normalized_result,
        flagEvidence[index].normalized_result,
      );
    }
    for (const scenario of cases) {
      const response = await client.callTool(
        {
          name: "inspect_android_method",
          arguments: {
            path: apk,
            class_name: scenario.class_name,
            method_name: scenario.method_name,
            overload_index: scenario.overload_index,
          },
        },
        { timeout: 150_000 },
      );
      assert.notEqual(response.isError, true, JSON.stringify(response));
      assert.equal(response.content.length, 1);
      assert.equal(response.content[0].type, "text");
      assert.deepEqual(
        JSON.parse(response.content[0].text),
        response.structuredContent,
      );
      const evidence = check(response.structuredContent, scenario);
      assert.deepEqual(
        evidence.normalized_result,
        cli.get(scenario).normalized_result,
      );
      assert.deepEqual(evidence.parameters, cli.get(scenario).parameters);
      assert.deepEqual(evidence.provider, cli.get(scenario).provider);
    }
    await client.ping();
  } catch (cause) {
    process.stderr.write(stderr);
    throw cause;
  } finally {
    await client.close();
  }
  assert.equal(
    await hashAndroidFile(apk),
    digest,
    "Static inspection changed fixture bytes",
  );
  console.log(
    "PASS real CLI/MCP original method bodies, absence facts, identity, parity and unchanged APK",
  );
};
