import * as vscode from "vscode";
import { GitHubRepository, GHComment, GHPR, GHThreadInfo } from "./github";
import { JJRepository } from "./repository";
import { getConfig } from "./config";
import { getLogger } from "./logger";
import path from "path";

interface ThreadMetadata {
  prNumber: number;
  repoSlug: string;
  rootCommentId: number;
  threadNodeId: string;
}

export class CommentControllerManager {
  private commentController: vscode.CommentController;
  private prCache = new Map<string, GHPR | null>(); // rev -> PR
  private commentsCache = new Map<number, GHComment[]>(); // PR number -> comments
  private threadsCache = new Map<number, GHThreadInfo[]>(); // PR number -> threads
  private threads = new Map<string, vscode.CommentThread[]>(); // uri -> threads
  private threadMetadata = new Map<vscode.CommentThread, ThreadMetadata>();
  private currentPR: GHPR | null = null;
  private currentRepoSlug: string | null = null;
  private disposables: vscode.Disposable[] = [];

  constructor(
    private repository: JJRepository,
    private githubRepository: GitHubRepository,
  ) {
    this.commentController = vscode.comments.createCommentController(
      "ukemi-comments",
      "GitHub PR Comments",
    );
    this.disposables.push(this.commentController);

    this.commentController.commentingRangeProvider = {
      provideCommentingRanges: (document: vscode.TextDocument) => {
        return [new vscode.Range(0, 0, document.lineCount - 1, 0)];
      },
    };
  }

  public async handleReply(thread: vscode.CommentThread, text: string, resolve: boolean) {
    const metadata = this.threadMetadata.get(thread);
    if (!metadata) {
      return;
    }

    try {
      // Optimistic UI update
      if (resolve) {
        thread.collapsibleState = vscode.CommentThreadCollapsibleState.Collapsed;
        thread.state = vscode.CommentThreadState.Resolved;
        thread.label = "PR Review (Resolved)";
      }

      if (text) {
        await this.githubRepository.postReply(metadata.prNumber, metadata.repoSlug, metadata.rootCommentId, text);
      }

      if (resolve) {
        await this.githubRepository.resolveThread(metadata.threadNodeId, metadata.repoSlug);
      }

      // Background refresh to confirm state
      void this.refreshComments(thread.uri, true);
    } catch (e) {
      getLogger().error(`Failed to handle reply: ${String(e)}`);
      vscode.window.showErrorMessage(`Failed to post reply: ${String(e)}`);
      void this.refreshComments(thread.uri, true);
    }
  }

  public async handleMarkDone(thread: vscode.CommentThread) {
    const metadata = this.threadMetadata.get(thread);
    if (!metadata) {
      return;
    }

    try {
      // Optimistic UI update
      thread.collapsibleState = vscode.CommentThreadCollapsibleState.Collapsed;
      thread.state = vscode.CommentThreadState.Resolved;
      thread.label = "PR Review (Resolved)";

      await this.githubRepository.postReply(metadata.prNumber, metadata.repoSlug, metadata.rootCommentId, "done");
      await this.githubRepository.resolveThread(metadata.threadNodeId, metadata.repoSlug);
      
      void this.refreshComments(thread.uri, true);
    } catch (e) {
      getLogger().error(`Failed to mark as done: ${String(e)}`);
      vscode.window.showErrorMessage(`Failed to mark as done: ${String(e)}`);
      void this.refreshComments(thread.uri, true);
    }
  }

