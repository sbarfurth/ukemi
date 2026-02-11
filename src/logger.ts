import * as vscode from "vscode";

let outputChannel: vscode.LogOutputChannel;

export function getLogger(): vscode.LogOutputChannel {
  if (!outputChannel) {
    outputChannel = vscode.window.createOutputChannel("ukemi", {
      log: true,
    });
  }
  return outputChannel;
}
