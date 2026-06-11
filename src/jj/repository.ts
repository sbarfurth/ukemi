import spawn from 'cross-spawn';
import { pathEquals } from '../utils';
import fs from 'fs/promises';
import path from 'path';
import * as vscode from 'vscode';
import { SemVer } from '../semver';
import {
  spawnJJ,
  handleJJCommand,
  ImmutableError,
  convertJJErrors,
} from './cli';
import { parseJJStatus, parseRenamePaths, filepathToFileset } from './parser';
import { RepositoryStatus, Show, Operation, ShowTemplateField } from './types';
import { getLogger } from '../logger';
import { fakeEditorPath, prepareFakeeditor } from '../env';

export class JJRepository {
  statusCache: RepositoryStatus | undefined;
  gitFetchPromise: Promise<void> | undefined;

  private isKnownStoreBackendCache: boolean | undefined;

  constructor(
    public repositoryRoot: string,
    private jjPath: string,
    private jjVersion: SemVer,
    private jjConfigArgs: string[],
  ) {}

  spawnJJ(
    args: string[],
    options: Parameters<typeof spawn>[2] & { cwd: string },
  ) {
    return spawnJJ(this.jjPath, [...args, ...this.jjConfigArgs], options);
  }

  async isKnownStoreBackend(): Promise<boolean> {
    if (this.isKnownStoreBackendCache !== undefined) {
      return this.isKnownStoreBackendCache;
    }
    let storeType: string;
    if (this.jjVersion.isAtLeast(SemVer.parse('0.42.0'))) {
      storeType = (
        await handleJJCommand(
          this.spawnJJ(['util', 'backend', 'name'], {
            timeout: 5000,
            cwd: this.repositoryRoot,
          }),
        )
      ).toString();
    } else {
      const root = (
        await handleJJCommand(
          this.spawnJJ(['root'], {
            timeout: 5000,
            cwd: this.repositoryRoot,
          }),
        )
      )
        .toString()
        .trim();
      storeType = await fs.readFile(
        path.join(root, '.jj/repo/store/type'),
        'utf8',
      );
    }
    this.isKnownStoreBackendCache = ['git', 'simple'].includes(
      storeType.trim().toLowerCase(),
    );
    return this.isKnownStoreBackendCache;
  }

  /**
   * Note: this command may itself snapshot the working copy and add an operation to the log, in which case it will
   * return the new operation id.
   */
  async getLatestOperationId(options: { noIntegrate?: boolean } = {}) {
    const args = [
      'operation',
      'log',
      '--limit',
      '1',
      '-T',
      'self.id()',
      '--no-graph',
    ];
    if (
      options.noIntegrate &&
      this.jjVersion.isAtLeast(SemVer.parse('0.41.0'))
    ) {
      args.unshift('--no-integrate-operation');
    }
    return (
      await handleJJCommand(
        this.spawnJJ(args, {
          cwd: this.repositoryRoot,
        }),
      )
    )
      .toString()
      .trim();
  }

  async getStatus(
    options: {
      useCache?: boolean;
      noIntegrate?: boolean;
    } = {},
  ): Promise<RepositoryStatus> {
    if (options.useCache && this.statusCache) {
      return this.statusCache;
    }

    const logArgs = [
      'log',
      '-r',
      'immutable_heads()',
      '-T',
      'change_id.short(8)',
    ];
    if (
      options.noIntegrate &&
      this.jjVersion.isAtLeast(SemVer.parse('0.41.0'))
    ) {
      logArgs.unshift('--no-integrate-operation');
    }

    const immutableOutput = (
      await handleJJCommand(
        this.spawnJJ(logArgs, {
          timeout: 5000,
          cwd: this.repositoryRoot,
        }),
      )
    ).toString();
    const changeIdLinePattern = /^.*([k-z]{8})$/;
    const immutableChangeIds = new Set<string>();
    for (const line of immutableOutput.split('\n').filter(Boolean)) {
      const match = line.match(changeIdLinePattern);
      if (match) {
        immutableChangeIds.add(match[1]);
      }
    }

    const statusArgs = ['status', '--color=always'];
    if (
      options.noIntegrate &&
      this.jjVersion.isAtLeast(SemVer.parse('0.41.0'))
    ) {
      statusArgs.unshift('--no-integrate-operation');
    }

    const statusOutput = (
      await handleJJCommand(
        this.spawnJJ(statusArgs, {
          timeout: 5000,
          cwd: this.repositoryRoot,
        }),
      )
    ).toString();
    const status = await parseJJStatus(
      this.repositoryRoot,
      statusOutput,
      immutableChangeIds,
    );

    this.statusCache = status;
    return status;
  }

