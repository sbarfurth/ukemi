import * as vscode from "vscode";
import path from "path";
import { JJDecorationProvider } from "../decorationProvider";
import { JJFileSystemProvider } from "../fileSystemProvider";
import { SemVer } from "../semver";
import {
  getJJPath,
  getJJVersion,
  getConfigArgs,
  spawnJJ,
  handleCommand,
} from "../jj/cli";
import { getLogger } from "../logger";
import { extensionDir } from "../env";
import { RepositorySourceControlManager } from "./repository";

export class WorkspaceSourceControlManager {
  repoInfos:
    | Map<
        string,
        {
          jjPath: Awaited<ReturnType<typeof getJJPath>>;
          jjVersion: SemVer;
          jjConfigArgs: string[];
          repoRoot: string;
        }
      >
    | undefined;
  repoSCMs: RepositorySourceControlManager[] = [];
  subscriptions: {
    dispose(): unknown;
  }[] = [];
  fileSystemProvider: JJFileSystemProvider;

  private _onDidRepoUpdate = new vscode.EventEmitter<{
    repoSCM: RepositorySourceControlManager;
  }>();
  readonly onDidRepoUpdate: vscode.Event<{
    repoSCM: RepositorySourceControlManager;
  }> = this._onDidRepoUpdate.event;

  constructor(private decorationProvider: JJDecorationProvider) {
    this.fileSystemProvider = new JJFileSystemProvider(this);
    this.subscriptions.push(this.fileSystemProvider);
    this.subscriptions.push(
      vscode.workspace.registerFileSystemProvider(
        "jj",
        this.fileSystemProvider,
        {
          isReadonly: true,
          isCaseSensitive: true,
        },
      ),
    );
  }

  async refresh() {
    const newRepoInfos = new Map<
      string,
      {
        jjPath: Awaited<ReturnType<typeof getJJPath>>;
        jjVersion: SemVer;
        jjConfigArgs: string[];
        repoRoot: string;
      }
    >();
    for (const workspaceFolder of vscode.workspace.workspaceFolders || []) {
      try {
        const jjPath = await getJJPath(workspaceFolder.uri.fsPath);
        const jjVersion = await getJJVersion(jjPath.filepath);
        const jjConfigArgs = await getConfigArgs(extensionDir, jjVersion);

        const repoRoot = (
          await handleCommand(
            spawnJJ(jjPath.filepath, ["root"], {
              timeout: 5000,
              cwd: workspaceFolder.uri.fsPath,
            }),
          )
        )
          .toString()
          .trim();

        const repoUri = vscode.Uri.file(
          repoRoot.replace(/^\\\\\?\\UNC\\/, "\\\\"),
        ).toString();

        if (!newRepoInfos.has(repoUri)) {
          newRepoInfos.set(repoUri, {
            jjPath,
            jjVersion,
            jjConfigArgs,
            repoRoot,
          });
        }
      } catch (e) {
        if (e instanceof Error && e.message.includes("no jj repo in")) {
          getLogger().debug(`No jj repo in ${workspaceFolder.uri.fsPath}`);
        } else {
          getLogger().error(
            `Error while initializing ukemi in workspace ${workspaceFolder.uri.fsPath}: ${String(e)}`,
          );
        }
        continue;
      }
    }

    let isAnyRepoChanged = false;
    for (const [key, value] of newRepoInfos) {
      const oldValue = this.repoInfos?.get(key);
      if (!oldValue) {
        isAnyRepoChanged = true;
        getLogger().info(`Detected new jj repo in workspace: ${key}`);
      } else if (
        !oldValue.jjVersion.equals(value.jjVersion) ||
        oldValue.jjPath.filepath !== value.jjPath.filepath ||
        oldValue.jjConfigArgs.join(" ") !== value.jjConfigArgs.join(" ") ||
        oldValue.repoRoot !== value.repoRoot
      ) {
        isAnyRepoChanged = true;
        getLogger().info(
          `Detected change that requires reinitialization in workspace: ${key}`,
        );
      }
    }
    for (const key of this.repoInfos?.keys() || []) {
      if (!newRepoInfos.has(key)) {
        isAnyRepoChanged = true;
        getLogger().info(`Detected jj repo removal in workspace: ${key}`);
      }
    }
    this.repoInfos = newRepoInfos;

    if (isAnyRepoChanged) {
      const repoSCMs: RepositorySourceControlManager[] = [];
      for (const [
        workspaceFolder,
        { repoRoot, jjPath, jjVersion, jjConfigArgs },
      ] of newRepoInfos.entries()) {
        getLogger().info(
          `Initializing ukemi in workspace ${workspaceFolder}. Using ${jjVersion.toString()} at ${jjPath.filepath} (${jjPath.source}).`,
        );
        const repoSCM = new RepositorySourceControlManager(
          repoRoot,
          this.decorationProvider,
          this.fileSystemProvider,
          jjPath.filepath,
          jjVersion,
          jjConfigArgs,
        );
        repoSCM.onDidUpdate(
          () => {
            this._onDidRepoUpdate.fire({ repoSCM });
          },
          undefined,
          repoSCM.subscriptions,
        );
        repoSCMs.push(repoSCM);
      }

      for (const repoSCM of this.repoSCMs) {
        repoSCM.dispose();
      }
      this.repoSCMs = repoSCMs;
    }
    return isAnyRepoChanged;
  }

  getRepositoryFromUri(uri: vscode.Uri) {
    return this.repoSCMs.find((repo) => {
      return !path.relative(repo.repositoryRoot, uri.fsPath).startsWith("..");
    })?.repository;
  }

  getRepositoryFromResourceGroup(
    resourceGroup: vscode.SourceControlResourceGroup,
  ) {
    return this.repoSCMs.find((repo) => {
      return (
        resourceGroup === repo.workingCopyResourceGroup ||
        repo.parentResourceGroups.includes(resourceGroup)
      );
    })?.repository;
  }

  getRepositoryFromSourceControl(sourceControl: vscode.SourceControl) {
    return this.repoSCMs.find((repo) => repo.sourceControl === sourceControl)
      ?.repository;
  }

  getRepositorySourceControlManagerFromUri(uri: vscode.Uri) {
    return this.repoSCMs.find((repo) => {
      return !path.relative(repo.repositoryRoot, uri.fsPath).startsWith("..");
    });
  }

  getRepositorySourceControlManagerFromResourceGroup(
    resourceGroup: vscode.SourceControlResourceGroup,
  ) {
    return this.repoSCMs.find(
      (repo) =>
        repo.workingCopyResourceGroup === resourceGroup ||
        repo.parentResourceGroups.includes(resourceGroup),
    );
  }

  getResourceGroupFromResourceState(
    resourceState: vscode.SourceControlResourceState,
  ) {
    const resourceUri = resourceState.resourceUri;

    for (const repo of this.repoSCMs) {
      const groups = [
        repo.workingCopyResourceGroup,
        ...repo.parentResourceGroups,
      ];

      for (const group of groups) {
        if (
          group.resourceStates.some(
            (state) => state.resourceUri.toString() === resourceUri.toString(),
          )
        ) {
          return group;
        }
      }
    }

    throw new Error("Resource state not found in any resource group");
  }

  dispose() {
    for (const subscription of this.repoSCMs) {
      subscription.dispose();
    }
    for (const subscription of this.subscriptions) {
      subscription.dispose();
    }
  }
}
