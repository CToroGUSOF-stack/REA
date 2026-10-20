"""Exercise the shipped bridge's request-frame bound over real socket pairs.

Four cases share one loaded bridge module:

- ``legit``: an ordinary authenticated request is served.
- ``at_limit``: a request whose line, including its terminator, is exactly the
  frame limit is still served, so the ceiling does not reject legitimate traffic.
- ``past_limit``: a peer writes one byte past the limit and never terminates the
  line. An unbounded line read cannot answer this at all, which is what makes
  Hopper allocate for as long as the peer keeps writing.
- ``stalled_line``: a peer fills the limit without a terminator, stops writing,
  and keeps the connection open. The bridge must refuse it at the ceiling
  without waiting for EOF, then close.
"""
import json
import socket
import sys
import threading

from hopperBridgeFacadeProbe import load_bridge

READ_TIMEOUT_SECONDS = 5


def _next_response(file):
    while True:
        line = file.readline()
        if not line:
            return {"closed": True}
        value = json.loads(line.decode("utf-8"))
        if "event" not in value:
            return value


def serve(bridge, line, read_after):
    """Send one raw line and record the bridge's answer."""
    server, client = socket.socketpair()
    worker = threading.Thread(target=bridge["_serve_connection"], args=(server,))
    worker.daemon = True
    worker.start()
    file = client.makefile("rwb")
    client.settimeout(READ_TIMEOUT_SECONDS)
    outcome = {}
    try:
        file.write(line)
        file.flush()
        outcome["reply"] = _next_response(file)
        if read_after:
            outcome["next"] = _next_response(file)
    except OSError as error:
        outcome["reply"] = {"socket_error": type(error).__name__}
    finally:
        try:
            file.close()
        finally:
            client.close()
    worker.join(2)
    outcome["thread_released"] = not worker.is_alive()
    return outcome


def request_line(bridge, params):
    request = {
        "id": 1,
        "token": bridge["REA_TOKEN"],
        "method": "health",
        "params": params,
    }
    return json.dumps(request, separators=(",", ":")).encode("utf-8")


def main():
    bridge = load_bridge(sys.argv[1])
    bridge.update(REA_TOKEN="owned-token", REA_RUN_ID="owned-run")
    bridge["_dispatch"] = lambda method, params: {
        "run_id": bridge["REA_RUN_ID"],
        "ready": True,
    }
    limit = bridge.get("MAX_REQUEST_BYTES")
    if not isinstance(limit, int) or isinstance(limit, bool) or limit <= 0:
        json.dump({"limit": limit}, sys.stdout)
        return

    legit = serve(bridge, request_line(bridge, {}) + b"\n", False)

    # A request whose line, including its terminator, is exactly the limit is
    # legitimate traffic and must still be served.
    padding = limit - 1 - len(request_line(bridge, {"padding": ""}))
    at_limit_line = request_line(bridge, {"padding": "p" * padding}) + b"\n"
    assert len(at_limit_line) == limit, len(at_limit_line)
    at_limit = serve(bridge, at_limit_line, False)

    # One byte past the limit, still unterminated and still open.
    past_limit = serve(bridge, b"x" * (limit + 1), False)

    # The limit filled without a terminator while the peer stays connected. No
    # unread bytes remain, so the refusal reaches the peer intact, and only a
    # bound that stops at the limit can answer: a larger bound waits here for a
    # byte the peer never sends.
    stalled_line = serve(bridge, b"x" * limit, True)

    json.dump(
        {
            "limit": limit,
            "legit": legit,
            "at_limit": at_limit,
            "past_limit": past_limit,
            "stalled_line": stalled_line,
        },
        sys.stdout,
    )


if __name__ == "__main__":
    main()
