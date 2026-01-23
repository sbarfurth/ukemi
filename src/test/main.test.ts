import * as assert from "assert";

import * as vscode from "vscode";
import { execJJPromise } from "./utils";

suite("Extension Test Suite", () => {
  vscode.window.showInformationMessage("Start all tests.");

  let originalOperation: string;
  suiteSetup(async () => {
    // Wait for a refresh so the repo is detected
    await new Promise((resolve) => {
      setTimeout(resolve, 5000);
    });

    const output = await execJJPromise(
      'operation log --limit 1 --no-graph --template "self.id()"',
    );
    originalOperation = output.stdout.trim();
  });

  teardown(async () => {
    await execJJPromise(`operation restore ${originalOperation}`);
  });

  test("Sanity check: `jj status` succeeds", async () => {
    await assert.doesNotReject(execJJPromise("status"));
  });
});
