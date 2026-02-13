import * as vscode from "vscode";
import spawn from "cross-spawn";
import { getConfig } from "./config";
import { getLogger } from "./logger";
import { ChildProcess } from "child_process";

export interface GHComment {
  id: number;
  node_id: string;
  body: string;
  path: string;
  line: number | null;
  user: {
    login: string;
  };
  created_at: string;
  diff_hunk: string;
}

export interface GHPR {
  number: number;
  url: string;
  headRefName: string;
  title: string;
}

export interface GHThreadInfo {
  id: string; // Thread node_id
  isResolved: boolean;
  rootCommentDatabaseId: number;
}

interface GraphQLResponse {
  data: {
    repository: {
      pullRequest: {
        reviewThreads: {
          nodes: Array<{
            id: string;
            isResolved: boolean;
            comments: {
              nodes: Array<{
                databaseId: number;
              }>;
            };
          }>;
        };
      };
    };
  };
}

export class GitHubRepository {
  constructor(
    private repositoryRoot: string,
    private ghPath: string,
  ) {}

  private isCachedAuthValid: boolean | undefined;

  async checkAuth(owner?: string): Promise<boolean> {
    const config = getConfig(vscode.Uri.file(this.repositoryRoot));
    if (config.githubToken || (owner && config.githubTokens[owner])) {
      return true;
    }

    if (this.isCachedAuthValid !== undefined) {
      return this.isCachedAuthValid;
    }

    try {
      // Check if the user is already authenticated via gh CLI
      await this.handleCommand(spawn(this.ghPath, ["auth", "status"], {
        cwd: this.repositoryRoot,
        env: process.env
      }));
      this.isCachedAuthValid = true;
    } catch {
      this.isCachedAuthValid = false;
    }
    return this.isCachedAuthValid;
  }

  invalidateAuthCache() {
    this.isCachedAuthValid = undefined;
  }

  private async handleCommand(childProcess: ChildProcess): Promise<Buffer> {
    return new Promise<Buffer>((resolve, reject) => {
      const output: Buffer[] = [];
      const errOutput: Buffer[] = [];
      childProcess.stdout!.on("data", (data: Buffer) => {
        output.push(data);
      });
      childProcess.stderr!.on("data", (data: Buffer) => {
        errOutput.push(data);
      });
      childProcess.on("error", (error: Error) => {
        reject(new Error(`Spawning gh failed: ${error.message}`));
      });
      childProcess.on("close", (code, signal) => {
        if (code) {
          reject(
            new Error(
              `gh failed with exit code ${code}.\nstdout: ${Buffer.concat(output).toString()}\nstderr: ${Buffer.concat(errOutput).toString()}`,
            ),
          );
        } else if (signal) {
          reject(
            new Error(
              `gh failed with signal ${signal}.\nstdout: ${Buffer.concat(output).toString()}\nstderr: ${Buffer.concat(errOutput).toString()}`,
            ),
          );
        } else {
          resolve(Buffer.concat(output));
        }
      });
    });
  }

  private async spawnGH(args: string[], owner?: string): Promise<Buffer> {
    const config = getConfig(vscode.Uri.file(this.repositoryRoot));
    const env: NodeJS.ProcessEnv = { ...process.env };
    
    let token = config.githubToken;
    if (owner && config.githubTokens[owner]) {
      token = config.githubTokens[owner];
    }

    if (token) {
      const trimmedToken = token.trim();
      env["GH_TOKEN"] = trimmedToken;
      env["GITHUB_TOKEN"] = trimmedToken;
    }

    const commandStr = `${this.ghPath} ${args.join(" ")}`;
    getLogger().debug(`Executing gh command: ${commandStr}`);

    const cp = spawn(this.ghPath, args, {
      cwd: this.repositoryRoot,
      env,
    });

    try {
      const output = await this.handleCommand(cp);
      return output;
    } catch (e) {
      getLogger().error(`gh command failed: ${commandStr}\n${String(e)}`);
      throw e;
    }
  }