  async refreshComments(uri?: vscode.Uri, force = false) {
    if (uri && uri.scheme !== "file") {
      return;
    }

    if (force) {
      this.clearCache();
    }

    const config = getConfig(uri);
    const remoteName = config.githubRemote || "origin";

    // 1. Get remote info
    const remotes = await this.repository.getRemotes();
    const remoteUrl = remotes.get(remoteName);
    if (!remoteUrl) {
      getLogger().debug(`[GH Comments] Remote ${remoteName} not found. Available: ${Array.from(remotes.keys()).join(", ")}`);
      return;
    }

    const repoInfo = GitHubRepository.parseRemoteUrl(remoteUrl);
    if (!repoInfo) {
      getLogger().debug(`[GH Comments] Could not parse remote URL: ${remoteUrl}`);
      return;
    }

    const repoSlug = `${repoInfo.owner}/${repoInfo.repo}`;

    // 0. Check authentication for this org
    if (!(await this.githubRepository.checkAuth(repoInfo.owner))) {
      getLogger().debug(`[GH Comments] No valid authentication found for ${repoInfo.owner}. Skipping refresh.`);
      this.clearComments();
      return;
    }

    getLogger().debug(`[GH Comments] Refreshing comments for ${repoSlug} (force: ${force})`);

    // 2. Find PR by walking up from @
    const pr = await this.findPRForRev("@", repoSlug, config.githubPRSearchLimit);
    
    // If the PR changed, clear EVERYTHING
    if (this.currentPR?.number !== pr?.number || this.currentRepoSlug !== repoSlug) {
      getLogger().info(`[GH Comments] Active PR changed from #${this.currentPR?.number ?? "none"} to #${pr?.number ?? "none"}. Clearing all comments.`);
      this.clearComments();
      this.currentPR = pr;
      this.currentRepoSlug = repoSlug;
    }

    if (!pr) {
      getLogger().debug(`[GH Comments] No PR found for current commit stack in ${repoSlug}`);
      return;
    }

    // 3. Get comments and threads for the PR
    let comments = this.commentsCache.get(pr.number);
    let threads = this.threadsCache.get(pr.number);
    if (!comments || !threads || force) {
      getLogger().info(`[GH Comments] Fetching comments and threads for PR #${pr.number} in ${repoSlug}...`);
      [comments, threads] = await Promise.all([
        this.githubRepository.getPRComments(pr.number, repoSlug),
        this.githubRepository.getPRThreads(pr.number, repoSlug)
      ]);
      this.commentsCache.set(pr.number, comments);
      this.threadsCache.set(pr.number, threads);
      getLogger().info(`[GH Comments] Loaded ${comments.length} review comments and ${threads.length} threads for PR #${pr.number}`);

      // Immediately display ALL comments for ALL files to populate sidebar
      this.displayAllComments(comments, threads, pr.number, repoSlug);
    } else {
      getLogger().debug(`[GH Comments] Using cached data for PR #${pr.number} (${comments.length} comments)`);
    }
  }

  private displayAllComments(comments: GHComment[], threads: GHThreadInfo[], prNumber: number, repoSlug: string) {
    getLogger().debug(`[GH Comments] Synchronizing ${comments.length} comments across files...`);
    
    // Group all comments by file path
    const commentsByFile = new Map<string, GHComment[]>();
    for (const comment of comments) {
      if (!commentsByFile.has(comment.path)) {
        commentsByFile.set(comment.path, []);
      }
      commentsByFile.get(comment.path)!.push(comment);
    }

    // Clear existing threads
    this.clearComments();

    let threadCount = 0;
    for (const [filePath, fileComments] of commentsByFile) {
      const fullPath = path.join(this.repository.repositoryRoot, filePath);
      const uri = vscode.Uri.file(fullPath);
      this.displayComments(uri, fileComments, threads, prNumber, repoSlug, false);
      threadCount += this.threads.get(uri.toString())?.length ?? 0;
    }
    getLogger().info(`[GH Comments] Created ${threadCount} comment threads across ${commentsByFile.size} files.`);
  }

  private async findPRForRev(rev: string, repoSlug: string, depth: number): Promise<GHPR | null> {
    if (depth <= 0) {
      return null;
    }

    try {
      const showResult = await this.repository.show(rev);
      const commitId = showResult.change.commitId;

      // Check cache using commitId
      if (this.prCache.has(commitId)) {
        return this.prCache.get(commitId)!;
      }

      // Check bookmarks and remoteBookmarks for PR
      const allBookmarks = [...showResult.change.bookmarks, ...showResult.change.remoteBookmarks];
      getLogger().debug(`Checking rev ${rev.substring(0, 8)} (${commitId.substring(0, 8)}) with bookmarks: ${allBookmarks.join(", ")}`);

      for (const bookmark of allBookmarks) {
        const pr = await this.githubRepository.findPRByBranch(bookmark, repoSlug);
        if (pr) {
          getLogger().debug(`Matched bookmark ${bookmark} to PR #${pr.number}`);
          this.prCache.set(commitId, pr);
          return pr;
        }
      }

      // Walk up to parents
      for (const parentId of showResult.change.parentChangeIds) {
        const pr = await this.findPRForRev(parentId, repoSlug, depth - 1);
        if (pr) {
          this.prCache.set(commitId, pr);
          return pr;
        }
      }

      this.prCache.set(commitId, null);
    } catch (e) {
      getLogger().error(`Error while walking up revs for PR at ${rev}: ${String(e)}`);
    }

    return null;
  }

  private clearCache() {
    getLogger().debug("GitHub PR and comments cache cleared.");
    this.prCache.clear();
    this.commentsCache.clear();
    this.threadsCache.clear();
    this.githubRepository.invalidateAuthCache();
  }