  async status(
    options: {
      useCache?: boolean;
      noIntegrate?: boolean;
    } = {},
  ): Promise<RepositoryStatus> {
    const status = await this.getStatus(options);
    return status;
  }

  async fileList(options: { noIntegrate?: boolean } = {}) {
    const args = ['file', 'list'];
    if (
      options.noIntegrate &&
      this.jjVersion.isAtLeast(SemVer.parse('0.41.0'))
    ) {
      args.unshift('--no-integrate-operation');
    }
    return (
      await handleJJCommand(
        this.spawnJJ(args, {
          timeout: 5000,
          cwd: this.repositoryRoot,
        }),
      )
    )
      .toString()
      .trim()
      .split('\n');
  }

  async show(rev: string, options: { noIntegrate?: boolean } = {}) {
    const results = await this.showAll([rev], options);
    if (results.length > 1) {
      throw new Error('Multiple results found for the given revision.');
    }
    if (results.length === 0) {
      throw new Error('No results found for the given revision.');
    }
    return results[0];
  }

  async showAll(
    revsets: string[],
    options: { noIntegrate?: boolean } = {},
  ): Promise<Show[]> {
    const revSeparator = '__ඞඞ__\n';
    const fieldSeparator = '__ඞ__';
    const summarySeparator = '@?!'; // characters that are illegal in filepaths
    const isConflictDetectionSupported = this.jjVersion.isAtLeast(
      SemVer.parse('0.26.0'),
    );
    const templateFields: ShowTemplateField[] = [
      {
        template: 'change_id',
        setter: (value, show) => {
          show.change.changeId = value;
        },
      },
      {
        template: 'commit_id',
        setter: (value, show) => {
          show.change.commitId = value;
        },
      },
      {
        template: 'author.name()',
        setter: (value, show) => {
          show.change.author.name = value;
        },
      },
      {
        template: 'author.email()',
        setter: (value, show) => {
          show.change.author.email = value;
        },
      },
      {
        template: 'author.timestamp().local().format("%F %H:%M:%S")',
        setter: (value, show) => {
          show.change.authoredDate = value;
        },
      },
      {
        template: 'parents.map(|p| p.change_id()).join(",")',
        setter: (value, show) => {
          show.change.parentChangeIds = value
            .split(',')
            .map((id) => id.trim())
            .filter(Boolean);
        },
      },
      {
        template: 'bookmarks.map(|b| b.name()).join(",")',
        setter: (value, show) => {
          show.change.bookmarks = value
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean);
        },
      },
      {
        template: 'description',
        setter: (value, show) => {
          show.change.description = value;
        },
      },
      {
        template: 'immutable',
        setter: (value, show) => {
          show.change.isImmutable = value === 'true';
        },
      },
      {
        template: 'empty',
        setter: (value, show) => {
          show.change.isEmpty = value === 'true';
        },
      },
      {
        template: 'conflict',
        setter: (value, show) => {
          show.change.isConflict = value === 'true';
        },
      },
      {
        template: 'current_working_copy',
        setter: (value, show) => {
          show.change.isCurrentWorkingCopy = value === 'true';
        },
      },
      {
        template: 'bookmarks.all(|b| b.synced())',
        setter: (value, show) => {
          show.change.isSynced = value === 'true';
        },
      },
    ];
    if (isConflictDetectionSupported) {
      templateFields.push({
        template: `diff.files().map(|entry| entry.status() ++ "${summarySeparator}" ++ entry.source().path().display() ++ "${summarySeparator}" ++ entry.target().path().display() ++ "${summarySeparator}" ++ entry.target().conflict()).join("\n")`,
      });
    } else {
      templateFields.push({ template: 'diff.summary()' });
    }
    const template =
      templateFields
        .map((field) => field.template)
        .join(` ++ "${fieldSeparator}" ++ `) + ` ++ "${revSeparator}"`;

    const logArgs = [
      'log',
      '-T',
      template,
      '--no-graph',
      '--no-pager',
      ...revsets.flatMap((revset) => ['-r', revset]),
    ];
    if (
      options.noIntegrate &&
      this.jjVersion.isAtLeast(SemVer.parse('0.41.0'))
    ) {
      logArgs.unshift('--no-integrate-operation');
    }

