const validateLimits = (stderr_limit, cancel_after_ms, request_timeout_ms) => {
  if (!Number.isSafeInteger(stderr_limit) || stderr_limit < 0)
    throw new TypeError("stderr_limit must be a nonnegative safe integer.");
  if (
    !Number.isSafeInteger(cancel_after_ms) ||
    cancel_after_ms < 1 ||
    cancel_after_ms > 2147483647 ||
    !Number.isSafeInteger(request_timeout_ms) ||
    request_timeout_ms > 2147483647 ||
    request_timeout_ms <= cancel_after_ms
  )
    throw new TypeError(
      "Request timeout must exceed the cancellation deadline.",
    );
};

const retainStderr = (transport, stderr_limit) => {
  const prefix = Buffer.alloc(stderr_limit);
  let totalBytes = 0;
  let retainedBytes = 0;
  transport.stderr?.on("data", (chunk) => {
    totalBytes += chunk.length;
    const count = Math.min(chunk.length, stderr_limit - retainedBytes);
    chunk.copy(prefix, retainedBytes, 0, count);
    retainedBytes += count;
  });

  return () => ({
    bytes: Buffer.from(prefix.subarray(0, retainedBytes)),
    total_bytes: totalBytes,
    retained_bytes: retainedBytes,
    dropped_bytes: totalBytes - retainedBytes,
    status: totalBytes > retainedBytes ? "truncated" : "complete",
  });
};

const projectState = (current, cancelled) => ({
  request_id: current?.requestId ?? null,
  settled: current?.settled ?? true,
  cancelled,
  safe_to_close: current?.safeToClose ?? true,
  reply_received: current?.replyReceived ?? false,
  cancellation_verification: current?.verification ?? null,
  cancellation_notification: current?.notificationStatus ?? "not-sent",
  ...(current?.notificationFailure === undefined
    ? {}
    : { notification_failure: current.notificationFailure }),
});

const notifyCancellation = (client, request, cancelled, cancellationReason) => {
  if (
    !cancelled ||
    request.settled ||
    !request.sent ||
    request.requestId === null ||
    request.notificationStatus !== "not-sent"
  )
    return;
  request.notificationStatus = "pending";
  // Do not abort the SDK request: retain its final server reply after cleanup.
  void client
    .notification({
      method: "notifications/cancelled",
      params: { requestId: request.requestId, reason: cancellationReason },
    })
    .then(
      () => {
        request.notificationStatus = "sent";
        if (!request.settled && !request.replyReceived)
          request.verifyCancellation?.();
      },
      (cause) => {
        request.notificationStatus = "failed";
        request.notificationFailure = String(cause);
      },
    );
};

const verifyCancellation =
  (request, verify_cancelled, rejectCancellation) => async () => {
    try {
      // MCP servers may suppress the cancelled request's final reply. The
      // caller must independently drain work AND verify owned resources.
      request.verification = await verify_cancelled();
      request.safeToClose = true;
      const error = new Error(
        "Experiment cancelled; independent cleanup verified.",
      );
      error.code = "cancelled_verified";
      error.verification = request.verification;
      rejectCancellation(error);
    } catch (cause) {
      request.verification = {
        status: "unverified",
        reason: String(cause),
      };
      rejectCancellation(cause);
    }
  };

/** Cancellation and bounded stderr for this experiment's exclusively owned MCP transport. */
export function createMcpLifecycle({
  client,
  transport,
  stderr_limit = 65536,
  cancel_after_ms = 60000,
  request_timeout_ms = 90000,
  verify_cancelled,
}) {
  validateLimits(stderr_limit, cancel_after_ms, request_timeout_ms);

  const stderrSnapshot = retainStderr(transport, stderr_limit);

  let cancelled = false;
  let cancellationReason;
  let current;
  const state = () => projectState(current, cancelled);

  const throwIfCancelled = () => {
    if (cancelled)
      throw new Error(`Experiment cancelled: ${cancellationReason}`);
  };

  const cancel = (reason = "Caller requested cancellation") => {
    if (!cancelled) {
      cancelled = true;
      cancellationReason = String(reason);
    }
    if (current !== undefined)
      notifyCancellation(client, current, cancelled, cancellationReason);
  };

  const send = transport.send.bind(transport);
  transport.send = async (message, ...options) => {
    const request = current;
    const isSelectedRequest =
      request !== undefined &&
      !request.settled &&
      message.method === "tools/call" &&
      message.params?.name === request.name &&
      request.requestId === null &&
      (typeof message.id === "string" || typeof message.id === "number");
    if (isSelectedRequest) {
      throwIfCancelled();
      request.requestId = message.id;
      // A failed write may have partially reached the server; retain uncertainty.
      request.safeToClose = false;
    }
    const result = await send(message, ...options);
    if (isSelectedRequest) {
      request.sent = true;
      notifyCancellation(client, request, cancelled, cancellationReason);
    }
    return result;
  };

  const call = async (name, args) => {
    throwIfCancelled();
    if (current !== undefined && (!current.settled || !current.safeToClose))
      throw new Error("An earlier MCP request has not confirmed settlement.");
    const request = {
      name,
      requestId: null,
      sent: false,
      settled: false,
      safeToClose: true,
      notificationStatus: "not-sent",
      replyReceived: false,
    };
    let rejectCancellation;
    const cancellation = new Promise((_resolve, reject) => {
      rejectCancellation = reject;
    });
    if (verify_cancelled !== undefined)
      request.verifyCancellation = verifyCancellation(
        request,
        verify_cancelled,
        rejectCancellation,
      );
    current = request;
    const timer = setTimeout(
      () => cancel("Tool cancellation deadline elapsed"),
      cancel_after_ms,
    );
    try {
      const pending = client
        .callTool({ name, arguments: args }, { timeout: request_timeout_ms })
        .then((reply) => {
          // This means a server reply arrived, not that its cleanup claim passed.
          request.replyReceived = true;
          request.safeToClose = true;
          return reply;
        });
      return await Promise.race([pending, cancellation]);
    } finally {
      clearTimeout(timer);
      request.settled = true;
    }
  };

  return {
    call,
    cancel,
    throwIfCancelled,
    state,
    stderrSnapshot,
  };
}