  private displayComments(uri: vscode.Uri, fileComments: GHComment[], threads: GHThreadInfo[], prNumber: number, repoSlug: string, _clearExisting = true) {
    if (fileComments.length === 0) {
      // If no comments, but we have threads for this URI, we might need to dispose them
      // But only if clearExisting was true, which it is for the full refresh.
      // If clearExisting is false (incremental), we should be careful.
      // For now, if fileComments is empty and we are in this function, it usually means we want to show nothing for this file 
      // OR we are iterating over all files.
      // implementation below handles disposal of stale threads.
    }

    // Group comments by line to create threads (simplified grouping)
    const threadsByLine = new Map<number, GHComment[]>();
    for (const comment of fileComments) {
      if (comment.line === null) {
        continue;
      }
      const line = comment.line - 1; // GH is 1-based, VS Code is 0-based
      if (line < 0) {
        continue;
      }
      if (!threadsByLine.has(line)) {
        threadsByLine.set(line, []);
      }
      threadsByLine.get(line)!.push(comment);
    }

    const uriString = uri.toString();
    const currentFileThreads = this.threads.get(uriString) || [];
    const usedThreads = new Set<vscode.CommentThread>();

    // Create or update threads
    for (const [line, lineComments] of threadsByLine) {
      // Sort comments by creation date
      lineComments.sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime());

      // Find the thread node_id for this conversation
      const rootComment = lineComments[0];
      const threadInfo = threads.find(t => t.rootCommentDatabaseId === rootComment.id);

      // Try to find an existing thread for this line and root comment
      // We use the root comment ID to uniquely identify the conversation
      let thread = currentFileThreads.find(t => {
        const meta = this.threadMetadata.get(t);
        return meta?.rootCommentId === rootComment.id && t.range && t.range.start.line === line;
      });

      const newComments = lineComments.map(c => this.mapToVSCodeComment(c));

      if (thread) {
        // Update existing thread
        thread.comments = newComments;
        usedThreads.add(thread);
      } else {
        // Create new thread
        thread = this.commentController.createCommentThread(
          uri,
          new vscode.Range(line, 0, line, 0),
          newComments
        );
        currentFileThreads.push(thread);
        usedThreads.add(thread);
      }

      if (threadInfo) {
        this.threadMetadata.set(thread, {
          prNumber,
          repoSlug,
          rootCommentId: rootComment.id,
          threadNodeId: threadInfo.id
        });
      }

      // Update state
      const isResolved = threadInfo?.isResolved ?? false;
      thread.collapsibleState = isResolved 
        ? vscode.CommentThreadCollapsibleState.Collapsed 
        : vscode.CommentThreadCollapsibleState.Expanded;
      thread.state = isResolved
        ? vscode.CommentThreadState.Resolved 
        : vscode.CommentThreadState.Unresolved;
      thread.label = `PR Review${isResolved ? " (Resolved)" : ""}`;
    }

    // Dispose of threads that are no longer present for this file
    // active threads are in usedThreads
    const keptThreads: vscode.CommentThread[] = [];
    for (const thread of currentFileThreads) {
      if (!usedThreads.has(thread)) {
        this.threadMetadata.delete(thread);
        thread.dispose();
      } else {
        keptThreads.push(thread);
      }
    }

    if (keptThreads.length > 0) {
      this.threads.set(uriString, keptThreads);
    } else {
      this.threads.delete(uriString);
    }
  }

  private mapToVSCodeComment(ghComment: GHComment): vscode.Comment {
    return {
      author: {
        name: ghComment.user.login,
      },
      body: new vscode.MarkdownString(ghComment.body),
      mode: vscode.CommentMode.Preview,
      contextValue: "gh-comment",
    };
  }

  private clearComments(uri?: vscode.Uri) {
    if (uri) {
      const uriString = uri.toString();
      const existingThreads = this.threads.get(uriString);
      if (existingThreads) {
        existingThreads.forEach(t => {
          this.threadMetadata.delete(t);
          t.dispose();
        });
        this.threads.delete(uriString);
      }
    } else {
      for (const uriString of this.threads.keys()) {
        const existingThreads = this.threads.get(uriString);
        if (existingThreads) {
          existingThreads.forEach(t => {
            this.threadMetadata.delete(t);
            t.dispose();
          });
        }
      }
      this.threads.clear();
      this.threadMetadata.clear();
    }
  }

  dispose() {
    this.clearComments();
    this.disposables.forEach((d) => {
      d.dispose();
    });
  }
}
