import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { createMcpLifecycle } from "./mcp-lifecycle.mjs";

const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
};
const harness = (options = {}) => {
  const response = deferred();
  const sent = deferred();
  const sendGate = options.sendGate;
  const notifications = [];
  const requests = [];
  const transport = {
    stderr: new EventEmitter(),
    async send(message) {
      if (message.method === "tools/call") {
        sent.resolve();
        if (sendGate) await sendGate.promise;
      }
    },
  };
  const client = {
    async callTool(params, requestOptions) {
      requests.push({ params, options: requestOptions });
      await transport.send({
        jsonrpc: "2.0",
        id: options.requestId ?? "server-selected-id:73",
        method: "tools/call",
        params,
      });
      return response.promise;
    },
    async notification(message) {
      notifications.push(message);
      await transport.send({ jsonrpc: "2.0", ...message });
    },
  };
  const lifecycle = createMcpLifecycle({
    client,
    transport,
    ...options,
  });
  return { lifecycle, transport, response, sent, notifications, requests };
};

test("cancellation between calls is persistent and starts no later request", async () => {
  const { lifecycle, requests } = harness();
  lifecycle.cancel("SIGINT");
  assert.throws(lifecycle.throwIfCancelled, /SIGINT/);
  await assert.rejects(lifecycle.call("capture", {}), /SIGINT/);
  assert.equal(requests.length, 0);
  assert.equal(lifecycle.state().safe_to_close, true);
});

test("a simulated final reply remains available after cancellation with the observed RPC id", async () => {
  const sendGate = deferred();
  const { lifecycle, response, sent, notifications, requests } = harness({
    sendGate,
    requestId: 0,
  });
  let resolved = false;
  const call = lifecycle.call("capture", {}).then((reply) => {
    resolved = true;
    return reply;
  });
  await sent.promise;
  lifecycle.cancel("SIGTERM");
  assert.equal(notifications.length, 0);
  assert.equal(lifecycle.state().request_id, 0);
  assert.equal(lifecycle.state().safe_to_close, false);
  sendGate.resolve();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(notifications, [
    {
      method: "notifications/cancelled",
      params: { requestId: 0, reason: "SIGTERM" },
    },
  ]);
  assert.equal(resolved, false);
  assert.equal(lifecycle.state().settled, false);
  assert.deepEqual(requests[0].options, { timeout: 90000 });
  lifecycle.cancel("repeated signal");
  assert.equal(notifications.length, 1);
  const raw = { isError: true, structuredContent: { cleanup: "verified" } };
  response.resolve(raw);
  assert.equal(await call, raw);
  assert.equal(lifecycle.state().safe_to_close, true);
  await assert.rejects(lifecycle.call("later", {}), /SIGTERM/);
});

test("deadline sends cancellation without discarding a simulated final reply", async () => {
  const { lifecycle, response, sent, notifications } = harness({
    cancel_after_ms: 5,
    request_timeout_ms: 50,
  });
  const call = lifecycle.call("capture", {});
  await sent.promise;
  await new Promise((resolve) => setTimeout(resolve, 15));
  assert.equal(notifications.length, 1);
  assert.equal(lifecycle.state().settled, false);
  response.resolve({ content: [] });
  assert.deepEqual(await call, { content: [] });
});

