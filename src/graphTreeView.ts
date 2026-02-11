import {
  EventEmitter,
  TreeDataProvider,
  TreeItem,
  Event,
  TreeView,
  window,
  MarkdownString,
  TreeItemCollapsibleState,
  TreeItemLabel,
  ProviderResult,
  workspace,
  ThemeIcon,
} from "vscode";
import { ChangeWithDetails, JJRepository } from "./repository";
import path from "path";

function getChangeDescription(change: ChangeWithDetails): TreeItemLabel {
  return {
    label:
      change.description.split("\n")[0].trim() ||
      `[${change.changeId.slice(0, 8)}]`,
  };
}

function getChangeTooltip(change: ChangeWithDetails): MarkdownString {
  const str = new MarkdownString(change.description || "(no description)");

  str.appendMarkdown(`\n\n**Change ID:** ${change.changeId}`);
  str.appendMarkdown(`\n\n**Commit ID:** ${change.commitId}`);
  str.appendMarkdown(`\n\n**Author:** ${change.author.name || "(unknown)"}`);
  if (change.author.email) {
    str.appendMarkdown(` \\<${change.author.email}\\>`);
  }
  str.appendMarkdown(`\n\n**Date:** ${change.authoredDate}`);
  if (change.bookmarks && change.bookmarks.length > 0) {
    str.appendMarkdown(`\n\n**Bookmarks:** ${change.bookmarks.join(", ")}`);
  }

  return str;
}

export class GraphTreeView {
  private readonly subscriptions: {
    dispose(): unknown;
  }[] = [];
  private readonly graphTreeView: TreeView<GraphTreeItem>;

  constructor(private readonly treeDataProvider: GraphTreeDataProvider) {
    this.graphTreeView = window.createTreeView<GraphTreeItem>("jjGraph", {
      treeDataProvider: this.treeDataProvider,
    });
    this.updateTitle(this.treeDataProvider.getSelectedRepo().repositoryRoot);
    this.graphTreeView.onDidChangeVisibility((e) => {
      // Update the selection whenver the tree view becomes visible. We cannot
      // do any selection updates while the view is hidden since would cause
      // disruptive panel switching.
      if (e.visible) {
        void this.treeDataProvider.updateSelection(this.graphTreeView);
      }
    });
    this.subscriptions.push(this.graphTreeView);
  }

  async setSelectedRepo(repo: JJRepository) {
    await this.treeDataProvider.setSelectedRepo(repo, this.graphTreeView);
    this.updateTitle(repo.repositoryRoot);
  }

  getRepositoryRoot(): string {
    return this.treeDataProvider.getSelectedRepo().repositoryRoot;
  }

  async refresh() {
    await this.treeDataProvider.refresh(this.graphTreeView);
  }

  dispose() {
    this.subscriptions.forEach((s) => s.dispose());
  }

  private updateTitle(repoName: string) {
    this.graphTreeView.title = `Commits (${path.basename(repoName)})`;
  }
}

export class GraphTreeItem extends TreeItem {
  constructor(
    private readonly change: ChangeWithDetails,
    private readonly childrenChangeIds: string[],
    private readonly dataProvider: GraphTreeDataProvider,
  ) {
    super(
      getChangeDescription(change),
      childrenChangeIds.length > 0
        ? TreeItemCollapsibleState.Expanded
        : TreeItemCollapsibleState.None,
    );
    this.id = this.change.changeId;
    this.iconPath = this.getIcon();
    if (this.change.isEmpty) {
      this.description = "empty";
    }
    if (!this.change.isImmutable) {
      this.contextValue = "mutable";
    }
    this.tooltip = getChangeTooltip(change);
    this.command = {
      command: "jj.update",
      title: "Update",
      arguments: [this],
    };
  }

  getChangeId(): string {
    return this.change.changeId;
  }

  getDescription(): string {
    return this.change.description;
  }

  getChildrenChangeIds(): string[] {
    return this.childrenChangeIds;
  }

  getParentChangeIds(): string[] {
    return this.change.parentChangeIds;
  }

  getRepository(): JJRepository {
    return this.dataProvider.getSelectedRepo();
  }

