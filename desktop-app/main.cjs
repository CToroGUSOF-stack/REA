/* oxlint-disable typescript/no-var-requires */
const { app, BrowserWindow, dialog, ipcMain, shell } = require("electron");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");

const isDev = !app.isPackaged;
const ghidraLauncherPath = "D:\\Ghirdra\\ghirdra\\ghidraRun.bat";
const ghidraInstallDir = path.dirname(ghidraLauncherPath);

if (process.env.GHIDRA_INSTALL_DIR === undefined) {
  process.env.GHIDRA_INSTALL_DIR = ghidraInstallDir;
}

function createWindow() {
  const window = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 1080,
    minHeight: 720,
    backgroundColor: "#09111f",
    title: "REA — Reverse Engineer Anything",
    show: false,
    titleBarStyle: "hidden",
    titleBarOverlay: {
      color: "#09111f",
      symbolColor: "#9aabc2",
      height: 36,
    },
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  window.loadFile(path.join(__dirname, "index.html"));
  window.once("ready-to-show", () => window.show());
  if (isDev) window.webContents.openDevTools({ mode: "detach" });
}

ipcMain.handle("choose-target", async () => {
  const result = await dialog.showOpenDialog({
    title: "Choose an investigation target",
    properties: ["openFile", "openDirectory"],
    filters: [
      {
        name: "All supported targets",
        extensions: ["exe", "dll", "asar", "apk", "ipa", "zip", "js", "json"],
      },
      { name: "All files", extensions: ["*"] },
    ],
  });
  return result.canceled ? null : (result.filePaths[0] ?? null);
});

function runReaCommand(arguments_, onLine) {
  return new Promise((resolve, reject) => {
    const commandArguments = ["-y", "rea-agents@latest", ...arguments_];
    const environment = Object.fromEntries(
      Object.entries({
        ...process.env,
        GHIDRA_INSTALL_DIR: process.env.GHIDRA_INSTALL_DIR,
        REA_GHIDRA_STARTUP_TIMEOUT_MS:
          process.env.REA_GHIDRA_STARTUP_TIMEOUT_MS ?? "900000",
        REA_LOG_LEVEL: "silent",
      }).filter(([, value]) => value !== undefined),
    );
    const child =
      process.platform === "win32"
        ? spawnWindowsCommand("npx.cmd", commandArguments, environment)
        : spawn("npx", commandArguments, {
            env: environment,
            windowsHide: true,
          });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      for (const line of chunk.split(/\r?\n/)) {
        if (!line.trim()) continue;
        try {
          const parsed = JSON.parse(line);
          onLine(parsed.rea_progress ?? parsed);
        } catch {
          onLine({ message: line });
        }
      }
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve({ stdout, stderr });
      } else {
        reject(
          new Error(stderr.trim() || `REA analysis exited with code ${code}`),
        );
      }
    });
  });
}

