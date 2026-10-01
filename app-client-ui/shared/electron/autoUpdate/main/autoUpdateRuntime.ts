import type { AutoUpdateResolution, AutoUpdateRuntimeFacts } from "./autoUpdate.types";

export class AutoUpdateRuntime
{
  static resolve(facts: AutoUpdateRuntimeFacts): AutoUpdateResolution
  {
    if (!facts.packaged)
      return { mode: "off", reason: "Development run: install a packaged release to get updates." };
    else if (facts.platform === "win32" && facts.portable)
      return { mode: "notify", reason: "Portable build: download new versions from the release page." };
    else if (facts.platform === "win32")
      return { mode: "automatic", reason: "Installed Windows build." };
    else if (facts.platform === "darwin")
      return { mode: "notify", reason: "Unsigned macOS build: download new versions from the release page." };
    else if (facts.platform === "linux")
      return { mode: "automatic", reason: "Packaged Linux build." };
    else
      throw new Error(`Unsupported update platform: ${facts.platform}`);
  }
}