  equals(other: GraphTreeItem): boolean {
    return (
      this.id === other.id &&
      this.collapsibleState === other.collapsibleState &&
      this.iconPath === other.iconPath &&
      this.description === other.description &&
      this.contextValue === other.contextValue
    );
  }

  private getIcon(): ThemeIcon | undefined {
    if (this.change.isImmutable) {
      return new ThemeIcon("lock");
    }
    if (!this.change.isSynced) {
      return new ThemeIcon("cloud-upload");
    }
    if (this.change.bookmarks.length > 0) {
      return new ThemeIcon("bookmark");
    }
    return undefined;
  }
}

export class GraphTreeDataProvider implements TreeDataProvider<GraphTreeItem> {
  private readonly onDidChangeTreeDataInternal: EventEmitter<
    GraphTreeItem | undefined | null | void
  > = new EventEmitter();
  onDidChangeTreeData: Event<GraphTreeItem | undefined | null | void> =
    this.onDidChangeTreeDataInternal.event;

  private items: GraphTreeItem[] = [];
  private itemChangeIds = new Set<string>();
  private workingCopyChange: ChangeWithDetails | undefined;

  constructor(private selectedRepository: JJRepository) {}

  getTreeItem(element: TreeItem): TreeItem {
    return element;
  }

  getChildren(element?: GraphTreeItem): GraphTreeItem[] {
    if (element) {
      const childrenChangeIds = element.getChildrenChangeIds();
      return this.items.filter((item) =>
        childrenChangeIds.includes(item.getChangeId()),
      );
    }
    // The item is a root item in the graph if none of its parent change IDs are
    // present in the itemChangeIds set.
    return this.items.filter((item) =>
      item.getParentChangeIds().every((id) => !this.itemChangeIds.has(id)),
    );
  }

  async refresh(treeView: TreeView<GraphTreeItem>) {
    const prev = [...this.items];

    const graphConfig = workspace.getConfiguration("ukemi.graph");
    const useConfigLogRevset = graphConfig.get<boolean>(
      "useConfigLogRevset",
      false,
    );
    const revset = graphConfig.get<string>("revset", "::");

    const results = await this.selectedRepository.showAll(
      useConfigLogRevset ? [] : [revset],
    );
    const items: GraphTreeItem[] = [];
    const itemChangeIds = new Set<string>();
    for (const result of results) {
      // Don't render the working copy in the graph.
      if (result.change.isCurrentWorkingCopy) {
        this.workingCopyChange = result.change;
        continue;
      }
      const childrenChangeIds = results
        .filter(
          (r) =>
            !r.change.isCurrentWorkingCopy &&
            r.change.parentChangeIds.includes(result.change.changeId),
        )
        .map((r) => r.change.changeId);
      const item = new GraphTreeItem(result.change, childrenChangeIds, this);
      items.push(item);
      itemChangeIds.add(result.change.changeId);
    }
    this.items = items;
    this.itemChangeIds = itemChangeIds;
    if (
      prev.length !== this.items.length ||
      !prev.every((change, i) => change.equals(this.items[i]))
    ) {
      this.onDidChangeTreeDataInternal.fire();
    }
    await this.updateSelection(treeView);
  }

  async setSelectedRepo(repo: JJRepository, treeView: TreeView<GraphTreeItem>) {
    const prevRepo = this.selectedRepository;
    this.selectedRepository = repo;
    if (prevRepo.repositoryRoot !== repo.repositoryRoot) {
      await this.refresh(treeView);
    }
  }

  getSelectedRepo() {
    return this.selectedRepository;
  }

  getParent(element: GraphTreeItem): ProviderResult<GraphTreeItem> {
    const parentChangeIds = element.getParentChangeIds();
    if (parentChangeIds.length === 0) {
      return undefined;
    }
    return this.items.find((item) => item.getChangeId() === parentChangeIds[0]);
  }

  async updateSelection(treeView: TreeView<GraphTreeItem>) {
    // Only reveal items if the tree view is currently visible. Otherwise we
    // would end up potentially switching panels in the sidebar. We always
    // perform automatic re-selection on visibility change.
    if (!treeView.visible || !this.workingCopyChange) {
      return;
    }
    for (const item of this.items) {
      if (this.workingCopyChange.parentChangeIds.includes(item.getChangeId())) {
        await treeView.reveal(item, { select: true, focus: false });
      }
    }
  }
}
