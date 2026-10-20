import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Entry point for the Claude Code plugin MCP server. A development checkout
// runs the local build; an npm-sourced plugin install ships without its
// dependencies, so fall back to the published package pinned to the version
// this plugin ships with.
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
// Check the entry the mcp mode actually imports: a checkout with a partial
// build must fall back to the published package instead of failing to start.
const hasLocalRuntime =
  existsSync(join(packageRoot, "scripts/rea.mjs")) &&
  existsSync(join(packageRoot, "dist/mcp/main.js")) &&
  existsSync(join(packageRoot, "node_modules"));
const { default: packageJson } = await import("../package.json", {
  with: { type: "json" },
});

const child = hasLocalRuntime
  ? spawn(process.execPath, [join(packageRoot, "scripts/rea.mjs"), "mcp"], {
      stdio: "inherit",
      detached: process.platform !== "win32",
    })
  : spawn("npx", ["-y", `${packageJson.name}@${packageJson.version}`, "mcp"], {
      stdio: "inherit",
      detached: process.platform !== "win32",
      // Windows resolves `npx` through `npx.cmd`, which spawn only finds via a shell.
      shell: process.platform === "win32",
    });

// The launcher owns the whole server tree: the win32 fallback wraps `npx` in a
// shell, and POSIX `npx` itself spawns the server, so killing only the direct
// child would leave the server running past shutdown.
const stopChild = (signal) => {
  if (process.platform === "win32") {
    spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
      stdio: "ignore",
    });
    return;
  }
  try {
    process.kill(-child.pid, signal);
  } catch {
    child.kill(signal);
  }
};
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    stopChild(signal);
  });
}
child.on("error", (error) => {
  console.error(`rea-mcp-launcher: ${error.message}`);
  process.exitCode = 1;
});
child.on("exit", (code) => {
  process.exit(code ?? 1);
});