    const output = (
      await handleJJCommand(
        this.spawnJJ(logArgs, {
          timeout: 5000,
          cwd: this.repositoryRoot,
        }),
      )
    ).toString();

    if (!output) {
      throw new Error(
        "No output from jj log. Maybe the revision couldn't be found?",
      );
    }

    const revResults = output.split(revSeparator).slice(0, -1); // the output ends in a separator so remove the empty string at the end
    return revResults.map((revResult) => {
      const fields = revResult.split(fieldSeparator);
      if (fields.length > templateFields.length) {
        throw new Error(
          'Separator found in a field value. This is not supported.',
        );
      } else if (fields.length < templateFields.length) {
        throw new Error('Missing fields in the output.');
      }
      const ret: Show = {
        change: {
          changeId: '',
          commitId: '',
          description: '',
          author: {
            email: '',
            name: '',
          },
          authoredDate: '',
          parentChangeIds: [],
          bookmarks: [],
          isEmpty: false,
          isConflict: false,
          isImmutable: false,
          isCurrentWorkingCopy: false,
          isSynced: false,
        },
        fileStatuses: [],
        conflictedFiles: new Set<string>(),
      };

      for (let i = 0; i < fields.length; i++) {
        const field = fields[i];
        const value = field.trim();
        const templateField = templateFields[i];
        if (templateField.setter) {
          templateField.setter(value, ret);
        } else {
          const changeRegex = /^(A|M|D|R|C) (.+)$/;
          for (const line of value.split('\n').filter(Boolean)) {
            if (isConflictDetectionSupported) {
              const [status, rawSourcePath, rawTargetPath, conflict] =
                line.split(summarySeparator);
              const sourcePath = path
                .normalize(rawSourcePath)
                .replace(/\\/g, '/');
              const targetPath = path
                .normalize(rawTargetPath)
                .replace(/\\/g, '/');
              if (
                ['modified', 'added', 'removed', 'copied', 'renamed'].includes(
                  status,
                )
              ) {
                if (status === 'renamed' || status === 'copied') {
                  ret.fileStatuses.push({
                    type: status === 'renamed' ? 'R' : 'C',
                    file: targetPath,
                    path: path.join(this.repositoryRoot, targetPath),
                    renamedFrom: sourcePath,
                  });
                } else {
                  ret.fileStatuses.push({
                    type:
                      status === 'added'
                        ? 'A'
                        : status === 'removed'
                          ? 'D'
                          : 'M',
                    file: targetPath,
                    path: path.join(this.repositoryRoot, targetPath),
                  });
                }
                if (conflict === 'true') {
                  ret.conflictedFiles.add(
                    path.join(this.repositoryRoot, targetPath),
                  );
                }
              } else {
                throw new Error(`Unexpected diff custom summary line: ${line}`);
              }
            } else {
              const changeMatch = changeRegex.exec(line);
              if (changeMatch) {
                const [_, type, file] = changeMatch;

                if (type === 'R' || type === 'C') {
                  const parsedPaths = parseRenamePaths(file);
                  if (parsedPaths) {
                    ret.fileStatuses.push({
                      type: type,
                      file: parsedPaths.toPath,
                      path: path.join(this.repositoryRoot, parsedPaths.toPath),
                      renamedFrom: parsedPaths.fromPath,
                    });
                  } else {
                    throw new Error(
                      `Unexpected ${type === 'R' ? 'rename' : 'copy'} line: ${line}`,
                    );
                  }
                } else {
                  const normalizedFile = path
                    .normalize(file)
                    .replace(/\\/g, '/');
                  ret.fileStatuses.push({
                    type: type as 'A' | 'M' | 'D',
                    file: normalizedFile,
                    path: path.join(this.repositoryRoot, normalizedFile),
                  });
                }
              } else {
                throw new Error(`Unexpected diff summary line: ${line}`);
              }
            }
          }
        }
      }

      return ret;
    });
  }

  readFile(rev: string, filepath: string) {
    return handleJJCommand(
      this.spawnJJ(
        ['file', 'show', '--revision', rev, filepathToFileset(filepath)],
        {
          timeout: 5000,
          cwd: this.repositoryRoot,
        },
      ),
    );
  }

  async describeRetryImmutable(rev: string, message: string) {
    try {
      return await this.describe(rev, message);
    } catch (e) {
      if (e instanceof ImmutableError) {
        const choice = await vscode.window.showQuickPick(['Continue'], {
          title: `${rev} is immutable, are you sure?`,
        });
        if (!choice) {
          return;
        }
        return await this.describe(rev, message, true);
      }
      throw e;
    }
  }

  async describe(rev: string, message: string, ignoreImmutable = false) {
    return (
      await handleJJCommand(
        this.spawnJJ(
          [
            'describe',
            '-m',
            message,
            rev,
            ...(ignoreImmutable ? ['--ignore-immutable'] : []),
          ],
          {
            timeout: 5000,
            cwd: this.repositoryRoot,
          },
        ),
      )
    ).toString();
  }

  async new(message?: string, revs?: string[]) {
    try {
      return await handleJJCommand(
        this.spawnJJ(
          [
            'new',
            ...(revs ? [...revs] : []),
            ...(message ? ['-m', message] : []),
          ],
          {
            timeout: 5000,
            cwd: this.repositoryRoot,
          },
        ),
      );
    } catch (error) {
      if (error instanceof Error) {
        const match = error.message.match(/error:\s*([\s\S]+)$/i);
        if (match) {
          const errorMessage = match[1];
          throw new Error(errorMessage);
        } else {
          throw error;
        }
      } else {
        throw error;
      }
    }
  }

  async commit(message?: string, revset?: string) {
    try {
      return await handleJJCommand(
        this.spawnJJ(
          [
            'commit',
            ...(revset ? ['-r', revset] : []),
            ...(message ? ['-m', message] : []),
          ],
          {
            timeout: 5000,
            cwd: this.repositoryRoot,
          },
        ),
      );
    } catch (error) {
      if (error instanceof Error) {
        const match = error.message.match(/error:\s*([\s\S]+)$/i);
        if (match) {
          const errorMessage = match[1];
          throw new Error(errorMessage);
        } else {
          throw error;
        }
      } else {
        throw error;
      }
    }
  }

  async squashRetryImmutable({
    fromRev,
    toRev,
    message,
    filepaths,
  }: {
    fromRev: string;
    toRev: string;
    message?: string;
    filepaths?: string[];
  }) {
    try {
      return await this.squash({
        fromRev,
        toRev,
        message,
        filepaths,
      });
    } catch (e) {
      if (e instanceof ImmutableError) {
        const choice = await vscode.window.showQuickPick(['Continue'], {
          title: `${toRev} is immutable, are you sure?`,
        });
        if (!choice) {
          return;
        }
        return await this.squash({
          fromRev,
          toRev,
          message,
          filepaths,
          ignoreImmutable: true,
        });
      }
      throw e;
    }
  }

  async squash({
    fromRev,
    toRev,
    message,
    filepaths,
    ignoreImmutable = false,
  }: {
    fromRev: string;
    toRev: string;
    message?: string;
    filepaths?: string[];
    ignoreImmutable?: boolean;
  }) {
    return (
      await handleJJCommand(
        this.spawnJJ(
          [
            'squash',
            '--from',
            fromRev,
            '--into',
            toRev,
            ...(message ? ['-m', message] : []),
            ...(filepaths
              ? filepaths.map((filepath) => filepathToFileset(filepath))
              : []),
            ...(ignoreImmutable ? ['--ignore-immutable'] : []),
          ],
          {
            timeout: 5000,
            cwd: this.repositoryRoot,
          },
        ),
      )
    ).toString();
  }

  async squashContentRetryImmutable({
    fromRev,
    toRev,
    filepath,
    content,
  }: {
    fromRev: string;
    toRev: string;
    filepath: string;
    content: string;
  }) {
    try {
      return await this.squashContent({
        fromRev,
        toRev,
        filepath,
        content,
      });
    } catch (e) {
      if (e instanceof ImmutableError) {
        const choice = await vscode.window.showQuickPick(['Continue'], {
          title: `${toRev} is immutable, are you sure?`,
        });
        if (!choice) {
          return;
        }
        return await this.squashContent({
          fromRev,
          toRev,
          filepath,
          content,
          ignoreImmutable: true,
        });
      }
      throw e;
    }
  }

  /**
   * Squashes a portion of the changes in a file from one revision into another.
   *
   * @param options.fromRev - The revision to squash changes from.
   * @param options.toRev - The revision to squash changes into.
   * @param options.filepath - The path of the file whose changes will be moved.
   * @param options.content - The contents of the file at filepath with some of the changes in fromRev applied to it;
   *                          those changes will be moved to the destination revision.
   */
  async squashContent({
    fromRev,
    toRev,
    filepath,
    content,
    ignoreImmutable = false,
  }: {
    fromRev: string;
    toRev: string;
    filepath: string;
    content: string;
    ignoreImmutable?: boolean;
  }): Promise<void> {
    const { succeedFakeeditor, cleanup, envVars } = await prepareFakeeditor();
    return new Promise<void>((resolve, reject) => {
      const childProcess = this.spawnJJ(
        [
          'squash',
          '--from',
          fromRev,
          '--into',
          toRev,
          '--interactive',
          '--tool',
          `${fakeEditorPath}`,
          '--use-destination-message',
          ...(ignoreImmutable ? ['--ignore-immutable'] : []),
        ],
        {
          timeout: 10_000, // Ensure this is longer than fakeeditor's internal timeout
          cwd: this.repositoryRoot,
          env: { ...process.env, ...envVars },
        },
      );

      let fakeEditorOutputBuffer = '';
      const FAKEEDITOR_SENTINEL = 'FAKEEDITOR_OUTPUT_END\n';

      childProcess.stdout!.on('data', (data: Buffer) => {
        fakeEditorOutputBuffer += data.toString();

        if (!fakeEditorOutputBuffer.includes(FAKEEDITOR_SENTINEL)) {
          // Wait for more data if sentinel not yet received
          return;
        }

        const output = fakeEditorOutputBuffer.substring(
          0,
          fakeEditorOutputBuffer.indexOf(FAKEEDITOR_SENTINEL),
        );

        const lines = output.trim().split('\n');
        const fakeEditorPID = lines[0];
        const fakeEditorCWD = lines[1];
        // lines[2] is the fakeeditor executable path
        const leftFolderPath = lines[3];
        const rightFolderPath = lines[4];

        if (lines.length !== 5) {
          if (fakeEditorPID) {
            try {
              process.kill(parseInt(fakeEditorPID), 'SIGTERM');
            } catch (killError) {
              getLogger().error(
                `Failed to kill fakeeditor (PID: ${fakeEditorPID}) after validation error: ${killError instanceof Error ? killError : ''}`,
              );
            }
          }
          void cleanup();
          reject(new Error(`Unexpected output from fakeeditor: ${output}`));
          return;
        }

        if (
          !fakeEditorPID ||
          !fakeEditorCWD ||
          !leftFolderPath ||
          !leftFolderPath.endsWith('left') ||
          !rightFolderPath ||
          !rightFolderPath.endsWith('right')
        ) {
          if (fakeEditorPID) {
            try {
              process.kill(parseInt(fakeEditorPID), 'SIGTERM');
            } catch (killError) {
              getLogger().error(
                `Failed to kill fakeeditor (PID: ${fakeEditorPID}) after validation error: ${killError instanceof Error ? killError : ''}`,
              );
            }
          }
          void cleanup();
          reject(new Error(`Unexpected output from fakeeditor: ${output}`));
          return;
        }

        const leftFolderAbsolutePath = path.isAbsolute(leftFolderPath)
          ? leftFolderPath
          : path.join(fakeEditorCWD, leftFolderPath);
        const rightFolderAbsolutePath = path.isAbsolute(rightFolderPath)
          ? rightFolderPath
          : path.join(fakeEditorCWD, rightFolderPath);

        // Convert filepath to relative path and join with rightFolderPath
        const relativeFilePath = path.relative(this.repositoryRoot, filepath);
        const fileToEdit = path.join(rightFolderAbsolutePath, relativeFilePath);

        // Ensure right folder is an exact copy of left, then handle the specific file
        void fs
          .rm(rightFolderAbsolutePath, { recursive: true, force: true })
          .then(() => fs.mkdir(rightFolderAbsolutePath, { recursive: true }))
          .then(() =>
            fs.cp(leftFolderAbsolutePath, rightFolderAbsolutePath, {
              recursive: true,
            }),
          )
          .then(() => fs.rm(fileToEdit, { force: true })) // remove the specific file we're about to write to avoid its read-only permissions copied from the left folder
          .then(() => fs.writeFile(fileToEdit, content))
          .then(succeedFakeeditor)
          .catch((error) => {
            if (fakeEditorPID) {
              try {
                process.kill(parseInt(fakeEditorPID), 'SIGTERM');
              } catch (killError) {
                getLogger().error(
                  `Failed to send SIGTERM to fakeeditor (PID: ${fakeEditorPID}) during error handling: ${killError instanceof Error ? killError : ''}`,
                );
              }
            }
            void cleanup();
            reject(error); // eslint-disable-line @typescript-eslint/prefer-promise-reject-errors
          });
      });

      let errOutput = '';
      childProcess.stderr!.on('data', (data: Buffer) => {
        errOutput += data.toString();
      });

      childProcess.on('close', (code, signal) => {
        void cleanup();
        if (code) {
          reject(
            new Error(
              `Command failed with exit code ${code}.\nstdout: ${fakeEditorOutputBuffer}\nstderr: ${errOutput}`,
            ),
          );
        } else if (signal) {
          reject(
            new Error(
              `Command failed with signal ${signal}.\nstdout: ${fakeEditorOutputBuffer}\nstderr: ${errOutput}`,
            ),
          );
        } else {
          resolve();
        }
      });
    }).catch(convertJJErrors);
  }

  async log(
    rev: string | null = '::',
    template: string = 'builtin_log_compact',
    limit: number = 50,
    noGraph: boolean = false,
  ) {
    return (
      await handleJJCommand(
        this.spawnJJ(
          [
            'log',
            ...(rev !== null ? ['-r', rev] : []),
            '-n',
            limit.toString(),
            '-T',
            template,
            '--color=never',
            ...(noGraph ? ['--no-graph'] : []),
          ],
          {
            timeout: 5000,
            cwd: this.repositoryRoot,
          },
        ),
      )
    ).toString();
  }

  async editRetryImmutable(rev: string) {
    try {
      return await this.edit(rev);
    } catch (e) {
      if (e instanceof ImmutableError) {
        const choice = await vscode.window.showQuickPick(['Continue'], {
          title: `${rev} is immutable, are you sure?`,
        });
        if (!choice) {
          return;
        }
        return await this.edit(rev, true);
      }
      throw e;
    }
  }

  async edit(rev: string, ignoreImmutable = false) {
    return await handleJJCommand(
      this.spawnJJ(
        ['edit', '-r', rev, ...(ignoreImmutable ? ['--ignore-immutable'] : [])],
        {
          timeout: 5000,
          cwd: this.repositoryRoot,
        },
      ),
    );
  }

  async restoreRetryImmutable(rev?: string, filepaths?: string[]) {
    try {
      return await this.restore(rev, filepaths);
    } catch (e) {
      if (e instanceof ImmutableError) {
        const choice = await vscode.window.showQuickPick(['Continue'], {
          title: `${rev} is immutable, are you sure?`,
        });
        if (!choice) {
          return;
        }
        return await this.restore(rev, filepaths, true);
      }
      throw e;
    }
  }

  async restore(rev?: string, filepaths?: string[], ignoreImmutable = false) {
    return await handleJJCommand(
      this.spawnJJ(
        [
          'restore',
          '--changes-in',
          rev ? rev : '@',
          ...(filepaths
            ? filepaths.map((filepath) => filepathToFileset(filepath))
            : []),
          ...(ignoreImmutable ? ['--ignore-immutable'] : []),
        ],
        {
          timeout: 5000,
          cwd: this.repositoryRoot,
        },
      ),
    );
  }

  gitFetch(): Promise<void> {
    if (!this.gitFetchPromise) {
      this.gitFetchPromise = (async () => {
        try {
          await handleJJCommand(
            this.spawnJJ(['git', 'fetch'], {
              timeout: 60_000,
              cwd: this.repositoryRoot,
            }),
          );
        } finally {
          this.gitFetchPromise = undefined;
        }
      })();
    }
    return this.gitFetchPromise;
  }

  async annotate(filepath: string, rev: string): Promise<string[]> {
    const output = (
      await handleJJCommand(
        this.spawnJJ(
          [
            'file',
            'annotate',
            '-r',
            rev,
            filepath, // `jj file annotate` takes a path, not a fileset
          ],
          {
            timeout: 60_000,
            cwd: this.repositoryRoot,
          },
        ),
      )
    ).toString();
    if (output === '') {
      return [];
    }
    const lines = output.trim().split('\n');
    const changeIdsByLine = lines.map((line) => line.split(' ')[0]);
    return changeIdsByLine;
  }

  async operationLog(): Promise<Operation[]> {
    const operationSeparator = '__ඞඞ__\n';
    const fieldSeparator = '__ඞ__';
    const templateFields = [
      'self.id()',
      'self.description()',
      'self.attributes()',
      'self.time().start()',
      'self.user()',
      'self.snapshot()',
    ];
    const template =
      templateFields.join(` ++ "${fieldSeparator}" ++ `) +
      ` ++ "${operationSeparator}"`;

    const output = (
      await handleJJCommand(
        this.spawnJJ(
          [
            'operation',
            'log',
            '--limit',
            '10',
            '--no-graph',
            '--at-operation=@',
            '--ignore-working-copy',
            '-T',
            template,
          ],
          {
            timeout: 5000,
            cwd: this.repositoryRoot,
          },
        ),
      )
    ).toString();

    const ret: Operation[] = [];
    const lines = output.split(operationSeparator).slice(0, -1); // the output ends in a separator so remove the empty string at the end
    for (const line of lines) {
      const results = line.split(fieldSeparator);
      if (results.length > templateFields.length) {
        console.warn(
          'Separator found in a field value. This is not supported. Operation will be ignored.',
        );
        continue;
      } else if (results.length < templateFields.length) {
        console.warn(
          'Missing fields in the output. Operation will be ignored.',
        );
        continue;
      }
      const op: Operation = {
        id: '',
        description: '',
        tags: '',
        start: '',
        user: '',
        snapshot: false,
      };

      for (let i = 0; i < results.length; i++) {
        const field = results[i];
        const value = field.trim();
        switch (templateFields[i]) {
          case 'self.id()':
            op.id = value;
            break;
          case 'self.description()':
            op.description = value;
            break;
          case 'self.attributes()':
            op.tags = value;
            break;
          case 'self.time().start()':
            op.start = value;
            break;
          case 'self.user()':
            op.user = value;
            break;
          case 'self.snapshot()':
            op.snapshot = value === 'true';
            break;
        }
      }
      ret.push(op);
    }

    return ret;
  }

  async operationUndo(id: string) {
    return (
      await handleJJCommand(
        this.spawnJJ(['operation', 'undo', id], {
          timeout: 5000,
          cwd: this.repositoryRoot,
        }),
      )
    ).toString();
  }

  async operationRestore(id: string) {
    return (
      await handleJJCommand(
        this.spawnJJ(['operation', 'restore', id], {
          timeout: 5000,
          cwd: this.repositoryRoot,
        }),
      )
    ).toString();
  }

  /**
   * @returns undefined if the file was not modified in `rev`
   */
  async getDiffOriginal(
    rev: string,
    filepath: string,
  ): Promise<Buffer | undefined> {
    const { cleanup, envVars } = await prepareFakeeditor();

    const output = await new Promise<string>((resolve, reject) => {
      const childProcess = this.spawnJJ(
        // We don't pass the filepath to diff because we need the left folder to have all files,
        // in case the file was renamed or copied. If we knew the status of the file, we could
        // pass the previous filename in addition to the current filename upon seeing a rename or copy.
        // We don't have the status though, which is why we're using `--summary` here.
        ['diff', '--summary', '--tool', `${fakeEditorPath}`, '-r', rev],
        {
          timeout: 10_000, // Ensure this is longer than fakeeditor's internal timeout
          cwd: this.repositoryRoot,
          env: { ...process.env, ...envVars },
        },
      );

      let fakeEditorOutputBuffer = '';
      const FAKEEDITOR_SENTINEL = 'FAKEEDITOR_OUTPUT_END\n';

      childProcess.stdout!.on('data', (data: Buffer) => {
        fakeEditorOutputBuffer += data.toString();

        if (!fakeEditorOutputBuffer.includes(FAKEEDITOR_SENTINEL)) {
          // Wait for more data if sentinel not yet received
          return;
        }

        const completeOutput = fakeEditorOutputBuffer.substring(
          0,
          fakeEditorOutputBuffer.indexOf(FAKEEDITOR_SENTINEL),
        );
        resolve(completeOutput);
      });

      const errOutput: Buffer[] = [];
      childProcess.stderr!.on('data', (data: Buffer) => {
        errOutput.push(data);
      });

      childProcess.on('error', (error: Error) => {
        void cleanup();
        reject(new Error(`Spawning command failed: ${error.message}`));
      });

      childProcess.on('close', (code, signal) => {
        void cleanup();
        if (code) {
          reject(
            new Error(
              `Command failed with exit code ${code}.\nstdout: ${fakeEditorOutputBuffer}\nstderr: ${Buffer.concat(errOutput).toString()}`,
            ),
          );
        } else if (signal) {
          reject(
            new Error(
              `Command failed with signal ${signal}.\nstdout: ${fakeEditorOutputBuffer}\nstderr: ${Buffer.concat(errOutput).toString()}`,
            ),
          );
        } else {
          // This reject will only matter if the promise wasn't resolved already;
          // that means we'll only see this if the command exited without sending the sentinel.
          reject(
            new Error(
              `Command exited unexpectedly.\nstdout:${fakeEditorOutputBuffer}\nstderr: ${Buffer.concat(errOutput).toString()}`,
            ),
          );
        }
      });
    }).catch(convertJJErrors);

    const lines = output.trim().split('\n');
    const pidLineIdx =
      lines.findIndex((line) => {
        return line.includes(fakeEditorPath);
      }) - 2;
    if (pidLineIdx < 0) {
      throw new Error('PID line not found.');
    }
    if (pidLineIdx + 3 >= lines.length) {
      throw new Error(`Unexpected output from fakeeditor: ${output}`);
    }

    const summaryLines = lines.slice(0, pidLineIdx);
    const fakeEditorPID = lines[pidLineIdx];
    const fakeEditorCWD = lines[pidLineIdx + 1];
    // lines[pidLineIdx + 2] is the fakeeditor executable path
    const leftFolderPath = lines[pidLineIdx + 3];

    const leftFolderAbsolutePath = path.isAbsolute(leftFolderPath)
      ? leftFolderPath
      : path.join(fakeEditorCWD, leftFolderPath);

    try {
      let pathInLeftFolder: string | undefined;

      for (const summaryLineRaw of summaryLines) {
        const summaryLine = summaryLineRaw.trim();

        const type = summaryLine.charAt(0);
        const file = summaryLine.slice(2).trim();

        if (type === 'M' || type === 'D') {
          const normalizedSummaryPath = path
            .join(this.repositoryRoot, file)
            .replace(/\\/g, '/');
          const normalizedTargetPath = path
            .normalize(filepath)
            .replace(/\\/g, '/');
          if (pathEquals(normalizedSummaryPath, normalizedTargetPath)) {
            pathInLeftFolder = file;
            break;
          }
        } else if (type === 'R' || type === 'C') {
          const parseResult = parseRenamePaths(file);
          if (!parseResult) {
            throw new Error(`Unexpected rename line: ${summaryLineRaw}`);
          }

          const normalizedSummaryPath = path
            .join(this.repositoryRoot, parseResult.toPath)
            .replace(/\\/g, '/');
          const normalizedTargetPath = path
            .normalize(filepath)
            .replace(/\\/g, '/');
          if (pathEquals(normalizedSummaryPath, normalizedTargetPath)) {
            // The file was renamed TO our target filepath, so we need its OLD path from the left folder
            pathInLeftFolder = parseResult.fromPath;
            break;
          }
        }
      }

      if (pathInLeftFolder) {
        const fullPath = path.join(leftFolderAbsolutePath, pathInLeftFolder);
        try {
          return await fs.readFile(fullPath);
        } catch (e) {
          getLogger().error(
            `Failed to read original file content from left folder at ${fullPath}: ${String(
              e,
            )}`,
          );
          throw e;
        }
      }

      // File was either added or unchanged in this revision.
      return undefined;
    } finally {
      try {
        process.kill(parseInt(fakeEditorPID), 'SIGTERM');
      } catch (killError) {
        getLogger().error(
          `Failed to kill fakeeditor (PID: ${fakeEditorPID}) in getDiffOriginal: ${killError instanceof Error ? killError : ''}`,
        );
      }
    }
  }

  async abandon(rev: string) {
    return await handleJJCommand(
      this.spawnJJ(['abandon', '-r', rev], {
        timeout: 5000,
        cwd: this.repositoryRoot,
      }),
    );
  }
}
