import * as vscode from 'vscode';
import path from 'path';
import { anyEvent } from '../utils';
import { JJDecorationProvider } from '../decoration_provider';
import { JJFileSystemProvider } from '../file_system_provider';
import { SemVer } from '../semver';
import { JJRepository } from '../jj/repository';
import { RepositoryStatus, FileStatus, Change, Show } from '../jj/types';
import { toJJUri } from '../uri';
import { provideOriginalResource, getResourceStateCommand } from './utils';

export class RepositorySourceControlManager {
  subscriptions: {
    dispose(): unknown;
  }[] = [];
  sourceControl: vscode.SourceControl;
  workingCopyResourceGroup: vscode.SourceControlResourceGroup;
  parentResourceGroups: vscode.SourceControlResourceGroup[] = [];
  repository: JJRepository;
  checkForUpdatesPromise: Promise<void> | undefined;

  private _onDidUpdate = new vscode.EventEmitter<void>();
  readonly onDidUpdate: vscode.Event<void> = this._onDidUpdate.event;

  operationId: string | undefined; // the latest operation id seen by this manager
  fileStatusesByChange: Map<string, FileStatus[]> = new Map();
  conflictedFilesByChange: Map<string, Set<string>> = new Map();
  trackedFiles: Set<string> | null = null;
  status: RepositoryStatus | undefined;
  parentShowResults: Map<string, Show> = new Map();

