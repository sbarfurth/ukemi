import spawn from "cross-spawn";
import * as os from "os";
import fs from "fs/promises";
import path from "path";
import which from "which";
import * as vscode from "vscode";
import type { ChildProcess } from "child_process";
import { SemVer } from "../semver";
import { getConfig } from "../config";
import { getLogger } from "../logger";

export async function getJJVersion(jjPath: string): Promise<SemVer> {
  try {
    const version = (
      await handleCommand(
        spawn(jjPath, ["version"], {
          timeout: 5000,
        }),
      )
    )
      .toString()
      .trim();

    if (version.startsWith("jj")) {
      return SemVer.parse(version);
    }
  } catch {
    // Assume the version
  }
  return SemVer.default();
}

export async function getConfigArgs(
  extensionDir: string,
  jjVersion: SemVer,
): Promise<string[]> {
  const configPath = path.join(extensionDir, "config.toml");

  // Determine the config option and value based on jj version
  const configOption = jjVersion.isAtLeast(SemVer.parse("0.25.0"))
    ? "--config-file"
    : "--config-toml";

  if (configOption === "--config-toml") {
    try {
      const configValue = await fs.readFile(configPath, "utf8");
      return [configOption, configValue];
    } catch (e) {
      getLogger().error(
        `Failed to read config file at ${configPath}: ${String(e)}`,
      );
      throw e;
    }
  } else {
    return [configOption, configPath];
  }
}

/**
 * If ukemi.commandTimeout is set, returns that value.
 * Otherwise, returns the provided default timeout, or 30 seconds if no default is provided.
 */
export function getCommandTimeout(
  repositoryRoot: string,
  defaultTimeout: number | undefined,
): number {
  const { commandTimeout } = getConfig(vscode.Uri.file(repositoryRoot));
  if (commandTimeout !== null && commandTimeout !== undefined) {
    return commandTimeout;
  }
  return defaultTimeout ?? 30000;
}

/**
 * Gets the configured jj executable path from settings.
 * If no path is configured, searches through common installation paths before falling back to "jj".
 */
export async function getJJPath(
  workspaceFolder: string,
): Promise<{ filepath: string; source: "configured" | "path" | "common" }> {
  const { jjPath } = getConfig(
    workspaceFolder !== undefined
      ? vscode.Uri.file(workspaceFolder)
      : undefined,
  );

  if (jjPath) {
    if (await which(jjPath, { nothrow: true })) {
      return { filepath: jjPath, source: "configured" };
    } else {
      throw new Error(
        `Configured ukemi.jjPath is not an executable file: ${jjPath}`,
      );
    }
  }

  const jjInPath = await which("jj", { nothrow: true });
  if (jjInPath) {
    return { filepath: jjInPath, source: "path" };
  }

  // It's particularly important to check common locations on MacOS because of https://github.com/microsoft/vscode/issues/30847#issuecomment-420399383
  const commonPaths = [
    path.join(os.homedir(), ".cargo", "bin", "jj"),
    path.join(os.homedir(), ".cargo", "bin", "jj.exe"),
    path.join(os.homedir(), ".nix-profile", "bin", "jj"),
    path.join(os.homedir(), ".local", "bin", "jj"),
    path.join(os.homedir(), "bin", "jj"),
    "/usr/bin/jj",
    "/home/linuxbrew/.linuxbrew/bin/jj",
    "/usr/local/bin/jj",
    "/opt/homebrew/bin/jj",
    "/opt/local/bin/jj",
  ];

  for (const commonPath of commonPaths) {
    const jjInCommonPath = await which(commonPath, { nothrow: true });
    if (jjInCommonPath) {
      return { filepath: jjInCommonPath, source: "common" };
    }
  }

  throw new Error(`jj CLI not found in PATH nor in common locations.`);
}

export function spawnJJ(
  jjPath: string,
  args: string[],
  options: Parameters<typeof spawn>[2] & { cwd: string },
) {
  const finalOptions = {
    ...options,
    timeout: getCommandTimeout(options.cwd, options.timeout),
  };

  getLogger().debug(`spawn: ${jjPath} ${args.join(" ")}`, {
    spawnOptions: finalOptions,
  });

  return spawn(jjPath, args, finalOptions);
}

export function handleJJCommand(childProcess: ChildProcess) {
  return handleCommand(childProcess).catch(convertJJErrors);
}

export function handleCommand(childProcess: ChildProcess) {
  return new Promise<Buffer>((resolve, reject) => {
    const output: Buffer[] = [];
    const errOutput: Buffer[] = [];
    childProcess.stdout!.on("data", (data: Buffer) => {
      output.push(data);
    });
    childProcess.stderr!.on("data", (data: Buffer) => {
      errOutput.push(data);
    });
    childProcess.on("error", (error: Error) => {
      reject(new Error(`Spawning command failed: ${error.message}`));
    });
    childProcess.on("exit", (code, signal) => {
      if (code) {
        reject(
          new Error(
            `Command failed with exit code ${code}.\nstdout: ${Buffer.concat(output).toString()}\nstderr: ${Buffer.concat(errOutput).toString()}`,
          ),
        );
      } else if (signal) {
        reject(
          new Error(
            `Command failed with signal ${signal}.\nstdout: ${Buffer.concat(output).toString()}\nstderr: ${Buffer.concat(errOutput).toString()}`,
          ),
        );
      } else {
        resolve(Buffer.concat(output));
      }
    });
  });
}

export class ImmutableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ImmutableError";
  }
}

/**
 * Detects common error messages from jj and converts them to custom error instances to make them easier to selectively
 * handle.
 */
export function convertJJErrors(e: unknown): never {
  if (e instanceof Error) {
    if (e.message.includes("is immutable")) {
      throw new ImmutableError(e.message);
    }
  }
  throw e;
}
