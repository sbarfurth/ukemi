import * as vscode from 'vscode';
import { getParams, toJJUri } from '../uri';
import { FileStatus } from '../jj/types';

export function provideOriginalResource(uri: vscode.Uri) {
  if (!['file', 'jj'].includes(uri.scheme)) {
    return undefined;
  }

  let rev = '@';
  if (uri.scheme === 'jj') {
    const params = getParams(uri);
    if ('diffOriginalRev' in params) {
      // It doesn't make sense to show a quick diff for the left side of a diff. Diffception?
      return undefined;
    }
    rev = params.rev;
  }
  const filePath = uri.fsPath;
  const originalUri = toJJUri(vscode.Uri.file(filePath), {
    diffOriginalRev: rev,
  });

  return originalUri;
}

export function getResourceStateCommand(
  fileStatus: FileStatus,
  beforeUri: vscode.Uri,
  afterUri: vscode.Uri,
): vscode.Command {
  if (fileStatus.type === 'D') {
    return {
      title: 'Open',
      command: 'vscode.open',
      arguments: [
        beforeUri,
        {} satisfies vscode.TextDocumentShowOptions,
        `${fileStatus.file} (Deleted)`,
      ],
    };
  }
  return {
    title: 'Open',
    command: 'vscode.open',
    arguments: [afterUri],
  };
}