// Exercise the installed SDK's actual cancelled-reply suppression. The handler
// and ownership gate model work completion; they start no Electron processes.
const suppressedReplyHarness = async (context) => {
  const started = deferred();
  const cancelled = deferred();
  const releaseWork = deferred();
  const workDrained = deferred();
  const verifyStarted = deferred();
  const verifyOwnership = deferred();
  const serverMessages = [];
  let captureCalls = 0;
  let drainCalls = 0;
  let originalSettlement = "pending";
  const server = new McpServer({
    name: "cancel-suppression-test",
    version: "1",
  });
  server.registerTool(
    "capture",
    { inputSchema: z.strictObject({}) },
    async (_args, request) => {
      captureCalls += 1;
      request.mcpReq.signal.addEventListener(
        "abort",
        () => cancelled.resolve(),
        { once: true },
      );
      started.resolve();
      await releaseWork.promise;
      workDrained.resolve();
      return { content: [{ type: "text", text: "work completed" }] };
    },
  );
  server.registerTool(
    "drain",
    { inputSchema: z.strictObject({}) },
    async () => {
      drainCalls += 1;
      await workDrained.promise;
      return { content: [{ type: "text", text: "work drained" }] };
    },
  );
  const client = new Client({
    name: "cancel-suppression-client",
    version: "1",
  });
  const [transport, serverTransport] = InMemoryTransport.createLinkedPair();
  const serverSend = serverTransport.send.bind(serverTransport);
  serverTransport.send = async (message, ...options) => {
    serverMessages.push(message);
    return serverSend(message, ...options);
  };
  await server.connect(serverTransport);
  await client.connect(transport);
  context.after(async () => {
    releaseWork.resolve();
    verifyOwnership.resolve();
    await client.close();
    await server.close();
  });
  const callTool = client.callTool.bind(client);
  client.callTool = (params, options) => {
    const pending = callTool(params, options);
    if (params.name === "capture")
      void pending.then(
        () => {
          originalSettlement = "resolved";
        },
        () => {
          originalSettlement = "rejected";
        },
      );
    return pending;
  };
  const lifecycle = createMcpLifecycle({
    client,
    transport,
    verify_cancelled: async () => {
      verifyStarted.resolve();
      const reply = await client.callTool({ name: "drain", arguments: {} });
      assert.equal(reply.content[0].text, "work drained");
      return verifyOwnership.promise;
    },
  });
  return {
    lifecycle,
    started,
    cancelled,
    releaseWork,
    verifyStarted,
    verifyOwnership,
    serverMessages,
    counts: () => ({ captureCalls, drainCalls, originalSettlement }),
  };
};

test(
  "actual SDK cancellation suppresses the original reply until independent verification permits close",
  { timeout: 3000 },
  async (context) => {
    const fixture = await suppressedReplyHarness(context);
    const {
      lifecycle,
      started,
      cancelled,
      releaseWork,
      verifyStarted,
      verifyOwnership,
    } = fixture;
    let settled = false;
    const call = lifecycle.call("capture", {});
    void call.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    await started.promise;
    lifecycle.cancel("stop capture");
    await cancelled.promise;
    await verifyStarted.promise;
    assert.equal(lifecycle.state().safe_to_close, false);
    assert.equal(lifecycle.state().settled, false);
    assert.equal(settled, false);
    releaseWork.resolve();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(fixture.counts().drainCalls, 1);
    assert.equal(fixture.counts().originalSettlement, "pending");
    assert.equal(lifecycle.state().reply_received, false);
    assert.equal(lifecycle.state().safe_to_close, false);
    assert.equal(settled, false);
    const verification = {
      status: "verified",
      drain: "completed",
      ownership: "absent",
    };
    verifyOwnership.resolve(verification);
    await assert.rejects(
      call,
      (error) =>
        error.code === "cancelled_verified" &&
        error.verification === verification,
    );
    const state = lifecycle.state();
    assert.equal(state.safe_to_close, true);
    assert.equal(state.settled, true);
    assert.equal(state.reply_received, false);
    assert.deepEqual(state.cancellation_verification, verification);
    assert.equal(fixture.counts().originalSettlement, "pending");
    assert.ok(
      !fixture.serverMessages.some(
        (message) => message.id === state.request_id,
      ),
    );
    await assert.rejects(lifecycle.call("capture", {}), /stop capture/);
    assert.equal(fixture.counts().captureCalls, 1);
  },
);

test(
  "failed independent verification leaves suppressed-reply cancellation unsafe and permanent",
  { timeout: 3000 },
  async (context) => {
    const fixture = await suppressedReplyHarness(context);
    const {
      lifecycle,
      started,
      cancelled,
      releaseWork,
      verifyStarted,
      verifyOwnership,
    } = fixture;
    const call = lifecycle.call("capture", {});
    await started.promise;
    lifecycle.cancel("stop capture");
    await cancelled.promise;
    await verifyStarted.promise;
    releaseWork.resolve();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(fixture.counts().drainCalls, 1);
    assert.equal(lifecycle.state().safe_to_close, false);
    assert.equal(lifecycle.state().reply_received, false);
    const cause = new Error("ownership could not be verified");
    const rejected = assert.rejects(call, (error) => error === cause);
    verifyOwnership.reject(cause);
    await rejected;
    const state = lifecycle.state();
    assert.equal(state.safe_to_close, false);
    assert.equal(state.settled, true);
    assert.equal(state.reply_received, false);
    assert.equal(state.cancellation_verification.status, "unverified");
    assert.match(
      state.cancellation_verification.reason,
      /ownership could not be verified/,
    );
    assert.equal(fixture.counts().originalSettlement, "pending");
    assert.ok(
      !fixture.serverMessages.some(
        (message) => message.id === state.request_id,
      ),
    );
    await assert.rejects(lifecycle.call("capture", {}), /stop capture/);
    assert.equal(fixture.counts().captureCalls, 1);
  },
);

