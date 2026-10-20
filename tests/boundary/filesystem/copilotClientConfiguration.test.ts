import { join, resolve } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { supportedClients } from "../../../src/application/SupportedClients.js";
import { clearClientLocationEnvironment } from "../../fixtures/clientEnvironment.js";

beforeEach(clearClientLocationEnvironment);
afterEach(() => vi.unstubAllEnvs());

const copilotClient = (
  env: Parameters<typeof supportedClients>[2],
  platform: NodeJS.Platform = "linux",
) =>
  supportedClients(resolve("/home/a"), platform, env).find(
    ({ name }) => name === "copilot_cli",
  );

describe("Copilot CLI configuration paths", () => {
  it.each([[undefined], [""], [" \t "]])(
    "treats %j COPILOT_HOME as unset",
    (override) => {
      const home = resolve("/home/a");
      const environment = { COPILOT_HOME: override };
      expect(copilotClient(environment)).toMatchObject({
        configPath: join(home, ".copilot", "mcp-config.json"),
        markerPath: join(home, ".copilot"),
      });
    },
  );

  it("honours a non-empty COPILOT_HOME", () => {
    const home = resolve("/home/a");
    const environment = { COPILOT_HOME: "/custom/copilot" };
    expect(copilotClient(environment)).toMatchObject({
      configPath: join("/custom/copilot", "mcp-config.json"),
      markerPath: "/custom/copilot",
    });
  });
});
