import { access, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const readJson = async (path) =>
  JSON.parse(await readFile(join(root, path), "utf8"));

const packageJson = await readJson("package.json");

async function checkRegistryMetadata() {
  const fail = (message) => {
    throw new Error(`MCP Registry metadata is invalid: ${message}`);
  };
  const serverJson = await readJson("server.json");
  const registryPackage = serverJson.packages?.[0];

  if (packageJson.name !== "rea-agents") fail("unexpected npm package name");
  if (typeof packageJson.version !== "string")
    fail("package.json is missing a string version");
  if (packageJson.mcpName !== "io.github.morluto/rea")
    fail("package.json mcpName does not identify io.github.morluto/rea");
  if (serverJson.name !== packageJson.mcpName)
    fail("server.json name does not match package.json mcpName");
  if (serverJson.version !== packageJson.version)
    fail("server.json version does not match package.json version");
  if (!Array.isArray(serverJson.packages) || serverJson.packages.length !== 1)
    fail("server.json must describe exactly one npm package");
  if (registryPackage === undefined)
    fail("server.json is missing its npm package");
  if (registryPackage.registryType !== "npm")
    fail("server.json package must use the npm registry");
  if (registryPackage.registryBaseUrl !== "https://registry.npmjs.org")
    fail("server.json package must use the public npm registry");
  if (registryPackage.identifier !== packageJson.name)
    fail("server.json package identifier does not match package.json name");
  if (registryPackage.version !== packageJson.version)
    fail("server.json package version does not match package.json version");
  if (registryPackage.runtimeHint !== "npx")
    fail("server.json package must declare the npx runtime");
  if (registryPackage.transport?.type !== "stdio")
    fail("server.json package must declare stdio transport");
  if (
    !Array.isArray(registryPackage.packageArguments) ||
    registryPackage.packageArguments.length !== 1 ||
    registryPackage.packageArguments[0]?.type !== "positional" ||
    registryPackage.packageArguments[0]?.value !== "mcp"
  )
    fail("server.json package must launch the existing mcp command");
}

async function checkKimiPluginManifest() {
  const fail = (message) => {
    throw new Error(`Kimi plugin manifest is invalid: ${message}`);
  };
  const manifest = await readJson("kimi.plugin.json");
  const server = manifest.mcpServers?.rea;

  if (manifest.name !== "rea") fail('manifest name must be "rea"');
  if (manifest.version !== packageJson.version)
    fail("manifest version does not match package.json version");
  if (server === undefined) fail("manifest must declare mcpServers.rea");
  if (server.command !== "npx") fail("rea server must launch through npx");
  if (
    !Array.isArray(server.args) ||
    server.args.join(" ") !==
      `-y ${packageJson.name}@${packageJson.version} mcp`
  )
    fail("rea server args must pin the package.json version");
  if (
    server._releasePleaseStart !== "x-release-please-start-version" ||
    server._releasePleaseEnd !== "x-release-please-end"
  )
    fail("rea server must keep the release-please block markers around args");
  if (server.env?.REA_MCP_INPUT_SCHEMA_PROFILE !== "compact")
    fail("rea server must advertise the compact input schema profile");
  if (server.deferred !== true)
    fail("rea server must defer tool loading (deferred: true)");
  if (
    !Number.isInteger(server.startupTimeoutMs) ||
    !Number.isInteger(server.toolTimeoutMs)
  )
    fail("rea server must declare integer startupTimeoutMs and toolTimeoutMs");

  const skillPaths = Array.isArray(manifest.skills)
    ? manifest.skills
    : [manifest.skills];
  if (skillPaths.length === 0)
    fail("manifest must declare at least one skills path");
  for (const skillPath of skillPaths) {
    if (typeof skillPath !== "string" || !skillPath.startsWith("./"))
      fail(`skills path must start with "./": ${String(skillPath)}`);
  }
  const authoredSkill = join(
    root,
    ".agents/skills/reverse-engineer-anything/SKILL.md",
  );
  try {
    await access(authoredSkill);
  } catch {
    fail("authored reverse-engineer-anything skill is missing");
  }
}

await checkRegistryMetadata();
await checkKimiPluginManifest();

process.stdout.write(
  `Release metadata is aligned for ${packageJson.name}@${packageJson.version}.\n`,
);