test("SDK hard timeout after send leaves close unsafe and prevents another call", async () => {
  const { lifecycle, response, sent } = harness();
  const call = lifecycle.call("capture", {});
  await sent.promise;
  response.reject(new Error("SDK hard timeout"));
  await assert.rejects(call, /SDK hard timeout/);
  assert.equal(lifecycle.state().settled, true);
  assert.equal(lifecycle.state().safe_to_close, false);
  await assert.rejects(lifecycle.call("later", {}), /not confirmed settlement/);
});

test("a concurrent call is rejected even before the first SDK send", async () => {
  const gate = deferred();
  let calls = 0;
  const transport = { async send() {} };
  const client = {
    async callTool() {
      calls += 1;
      return gate.promise;
    },
    async notification() {},
  };
  const lifecycle = createMcpLifecycle({ client, transport });
  const first = lifecycle.call("capture", {});
  await assert.rejects(
    lifecycle.call("another", {}),
    /not confirmed settlement/,
  );
  assert.equal(calls, 1);
  gate.resolve({ content: [] });
  await first;
});

test("a failed cancellation notification stays visible until the request settles", async () => {
  const gate = deferred();
  const transport = { async send() {} };
  const client = {
    async callTool(params) {
      await transport.send({
        id: "rpc:unknown-ordinal",
        method: "tools/call",
        params,
      });
      return gate.promise;
    },
    async notification() {
      throw new Error("notification write failed");
    },
  };
  const lifecycle = createMcpLifecycle({ client, transport });
  const call = lifecycle.call("capture", {});
  lifecycle.cancel("stop");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(lifecycle.state().request_id, "rpc:unknown-ordinal");
  assert.equal(lifecycle.state().cancellation_notification, "failed");
  assert.match(lifecycle.state().notification_failure, /write failed/);
  assert.equal(lifecycle.state().safe_to_close, false);
  gate.resolve({ content: [] });
  await call;
});

test("cancellation before an SDK send prevents the tool request from reaching transport", async () => {
  const gate = deferred();
  let sent = 0;
  const transport = {
    async send() {
      sent += 1;
    },
  };
  const client = {
    async callTool(params) {
      await gate.promise;
      await transport.send({ id: 17, method: "tools/call", params });
      return { content: [] };
    },
    async notification() {},
  };
  const lifecycle = createMcpLifecycle({ client, transport });
  const call = lifecycle.call("capture", {});
  lifecycle.cancel("stop before send");
  gate.resolve();
  await assert.rejects(call, /stop before send/);
  assert.equal(sent, 0);
  assert.equal(lifecycle.state().safe_to_close, true);
});

test("stderr keeps a copied continuous prefix and drains oversized later chunks", () => {
  const { lifecycle, transport } = harness({ stderr_limit: 8 });
  const first = Buffer.from("abc");
  transport.stderr.emit("data", first);
  first.fill(120);
  transport.stderr.emit("data", Buffer.from("defghijklmnopqrstuvwxyz"));
  transport.stderr.emit("data", Buffer.from("!"));
  const snapshot = lifecycle.stderrSnapshot();
  assert.equal(snapshot.bytes.toString(), "abcdefgh");
  assert.equal(snapshot.total_bytes, 27);
  assert.equal(snapshot.retained_bytes, 8);
  assert.equal(snapshot.dropped_bytes, 19);
  assert.equal(snapshot.status, "truncated");
  snapshot.bytes.fill(0);
  assert.equal(lifecycle.stderrSnapshot().bytes.toString(), "abcdefgh");
});