  constructor(
    public repositoryRoot: string,
    private decorationProvider: JJDecorationProvider,
    private fileSystemProvider: JJFileSystemProvider,
    jjPath: string,
    jjVersion: SemVer,
    jjConfigArgs: string[],
  ) {
    this.repository = new JJRepository(
      repositoryRoot,
      jjPath,
      jjVersion,
      jjConfigArgs,
    );

    this.sourceControl = vscode.scm.createSourceControl(
      'jj',
      path.basename(repositoryRoot),
      vscode.Uri.file(repositoryRoot),
    );
    this.subscriptions.push(this.sourceControl);

    this.workingCopyResourceGroup = this.sourceControl.createResourceGroup(
      '@',
      'Working Copy',
    );
    this.subscriptions.push(this.workingCopyResourceGroup);

    // Set up the SourceControlInputBox
    this.sourceControl.inputBox.placeholder = 'Message (press {0} to commit)';

    // Link the acceptInputCommand to the SourceControl instance
    this.sourceControl.acceptInputCommand = {
      command: 'jj.commit',
      title: 'Commit changes',
      arguments: [this.sourceControl],
    };

    this.sourceControl.quickDiffProvider = {
      provideOriginalResource,
    };

    const watcherOperations = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(
        path.join(this.repositoryRoot, '.jj/repo/op_store/operations'),
        '*',
      ),
    );
    this.subscriptions.push(watcherOperations);
    const repoChangedWatchEvent = anyEvent(
      watcherOperations.onDidCreate,
      watcherOperations.onDidChange,
      watcherOperations.onDidDelete,
    );
    repoChangedWatchEvent(
      async (_uri) => {
        this.fileSystemProvider.onDidChangeRepository({
          repositoryRoot: this.repositoryRoot,
        });
        await this.checkForUpdates();
      },
      undefined,
      this.subscriptions,
    );
  }

  async checkForUpdates() {
    if (!this.checkForUpdatesPromise) {
      this.checkForUpdatesPromise = this.checkForUpdatesUnsafe();
      try {
        await this.checkForUpdatesPromise;
      } finally {
        this.checkForUpdatesPromise = undefined;
      }
    } else {
      await this.checkForUpdatesPromise;
    }
  }

  /**
   * This should never be called concurrently.
   */
  async checkForUpdatesUnsafe() {
    const latestOperationId = await this.repository.getLatestOperationId({
      noIntegrate: true,
    });
    if (this.operationId !== latestOperationId) {
      this.operationId = latestOperationId;
      const status = await this.repository.status({ noIntegrate: true });

      await this.updateState(status);
      this.render();

      this._onDidUpdate.fire(undefined);
    }
  }

  async updateState(status: RepositoryStatus) {
    const newParentShowResults = new Map<string, Show>();
    const newFileStatusesByChange = new Map<string, FileStatus[]>([
      ['@', status.fileStatuses],
    ]);
    const newConflictedFilesByChange = new Map<string, Set<string>>([
      ['@', status.conflictedFiles],
    ]);

    // Only check for tracked files in store backends we know. Unknown backends
    // may not be suitable for listing all their contents. Otherwise tracked
    // files will are set to `null` to signal they are unsupported.
    let newTrackedFiles: Set<string> | null = null;
    const isKnownStoreBackend = await this.repository.isKnownStoreBackend();
    if (isKnownStoreBackend) {
      newTrackedFiles = new Set<string>();
      const trackedFilesList = await this.repository.fileList({
        noIntegrate: true,
      });
      for (const t of trackedFilesList) {
        const pathParts = t.split(path.sep);
        let currentPath = this.repositoryRoot + path.sep;
        for (const p of pathParts) {
          currentPath += p;
          newTrackedFiles.add(currentPath);
          currentPath += path.sep;
        }
      }
    }

    const parentShowPromises = status.parentChanges.map(
      async (parentChange) => {
        const showResult = await this.repository.show(parentChange.changeId, {
          noIntegrate: true,
        });
        return { changeId: parentChange.changeId, showResult };
      },
    );

    const parentShowResultsArray = await Promise.all(parentShowPromises);

    for (const { changeId, showResult } of parentShowResultsArray) {
      newParentShowResults.set(changeId, showResult);
      newFileStatusesByChange.set(changeId, showResult.fileStatuses);
      newConflictedFilesByChange.set(changeId, showResult.conflictedFiles);
    }

    this.status = status;
    this.fileStatusesByChange = newFileStatusesByChange;
    this.conflictedFilesByChange = newConflictedFilesByChange;
    this.parentShowResults = newParentShowResults;
    this.trackedFiles = newTrackedFiles;
  }

  static getLabel(prefix: string, change: Change) {
    return `${prefix} ${
      change.description ? ` • ${change.description}` : ''
    }${change.isEmpty ? ' (empty)' : ''}${
      change.isConflict ? ' (conflict)' : ''
    }${change.description ? '' : ' (no description)'}`;
  }

  render() {
    if (!this.status?.workingCopy) {
      throw new Error(
        'Cannot render source control without a current working copy change.',
      );
    }

    this.workingCopyResourceGroup.label = 'Working Copy';
    this.workingCopyResourceGroup.resourceStates = this.status.fileStatuses.map(
      (fileStatus) => {
        return {
          resourceUri: vscode.Uri.file(fileStatus.path),
          decorations: {
            strikeThrough: fileStatus.type === 'D',
            tooltip: path.basename(fileStatus.file),
          },
          command: getResourceStateCommand(
            fileStatus,
            toJJUri(vscode.Uri.file(`${fileStatus.path}`), {
              diffOriginalRev: '@',
            }),
            vscode.Uri.file(fileStatus.path),
          ),
        };
      },
    );
    this.sourceControl.count = this.status.fileStatuses.length;

    const updatedGroups: vscode.SourceControlResourceGroup[] = [];
    for (const group of this.parentResourceGroups) {
      const parentChange = this.status.parentChanges.find(
        (change) => change.changeId === group.id,
      );
      if (!parentChange) {
        group.dispose();
      } else {
        group.label = RepositorySourceControlManager.getLabel(
          'Parent Commit',
          parentChange,
        );
        updatedGroups.push(group);
      }
    }
    this.parentResourceGroups = updatedGroups;

    for (const parentChange of this.status.parentChanges.filter(
      (c) => !c.isImmutable,
    )) {
      let parentChangeResourceGroup!: vscode.SourceControlResourceGroup;

      const parentGroup = this.parentResourceGroups.find(
        (group) => group.id === parentChange.changeId,
      );
      if (!parentGroup) {
        parentChangeResourceGroup = this.sourceControl.createResourceGroup(
          parentChange.changeId,
          RepositorySourceControlManager.getLabel(
            'Parent Commit',
            parentChange,
          ),
        );
        this.parentResourceGroups.push(parentChangeResourceGroup);
      } else {
        parentChangeResourceGroup = parentGroup;
      }

      const showResult = this.parentShowResults.get(parentChange.changeId);
      if (showResult) {
        parentChangeResourceGroup.resourceStates = showResult.fileStatuses.map(
          (parentStatus) => {
            return {
              resourceUri: toJJUri(vscode.Uri.file(parentStatus.path), {
                rev: parentChange.changeId,
              }),
              decorations: {
                strikeThrough: parentStatus.type === 'D',
                tooltip: path.basename(parentStatus.file),
              },
              command: getResourceStateCommand(
                parentStatus,
                toJJUri(vscode.Uri.file(parentStatus.path), {
                  diffOriginalRev: parentChange.changeId,
                }),
                vscode.Uri.file(parentStatus.path),
              ),
            };
          },
        );
      }
    }

    this.decorationProvider.onRefresh(
      this.fileStatusesByChange,
      this.trackedFiles,
      this.conflictedFilesByChange,
    );
  }

  dispose() {
    for (const subscription of this.subscriptions) {
      subscription.dispose();
    }
    for (const group of this.parentResourceGroups) {
      group.dispose();
    }
  }
}
