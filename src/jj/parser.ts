import path from 'path';
import { Change, FileStatus, RepositoryStatus } from './types';

export async function parseJJStatus(
  repositoryRoot: string,
  output: string,
  immutableChangeIds: ReadonlySet<string>,
): Promise<RepositoryStatus> {
  const lines = output.split('\n');
  const fileStatuses: FileStatus[] = [];
  const conflictedFiles = new Set<string>();
  let workingCopy: Change = {
    changeId: '',
    commitId: '',
    description: '',
    isEmpty: false,
    isConflict: false,
    isImmutable: false,
    bookmarks: [],
  };
  const parentCommits: Change[] = [];

  const changeRegex = /^(A|M|D|R|C) (.+)$/;
  const commitRegex =
    /^(Working copy|Parent commit)\s*(\(@-?\))?\s*:\s+(\S+)\s+(\S+)(?:\s+(.+?)\s+\|)?(?:\s+(.*))?$/;

  let isParsingConflicts = false;

  for (const line of lines) {
    const trimmedLine = line.trim();
    const ansiStrippedTrimmedLine = await stripAnsiCodes(trimmedLine);

    if (
      ansiStrippedTrimmedLine === '' ||
      ansiStrippedTrimmedLine.startsWith('Working copy changes:') ||
      ansiStrippedTrimmedLine.startsWith('The working copy is clean')
    ) {
      continue;
    }

    if (
      ansiStrippedTrimmedLine.includes(
        'There are unresolved conflicts at these paths:',
      )
    ) {
      isParsingConflicts = true;
      continue;
    }

    if (isParsingConflicts) {
      const regions = await extractColoredRegions(trimmedLine);
      let filePath = '';
      let firstColoredRegionIndex = -1;
      for (let i = 0; i < regions.length; i++) {
        if (regions[i].colored) {
          firstColoredRegionIndex = i;
          break;
        }
        filePath += regions[i].text;
      }
      filePath = filePath.trim();

      if (ansiStrippedTrimmedLine.includes('To resolve the conflicts')) {
        isParsingConflicts = false;
        continue;
      }

      // If filePath is non-empty and we found a colored region after it, it's a conflict line
      if (filePath && firstColoredRegionIndex !== -1) {
        const normalizedFile = path.normalize(filePath).replace(/\\/g, '/');
        conflictedFiles.add(path.join(repositoryRoot, normalizedFile));
      } else {
        isParsingConflicts = false;
      }
    }

    const changeMatch = changeRegex.exec(ansiStrippedTrimmedLine);
    if (changeMatch) {
      const [_, type, file] = changeMatch;

      if (type === 'R' || type === 'C') {
        const parsedPaths = parseRenamePaths(file);
        if (parsedPaths) {
          fileStatuses.push({
            type: type,
            file: parsedPaths.toPath,
            path: path.join(repositoryRoot, parsedPaths.toPath),
            renamedFrom: parsedPaths.fromPath,
          });
        } else {
          throw new Error(
            `Unexpected ${type === 'R' ? 'rename' : 'copy'} line: ${line}`,
          );
        }
      } else {
        const normalizedFile = path.normalize(file).replace(/\\/g, '/');
        fileStatuses.push({
          type: type as 'A' | 'M' | 'D',
          file: normalizedFile,
          path: path.join(repositoryRoot, normalizedFile),
        });
      }
      continue;
    }

    const commitMatch = commitRegex.exec(line);
    if (commitMatch) {
      isParsingConflicts = false;
      const [
        _firstMatch,
        type,
        _at,
        changeId,
        commitId,
        bookmarks,
        descriptionSection,
      ] = commitMatch as unknown as [string, ...(string | undefined)[]];

      if (!type || !changeId || !commitId || !descriptionSection) {
        throw new Error(`Unexpected commit line: ${line}`);
      }

      const descriptionRegions = await extractColoredRegions(
        descriptionSection.trim(),
      );
      const cleanedDescription = descriptionRegions
        .filter((region) => !region.colored)
        .map((region) => region.text)
        .join('')
        .trim();
      const jjDescriptors = descriptionRegions
        .filter((region) => region.colored)
        .map((region) => region.text)
        .join('');
      const isEmpty = jjDescriptors.includes('(empty)');
      const isConflict = jjDescriptors.includes('(conflict)');

      const cleanedChangeId = await stripAnsiCodes(changeId);

      const commitDetails: Change = {
        changeId: cleanedChangeId,
        commitId: await stripAnsiCodes(commitId),
        bookmarks: bookmarks
          ? (await stripAnsiCodes(bookmarks)).split(/\s+/)
          : [],
        description: cleanedDescription,
        isEmpty,
        isConflict,
        isImmutable: immutableChangeIds.has(cleanedChangeId),
      };

      if ((await stripAnsiCodes(type)) === 'Working copy') {
        workingCopy = commitDetails;
      } else if ((await stripAnsiCodes(type)) === 'Parent commit') {
        parentCommits.push(commitDetails);
      }
      continue;
    }
  }

  return {
    fileStatuses: fileStatuses,
    workingCopy,
    parentChanges: parentCommits,
    conflictedFiles: conflictedFiles,
  };
}