function quoteWindowsCommandToken(value) {
  if (/["\r\n]/u.test(value)) {
    throw new Error(
      "The selected target path contains unsupported quote or newline characters.",
    );
  }
  return `"${value}"`;
}

function spawnWindowsCommand(command, arguments_, env) {
  const comSpec =
    env.ComSpec ??
    env.COMSPEC ??
    process.env.ComSpec ??
    process.env.COMSPEC ??
    "C:\\Windows\\System32\\cmd.exe";
  const commandLine = `call ${[command, ...arguments_]
    .map((value) => quoteWindowsCommandToken(String(value)))
    .join(" ")}`;
  return spawn(comSpec, ["/d", "/c", commandLine], {
    env,
    windowsHide: true,
    windowsVerbatimArguments: true,
  });
}

ipcMain.handle("analyze-target", async (event, targetPath) => {
  const stat = await fsp.stat(targetPath);
  const extension = path.extname(targetPath).toLowerCase();
  const isJavaScriptTarget =
    stat.isDirectory() ||
    extension === ".asar" ||
    extension === ".js" ||
    extension === ".json";
  const arguments_ = isJavaScriptTarget
    ? ["analyze-javascript-application", targetPath, "--json"]
    : ["analyze", targetPath, "--provider", "ghidra", "--json"];
  event.sender.send("analysis-progress", {
    phase: "analysis",
    message: isJavaScriptTarget
      ? "Tracing JavaScript and Electron application structure…"
      : "Opening the native target with Ghidra…",
  });
  const result = await runReaCommand(arguments_, (message) => {
    event.sender.send("analysis-progress", {
      phase: "analysis",
      message: message.message ?? "Analyzing target…",
    });
  });
  const outputLines = result.stdout.trim().split(/\r?\n/).filter(Boolean);
  let parsed = undefined;
  for (let index = outputLines.length - 1; index >= 0; index -= 1) {
    try {
      const candidate = JSON.parse(outputLines[index]);
      if (candidate.rea_progress === undefined) {
        parsed = candidate;
        break;
      }
    } catch {
      continue;
    }
  }
  parsed ??= {
    status: "completed",
    output: result.stdout.trim(),
    stderr: result.stderr.trim(),
  };
  return {
    targetPath,
    targetName: path.basename(targetPath),
    route: isJavaScriptTarget ? "javascript/electron" : "native/ghidra",
    report: parsed,
  };
});

ipcMain.handle("choose-rebuild-directory", async () => {
  const result = await dialog.showOpenDialog({
    title: "Choose where to create the open-source rebuild",
    properties: ["openDirectory", "createDirectory"],
  });
  return result.canceled ? null : (result.filePaths[0] ?? null);
});

ipcMain.handle(
  "create-rebuild",
  async (event, { destination, investigation }) => {
    const projectName = `${path
      .basename(investigation.targetPath)
      .replace(/[^a-z0-9]+/gi, "-")
      .replace(/^-|-$/g, "")
      .toLowerCase()}-rebuild`;
    const projectRoot = path.join(destination, projectName || "rea-rebuild");
    await fsp.mkdir(path.join(projectRoot, "src"), { recursive: true });
    const reportPath = path.join(
      projectRoot,
      "src",
      "investigation-report.json",
    );
    await fsp.writeFile(
      reportPath,
      JSON.stringify(investigation.report, null, 2),
    );
    await fsp.writeFile(
      path.join(projectRoot, "package.json"),
      JSON.stringify(
        {
          name: projectName || "rea-rebuild",
          version: "0.1.0",
          private: true,
          type: "module",
          scripts: { start: "node src/index.js" },
        },
        null,
        2,
      ),
    );
    await fsp.writeFile(
      path.join(projectRoot, "src", "index.js"),
      `// Clean-room rebuild scaffold generated from REA evidence.\n// This project intentionally does not copy source code, assets, or identifiers\n// from the analyzed target. Replace each TODO with independently authored code.\n\nimport report from './investigation-report.json' with { type: 'json' };\n\nconsole.log('Open-source rebuild workspace ready.');\nconsole.log('Target:', ${JSON.stringify(investigation.targetName)});\nconsole.log('Analysis route:', ${JSON.stringify(investigation.route)});\nconsole.log('Evidence keys:', Object.keys(report).length);\n`,
    );
    await fsp.writeFile(
      path.join(projectRoot, "README.md"),
      `# ${projectName || "REA rebuild"}\n\nThis is an independently authored open-source rebuild workspace generated from a local REA investigation of **${investigation.targetName}**.\n\n## Guardrails\n\n- This project is a clean-room implementation, not a source or asset copy.\n- Preserve only independently verified behavior and documented compatibility goals.\n- Replace synthetic scaffolding with original code, tests, UX, and assets.\n- Confirm that you have the right to study and rebuild the target before distribution.\n\n## Workflow\n\n1. Read \`src/investigation-report.json\` and separate observations from inferences.\n2. Write acceptance tests for the behavior you intend to support.\n3. Implement a better architecture and UX in \`src/\`.\n4. Add license, attribution, and third-party notices before publishing.\n\nThe report is evidence for engineering decisions, not original source code.\n`,
    );
    event.sender.send("analysis-progress", {
      phase: "rebuild",
      message: `Created clean-room rebuild workspace at ${projectRoot}`,
    });
    return { projectRoot };
  },
);

ipcMain.handle("open-folder", async (event, folderPath) => {
  await shell.openPath(folderPath);
  return true;
});

ipcMain.handle("system-info", () => ({
  platform: "Windows",
  release: os.release(),
  arch: os.arch(),
  node: process.versions.node,
  electron: process.versions.electron,
  ghidraInstallDir: process.env.GHIDRA_INSTALL_DIR,
  ghidraLauncherPath,
  ghidraAvailable:
    fs.existsSync(ghidraLauncherPath) &&
    fs.statSync(ghidraLauncherPath).isFile(),
}));

ipcMain.handle("open-docs", async () => {
  await shell.openExternal("https://github.com/morluto/rea#readme");
  return true;
});

app.whenReady().then(() => {
  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
