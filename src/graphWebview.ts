import * as vscode from "vscode";
import * as fs from "fs";
import type { JJRepository } from "./repository";
import path from "path";
import { getGraphConfig } from "./config";

type Message = {
  command: string;
  changeId: string;
  selectedNodes: string[];
};

export class ChangeNode {
  constructor(
    readonly label: string,
    readonly description: string,
    readonly isImmutable: boolean,
    readonly tooltip: string,
    readonly contextValue: string,
    readonly shortestChangeId: string,
    readonly parentChangeIds?: string[],
    readonly branchType?: string,
    readonly bookmarks?: string[],
    readonly commitId?: string,
    readonly shortestCommitId?: string,
    readonly email?: string,
    readonly timestamp?: string,
    readonly timestampAgo?: string,
  ) {}
}

export class JJGraphWebview implements vscode.WebviewViewProvider {
  subscriptions: {
    dispose(): unknown;
  }[] = [];

  public panel?: vscode.WebviewView;
  public repository: JJRepository;
  public selectedNodes: Set<string> = new Set();

  constructor(
    private readonly extensionUri: vscode.Uri,
    repo: JJRepository,
    private readonly context: vscode.ExtensionContext,
  ) {
    this.repository = repo;

    // Register the webview provider
    context.subscriptions.push(
      vscode.window.registerWebviewViewProvider("jjGraphWebview", this, {
        webviewOptions: {
          retainContextWhenHidden: true,
        },
      }),
    );

    // Auto-refresh when relevant configuration changes
    context.subscriptions.push(
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration("ukemi.graph")) {
          void this.refresh();
        }
      }),
    );
  }

  public async resolveWebviewView(
    webviewView: vscode.WebviewView,
  ): Promise<void> {
    this.panel = webviewView;
    this.panel.title = `Source Control Graph (${path.basename(this.repository.repositoryRoot)})`;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this.extensionUri],
    };

    webviewView.webview.html = this.getWebviewContent(webviewView.webview);

    await new Promise<void>((resolve) => {
      const messageListener = webviewView.webview.onDidReceiveMessage(
        (message: Message) => {
          if (message.command === "webviewReady") {
            messageListener.dispose();
            resolve();
          }
        },
      );
    });

    webviewView.webview.onDidReceiveMessage(async (message: Message) => {
      switch (message.command) {
        case "editChange":
          try {
            await this.repository.editRetryImmutable(message.changeId);
          } catch (error: unknown) {
            vscode.window.showErrorMessage(
              `Failed to switch to change: ${error as string}`,
            );
          }
          break;
        case "selectChange":
          this.selectedNodes = new Set(message.selectedNodes);
          vscode.commands.executeCommand(
            "setContext",
            "jjGraphView.nodesSelected",
            message.selectedNodes.length,
          );
          break;
      }
    });

    await this.refresh();
  }

  public async setSelectedRepository(repo: JJRepository) {
    const prevRepo = this.repository;
    this.repository = repo;
    if (this.panel) {
      this.panel.title = `Source Control Graph (${path.basename(this.repository.repositoryRoot)})`;
    }
    if (prevRepo.repositoryRoot !== repo.repositoryRoot) {
      await this.refresh();
    }
  }

  public async refresh() {
    if (!this.panel) {
      return;
    }

    // Use a custom template to ensure we get all the fields we need in a parseable format
    // Format: JJLOGSTART|change_id|parents|email|timestamp|bookmarks|commit_id|branch_indicator|is_empty|description
    const template = `
      concat(
        "JJLOGSTART|",
        self.change_id().short(), "|",
        self.change_id().shortest(), "|",
        parents.map(|p| p.change_id().short()).join(" "), "|",
        author.email(), "|",
        author.timestamp().format("%Y-%m-%d %H:%M:%S"), "|",
        author.timestamp().ago(), "|",
        bookmarks.map(|b| b.name()).join(", "), "|",
        self.commit_id().short(), "|",
        self.commit_id().shortest(), "|",
        if(self.working_copies(), "@", if(self.contained_in("visible_heads()"), "◆", "○")), "|",
        if(self.empty(), "true", "false"), "|",
        if(self.immutable(), "true", "false"), "|",
        description.first_line(),
        "\\n"
      )
    `;

    const {
      useConfigLogRevset,
      revset,
      limit,
      showAuthor,
      showBookmarks,
      showCommitId,
      showTimestamp,
    } = getGraphConfig();

    // Collect all changes in a single pass (graph structure + data)
    const output = await this.repository.log(
      useConfigLogRevset ? null : revset,
      template,
      limit,
      false, // noGraph: false (we want the graph structure)
    );

    const changes = parseJJLog(output);

    const status = await this.repository.getStatus(true);
    const workingCopyId = status.workingCopy.changeId;

    this.selectedNodes.clear();
    this.panel.webview.postMessage({
      command: "updateGraph",
      changes: changes,
      workingCopyId,
      preserveScroll: true,
      showAuthor,
      showBookmarks,
      showCommitId,
      showTimestamp,
    });
  }

  private getWebviewContent(webview: vscode.Webview) {
    // In development, files are in src/webview
    // In production (bundled extension), files are in dist/webview
    const webviewPath = this.extensionUri.fsPath.includes("extensions")
      ? "dist"
      : "src";

    const cssPath = vscode.Uri.joinPath(
      this.extensionUri,
      webviewPath,
      "webview",
      "graph.css",
    );
    const cssUri = webview.asWebviewUri(cssPath);

    const codiconPath = vscode.Uri.joinPath(
      this.extensionUri,
      webviewPath === "dist"
        ? "dist/codicons"
        : "node_modules/@vscode/codicons/dist",
      "codicon.css",
    );
    const codiconUri = webview.asWebviewUri(codiconPath);

    const htmlPath = vscode.Uri.joinPath(
      this.extensionUri,
      webviewPath,
      "webview",
      "graph.html",
    );
    let html = fs.readFileSync(htmlPath.fsPath, "utf8");

    // Replace placeholders in the HTML
    html = html.replace("${cssUri}", cssUri.toString());
    html = html.replace("${codiconUri}", codiconUri.toString());

    return html;
  }

  areChangeNodesEqual(a: ChangeNode[], b: ChangeNode[]): boolean {
    if (a.length !== b.length) {
      return false;
    }

    return a.every((nodeA, index) => {
      const nodeB = b[index];
      return (
        nodeA.label === nodeB.label &&
        nodeA.tooltip === nodeB.tooltip &&
        nodeA.description === nodeB.description &&
        nodeA.contextValue === nodeB.contextValue
      );
    });
  }

  dispose() {
    this.subscriptions.forEach((s) => s.dispose());
  }
}

