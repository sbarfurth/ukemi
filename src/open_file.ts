import * as vscode from "vscode";
import {
  provideOriginalResource,
  WorkspaceSourceControlManager,
} from "./repository";
import { getParams } from "./uri";
import { pathEquals } from "./utils";
import path from "path";

export async function openFile(uri: vscode.Uri): Promise<void> {
  try {
    if (!["file", "jj"].includes(uri.scheme)) {
      return undefined;
    }

    let rev = "@";
    if (uri.scheme === "jj") {
      const params = getParams(uri);
      if ("diffOriginalRev" in params) {
        rev = params.diffOriginalRev;
      } else {
        rev = params.rev;
      }
    }

    await vscode.commands.executeCommand(
      "vscode.open",
      uri,
      {},
      `${path.basename(uri.fsPath)} (${rev.substring(0, 8)})`,
    );
  } catch (error) {
    vscode.window.showErrorMessage(
      `Failed to open file${error instanceof Error ? `: ${error.message}` : ""}`,
    );
  }
}

export async function openDiff(
  uri: vscode.Uri,
  workspaceSCM: WorkspaceSourceControlManager,
): Promise<void> {
  try {
    const originalUri = provideOriginalResource(uri);
    if (!originalUri) {
      throw new Error("Original resource not found");
    }

    const params = getParams(originalUri);
    if (!("diffOriginalRev" in params)) {
      throw new Error(
        "Original resource does not have a diffOriginalRev. This is a bug.",
      );
    }

    const rev = params.diffOriginalRev;

    const scm =
      workspaceSCM.getRepositorySourceControlManagerFromUri(originalUri);

    if (!scm) {
      throw new Error("Source Control Manager not found with given URI.");
    }

    const repo = workspaceSCM.getRepositoryFromUri(originalUri);
    if (!repo) {
      throw new Error("Repository could not be found with given URI.");
    }

    const { fileStatuses } = await repo.show(rev);
    const fileStatus = fileStatuses.find((file) =>
      pathEquals(file.path, originalUri.path),
    );

    const diffTitleSuffix =
      rev === "@" ? "(Working Copy)" : `(${rev.substring(0, 8)})`;
    await vscode.commands.executeCommand(
      "vscode.diff",
      originalUri,
      // Always open the editable working copy on the right rather than the
      // resource URI, which may be from a past revision.
      vscode.Uri.file(uri.fsPath),
      (fileStatus?.renamedFrom ? `${fileStatus.renamedFrom} => ` : "") +
        `${path.relative(repo.repositoryRoot, originalUri.path)} ${diffTitleSuffix}`,
    );
  } catch (error) {
    vscode.window.showErrorMessage(
      `Failed to open diff${error instanceof Error ? `: ${error.message}` : ""}`,
    );
  }
}
