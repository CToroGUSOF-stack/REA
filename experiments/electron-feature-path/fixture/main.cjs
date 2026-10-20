/* oxlint-disable typescript/no-var-requires -- The fixture exercises Electron CommonJS main-hook and sandboxed-preload interop. */
const { app, BrowserWindow, ipcMain } = require("electron");
const { writeFile } = require("node:fs/promises");
const { join } = require("node:path");
const { pathToFileURL } = require("node:url");

const applicationIndex = process.argv.indexOf(__filename);
if (applicationIndex < 0)
  throw new Error("The fixture entry point is missing from argv.");
const outputRoot = process.argv[applicationIndex + 1];
const baseline = process.argv[applicationIndex + 2] === "baseline";
app.setPath("userData", join(outputRoot, "profile"));
app.whenReady().then(async () => {
  const { createRecorder } = await import(
    pathToFileURL(join(__dirname, "..", "recorder.mjs")).href
  );
  const result = createRecorder({
    channels: ["prototype:export"],
    file_paths: [join(outputRoot, "result.txt")],
    retention_bytes: 64 * 1024,
  });
  if (!result.ok) throw new Error(result.error.message);
  const recorder = result.value;
  const writer = baseline
    ? writeFile
    : recorder.wrapFileWriter(writeFile).value;
  const handler = async (_event, value) => {
    await writer(join(outputRoot, "result.txt"), value, "utf8");
    return "exported";
  };
  ipcMain.handle(
    "prototype:export",
    baseline
      ? handler
      : recorder.wrapHandler("prototype:export", handler).value,
  );
  // An explicit second round trip exports observations after the first handler
  // completed. No timing-based assumption links the UI action to invocation IDs.
  ipcMain.handle("prototype:flush", async () => {
    await writeFile(
      join(outputRoot, "trace.json"),
      JSON.stringify(recorder.snapshot()),
    );
    return "flushed";
  });
  const window = new BrowserWindow({
    webPreferences: { preload: join(__dirname, "preload.cjs") },
  });
  await window.loadFile(join(__dirname, "renderer.html"));
  // A fixture-owned readiness receipt for cancellation verification.
  await writeFile(
    join(outputRoot, "ownership.json"),
    JSON.stringify({
      run_id: process.env.REA_PROCESS_RUN_ID,
      launcher_pid: process.pid,
      electron_version: process.versions.electron,
    }),
  );
  await writeFile(join(outputRoot, "ready"), "ready");
});