export function parseJJLog(output: string): ChangeNode[] {
  const lines = output.split("\n").filter((line) => line.trim() !== "");
  const changeNodes: ChangeNode[] = [];

  for (const line of lines) {
    // Use the sentinel to find the start of our data, ignoring graph characters
    const sentinelIndex = line.indexOf("JJLOGSTART|");
    if (sentinelIndex === -1) {
      continue;
    }

    const dataPart = line.substring(sentinelIndex + "JJLOGSTART|".length);
    const parts = dataPart.split("|");

    if (parts.length < 13) {
      continue;
    }

    const [
      changeId,
      shortestChangeId,
      parentsStr,
      email,
      timestamp,
      timestampAgo,
      bookmarksStr,
      commitId,
      shortestCommitId,
      branchIndicator,
      isEmptyStr,
      isImmutableStr,
      rawDescription,
    ] = parts;

    let description = rawDescription;
    // const paddingMarker = "JJLOGSTART|";

    // Filter out redundant branch indicators or clean them up if needed
    // logic for branchType (diamond vs circle)
    let branchType = undefined;
    if (branchIndicator.trim() === "◆") {
      branchType = "◆";
    } else if (branchIndicator.trim() === "@") {
      branchType = "@";
    } else {
      branchType = "○";
    }

    // Parse bookmarks
    const bookmarks =
      bookmarksStr && bookmarksStr.trim().length > 0
        ? bookmarksStr.split(",").map((b) => b.trim())
        : [];

    // Parse parents
    const parentChangeIds =
      parentsStr && parentsStr.trim().length > 0
        ? parentsStr.split(" ").map((p) => p.trim())
        : [];

    // Handle empty commits and missing descriptions
    if (!description || description.trim().length === 0) {
      description = "(no description set)";
    }

    if (isEmptyStr.trim() === "true") {
      description = `(empty) ${description}`;
    }

    const isImmutable = isImmutableStr.trim() === "true";

    // Construct simplified label (though frontend uses description directly now)
    const formattedLabel = `${description}`;

    changeNodes.push(
      new ChangeNode(
        formattedLabel,
        description,
        isImmutable,
        `${description}\n\n${email} ${timestamp}`,
        changeId,
        shortestChangeId,
        parentChangeIds,
        branchType,
        bookmarks,
        commitId,
        shortestCommitId,
        email,
        timestamp,
        timestampAgo,
      ),
    );
  }
  return changeNodes;
}
