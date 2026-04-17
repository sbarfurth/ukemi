import * as vscode from "vscode";

/** Controls how timestamps in the graph are shown. */
export type ShowTimestamp = "always" | "immutable_only" | "never";

/** Graph configuration. */
export interface GraphConfig {
  showCommitId: boolean;
  showAuthor: boolean;
  showBookmarks: boolean;
  showTimestamp: ShowTimestamp;
  useConfigLogRevset: boolean;
  revset: string;
  limit: number;

  viewLayout: "floating" | "compact";
}

/** Extension configuration. */
export interface Config {
  enableAnnotations: boolean;
  commandTimeout: number | null;
  jjPath: string;
  githubToken: string;
  githubTokens: Record<string, string>;
  githubRemote: string;
  githubPRSearchLimit: number;
  githubPRPollInterval: number;
  ghPath: string;
  graph: GraphConfig;
}

export function getGraphConfig(scope?: vscode.Uri): GraphConfig {
  const config = vscode.workspace.getConfiguration("ukemi.graph", scope);
  return {
    showCommitId: config.get<boolean>("showCommitId", true),
    showAuthor: config.get<boolean>("showAuthor", true),
    showBookmarks: config.get<boolean>("showBookmarks", true),
    showTimestamp: config.get<ShowTimestamp>("showTimestamp", "always"),
    useConfigLogRevset: config.get<boolean>("useConfigLogRevset", false),
    revset: config.get<string>("revset", "::"),
    limit: config.get<number>("limit", 50),

    viewLayout: config.get<"floating" | "compact">("viewLayout", "floating"),
  };
}

export function getConfig(scope?: vscode.Uri): Config {
  const config = vscode.workspace.getConfiguration("ukemi", scope);
  return {
    enableAnnotations: config.get<boolean>("enableAnnotations", true),
    commandTimeout: config.get<number | null>("commandTimeout", null),
    jjPath: config.get<string>("jjPath", ""),
    githubToken: config.get<string>("githubToken", ""),
    githubTokens: config.get<Record<string, string>>("githubTokens", {}),
    githubRemote: config.get<string>("githubRemote", "origin"),
    githubPRSearchLimit: config.get<number>("githubPRSearchLimit", 10),
    githubPRPollInterval: config.get<number>("githubPRPollInterval", 5),
    ghPath: config.get<string>("ghPath", ""),
    graph: getGraphConfig(scope),
  };
}
