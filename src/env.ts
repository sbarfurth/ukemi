import * as os from 'os';
import * as crypto from 'crypto';
import * as vscode from 'vscode';
import path from 'path';
import fs from 'fs/promises';

export let extensionDir = '';
export let fakeEditorPath = '';
export function initExtensionDir(extensionUri: vscode.Uri) {
  extensionDir = vscode.Uri.joinPath(
    extensionUri,
    extensionUri.fsPath.includes('extensions') ? 'dist' : 'src',
  ).fsPath;

  const fakeEditorExecutables: {
    [platform in typeof process.platform]?: {
      [arch in typeof process.arch]?: string;
    };
  } = {
    freebsd: {
      arm: 'fakeeditor_linux_arm',
      arm64: 'fakeeditor_linux_aarch64',
      x64: 'fakeeditor_linux_x86_64',
    },
    netbsd: {
      arm: 'fakeeditor_linux_arm',
      arm64: 'fakeeditor_linux_aarch64',
      x64: 'fakeeditor_linux_x86_64',
    },
    openbsd: {
      arm: 'fakeeditor_linux_arm',
      arm64: 'fakeeditor_linux_aarch64',
      x64: 'fakeeditor_linux_x86_64',
    },
    linux: {
      arm: 'fakeeditor_linux_arm',
      arm64: 'fakeeditor_linux_aarch64',
      x64: 'fakeeditor_linux_x86_64',
    },
    win32: {
      arm64: 'fakeeditor_windows_aarch64.exe',
      x64: 'fakeeditor_windows_x86_64.exe',
    },
    darwin: {
      arm64: 'fakeeditor_macos_aarch64',
      x64: 'fakeeditor_macos_x86_64',
    },
  };

  const fakeEditorExecutableName =
    fakeEditorExecutables[process.platform]?.[process.arch];
  if (fakeEditorExecutableName) {
    fakeEditorPath = path.join(
      extensionDir,
      'fakeeditor',
      'zig-out',
      'bin',
      fakeEditorExecutableName,
    );
  }
}

export async function prepareFakeeditor(): Promise<{
  succeedFakeeditor: () => Promise<void>;
  cleanup: () => Promise<void>;
  envVars: { [key: string]: string };
}> {
  const random = crypto.randomBytes(16).toString('hex');
  const signalDir = path.join(os.tmpdir(), `ukemi-signal-${random}`);

  await fs.mkdir(signalDir, { recursive: true });

  return {
    envVars: { JJ_FAKEEDITOR_SIGNAL_DIR: signalDir },
    succeedFakeeditor: async () => {
      const signalFilePath = path.join(signalDir, '0');
      try {
        await fs.writeFile(signalFilePath, '');
      } catch (error) {
        throw new Error(
          `Failed to write signal file '${signalFilePath}': ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    },
    cleanup: async () => {
      try {
        await fs.rm(signalDir, { recursive: true, force: true });
      } catch (error) {
        throw new Error(
          `Failed to cleanup signal directory '${signalDir}': ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    },
  };
}