  static parseRemoteUrl(url: string): { owner: string; repo: string } | undefined {
    // Matches:
    // git@github.com:owner/repo.git
    // https://github.com/owner/repo.git
    // https://github.com/owner/repo
    const match = url.match(/github\.com[:/]([^/]+)\/([^/.]+)(?:\.git)?$/);
    if (match) {
      return { owner: match[1], repo: match[2] };
    }
    return undefined;
  }

  async findPRByBranch(branchName: string, repoSlug: string): Promise<GHPR | undefined> {
    try {
      const owner = repoSlug.split("/")[0];
      const args = ["pr", "list", "--head", branchName, "--json", "number,url,headRefName,title"];
      if (repoSlug) {
        args.push("--repo", repoSlug);
      }
      const output = await this.spawnGH(args, owner);
      const prs = JSON.parse(output.toString()) as GHPR[];
      return prs.length > 0 ? prs[0] : undefined;
    } catch (e) {
      getLogger().error(`Failed to find PR for branch ${branchName}: ${String(e)}`);
      return undefined;
    }
  }

  async getPRComments(prNumber: number, repoSlug: string): Promise<GHComment[]> {
    try {
      const owner = repoSlug.split("/")[0];
      // Use gh api to fetch review comments directly
      const args = ["api", `repos/${repoSlug}/pulls/${prNumber}/comments`];
      const output = await this.spawnGH(args, owner);
      return JSON.parse(output.toString()) as GHComment[];
    } catch (e) {
      getLogger().error(`Failed to fetch comments for PR #${prNumber}: ${String(e)}`);
      return [];
    }
  }

  async getPRThreads(prNumber: number, repoSlug: string): Promise<GHThreadInfo[]> {
    try {
      const [owner, repo] = repoSlug.split("/");
      const query = `
        query($owner:String!, $repo:String!, $number:Int!) {
          repository(owner:$owner, name:$repo) {
            pullRequest(number: $number) {
              reviewThreads(last: 100) {
                nodes {
                  id
                  isResolved
                  comments(first: 1) {
                    nodes {
                      databaseId
                    }
                  }
                }
              }
            }
          }
        }
      `;
      const output = await this.spawnGH([
        "api",
        "graphql",
        "-f", `query=${query}`,
        "-f", `owner=${owner}`,
        "-f", `repo=${repo}`,
        "-F", `number=${prNumber}`
      ], owner);
      const response = JSON.parse(output.toString()) as GraphQLResponse;
      const threads = response.data.repository.pullRequest.reviewThreads.nodes;
      return threads.map((t) => ({
        id: t.id,
        isResolved: t.isResolved,
        rootCommentDatabaseId: t.comments.nodes[0]?.databaseId
      })).filter((t): t is GHThreadInfo => t.rootCommentDatabaseId !== undefined);
    } catch (e) {
      getLogger().error(`Failed to fetch threads for PR #${prNumber}: ${String(e)}`);
      return [];
    }
  }

  async postReply(prNumber: number, repoSlug: string, inReplyTo: number, body: string): Promise<GHComment | undefined> {
    try {
      const owner = repoSlug.split("/")[0];
      const args = [
        "api",
        `repos/${repoSlug}/pulls/${prNumber}/comments`,
        "-f", `body=${body}`,
        "-F", `in_reply_to=${inReplyTo}`
      ];
      const output = await this.spawnGH(args, owner);
      return JSON.parse(output.toString()) as GHComment;
    } catch (e) {
      getLogger().error(`Failed to post reply to comment ${inReplyTo}: ${String(e)}`);
      return undefined;
    }
  }

  async resolveThread(threadNodeId: string, repoSlug: string): Promise<boolean> {
    try {
      const owner = repoSlug.split("/")[0];
      const query = `
        mutation($id: ID!) {
          resolveReviewThread(input: { threadId: $id }) {
            thread {
              isResolved
            }
          }
        }
      `;
      await this.spawnGH(["api", "graphql", "-f", `query=${query}`, "-f", `id=${threadNodeId}`], owner);
      return true;
    } catch (e) {
      getLogger().error(`Failed to resolve thread ${threadNodeId}: ${String(e)}`);
      return false;
    }
  }
}
