import * as vscode from "vscode";
import * as fs from "fs";
import type { JJRepository } from "./repository";
import path from "path";

type Message = {
  command: string;
  changeId: string;
  selectedNodes: string[];
};

export class ChangeNode {
  label: string;
  description: string;
  tooltip: string;
  contextValue: string;
  parentChangeIds?: string[];
  branchType?: string;
  bookmarks?: string[];
  commitId?: string;
  email?: string;
  timestamp?: string;

  constructor(
    label: string,
    description: string,
    tooltip: string,
    contextValue: string,
    parentChangeIds?: string[],
    branchType?: string,
    bookmarks?: string[],
    commitId?: string,
    email?: string,
    timestamp?: string,
  ) {
    this.label = label;
    this.description = description;
    this.tooltip = tooltip;
    this.contextValue = contextValue;
    this.parentChangeIds = parentChangeIds;
    this.branchType = branchType;
    this.bookmarks = bookmarks;
    this.commitId = commitId;
    this.email = email;
    this.timestamp = timestamp;
  }
}

export function parseJJLog(output: string): ChangeNode[] {
  const lines = output.split("\n").filter((line) => line.trim() !== "");
  const changeNodes: ChangeNode[] = [];

  for (const line of lines) {
    // Format: change_id|email|timestamp|bookmarks|commit_id|branch_indicator|is_empty|description
    const parts = line.split("|");
    if (parts.length < 8) {
      continue;
    }

    const [
      changeId,
      email,
      timestamp,
      bookmarksStr,
      commitId,
      branchIndicator,
      isEmptyStr,
      rawDescription,
    ] = parts;

    let description = rawDescription;

    // Filter out redundant branch indicators or clean them up if needed
    // logic for branchType (diamond vs circle)
    let branchType = undefined;
    if (branchIndicator.trim() === "◆") {
      branchType = "◆";
    } else {
      branchType = "○";
    }

    // Parse bookmarks
    const bookmarks = bookmarksStr && bookmarksStr.trim().length > 0
      ? bookmarksStr.split(",").map(b => b.trim())
      : [];

    // Handle empty commits and missing descriptions
    if (!description || description.trim().length === 0) {
      description = "(no description set)";
    }

    if (isEmptyStr.trim() === "true") {
      description = `(empty) ${description}`;
    }

    // Construct simplified label (though frontend uses description directly now)
    const formattedLabel = `${description}`;

    changeNodes.push(
      new ChangeNode(
        formattedLabel,
        description,
        `${email} ${timestamp}`,
        changeId,
        undefined,
        branchType,
        bookmarks,
        commitId,
        email,
        timestamp,
      ),
    );
  }
  return changeNodes;
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
    // Format: change_id|email|timestamp|bookmarks|commit_id|branch_indicator|is_empty|description
    const template = `
      concat(
        self.change_id().short(), "|",
        author.email(), "|",
        author.timestamp().format("%Y-%m-%d %H:%M:%S"), "|",
        bookmarks.map(|b| b.name()).join(", "), "|",
        self.commit_id().short(), "|",
        if(self.contained_in("visible_heads()"), "◆", "○"), "|",
        if(self.empty(), "true", "false"), "|",
        description.first_line(),
        "\\n"
      )
    `;

    // Collect all changes
    const output = await this.repository.log(
      "::", // get all changes
      template,
      50,
      true, // noGraph - we get graph structure from getChangeNodesWithParents
    );

    let changes = parseJJLog(output);
    changes = await this.getChangeNodesWithParents(changes);

    const status = await this.repository.getStatus(true);
    const workingCopyId = status.workingCopy.changeId;

    this.selectedNodes.clear();
    this.panel.webview.postMessage({
      command: "updateGraph",
      changes: changes,
      workingCopyId,
      preserveScroll: true,
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

  private async getChangeNodesWithParents(
    changeNodes: ChangeNode[],
  ): Promise<ChangeNode[]> {
    const output = await this.repository.log(
      "::", // get all changes
      `
        if(root,
          "root()",
          concat(
            self.change_id().short(),
            " ",
            parents.map(|p| p.change_id().short()).join(" "),
            "\n"
          )
        )
        `,
      50,
      false,
    );

    const lines = output.split("\n");

    // Build a map of change IDs to their parent IDs
    const parentMap = new Map<string, string[]>();

    for (const line of lines) {
      // Extract only alphanumeric strings from the line
      const ids = line.match(/[a-zA-Z0-9]+/g) || [];
      if (ids.length < 1) {
        continue;
      }

      // Check for root() after cleaning up symbols
      if (ids[0] === "root") {
        continue;
      }

      const [changeId, ...parentIds] = ids;
      if (!changeId) {
        continue;
      }

      // Use the full ID provided by the log command
      parentMap.set(
        changeId,
        parentIds,
      );
    }

    // Assign parents to nodes using the map
    const res = changeNodes.map((node) => {
      if (node.contextValue) {
        node.parentChangeIds = parentMap.get(node.contextValue) || [];
      }
      return node;
    });

    return res;
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