export async function extractColoredRegions(input: string) {
  const { default: ansiRegex } = await import('ansi-regex');
  const regex = ansiRegex();
  let isColored = false;
  const result: { text: string; colored: boolean }[] = [];

  let lastIndex = 0;

  for (const match of input.matchAll(regex)) {
    const matchStart = match.index;
    const matchEnd = match.index + match[0].length;

    if (matchStart > lastIndex) {
      result.push({
        text: input.slice(lastIndex, matchStart),
        colored: isColored,
      });
    }

    const code = match[0];
    // Update color state
    if (code === '\x1b[0m' || code === '\x1b[39m') {
      isColored = false;
    } else if (
      // standard foreground colors (30–37)
      /\x1b\[3[0-7]m/.test(code) || // eslint-disable-line no-control-regex
      // bright foreground (90–97)
      /\x1b\[9[0-7]m/.test(code) || // eslint-disable-line no-control-regex
      // 256-color foreground
      /\x1b\[38;5;\d+m/.test(code) || // eslint-disable-line no-control-regex
      // 256-color background
      /\x1b\[48;5;\d+m/.test(code) || // eslint-disable-line no-control-regex
      // truecolor fg
      /\x1b\[38;2;\d+;\d+;\d+m/.test(code) || // eslint-disable-line no-control-regex
      // truecolor bg
      /\x1b\[48;2;\d+;\d+;\d+m/.test(code) // eslint-disable-line no-control-regex
    ) {
      isColored = true;
    }

    lastIndex = matchEnd;
  }

  // Remaining text after the last match
  if (lastIndex < input.length) {
    result.push({ text: input.slice(lastIndex), colored: isColored });
  }

  return result;
}

export async function stripAnsiCodes(input: string) {
  const { default: ansiRegex } = await import('ansi-regex');
  const regex = ansiRegex();
  return input.replace(regex, '');
}

const renameRegex = /^(.*)\{\s*(.*?)\s*=>\s*(.*?)\s*\}(.*)$/;

export function parseRenamePaths(
  file: string,
): { fromPath: string; toPath: string } | null {
  const renameMatch = renameRegex.exec(file);
  if (renameMatch) {
    const [_, prefix, fromPart, toPart, suffix] = renameMatch;
    const rawFromPath = prefix + fromPart + suffix;
    const rawToPath = prefix + toPart + suffix;
    const fromPath = path.normalize(rawFromPath).replace(/\\/g, '/');
    const toPath = path.normalize(rawToPath).replace(/\\/g, '/');
    return { fromPath, toPath };
  }
  return null;
}

export function filepathToFileset(filepath: string): string {
  return `file:"${filepath.replaceAll(/\\/g, '\\\\')}"`;
}
