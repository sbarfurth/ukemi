import path from "path";
import fs from "fs/promises";
import os from "os";

import { runTests } from "@vscode/test-electron";
import { execJJPromise } from "./utils";

async function main() {
  let testRepoPath = "";
  let exitCode: number;
  try {
    // The folder containing the Extension Manifest package.json
    // Passed to `--extensionDevelopmentPath`
    const extensionDevelopmentPath = path.resolve(__dirname, "../../");

    // The path to the extension test runner script (output from esbuild)
    // Passed to --extensionTestsPath
    const extensionTestsPath = path.resolve(__dirname, "./runner.js");

    testRepoPath = await fs.mkdtemp(path.join(os.tmpdir(), "ukemi-test-"));
    const testAuthorName = "Test Author";
    const testAuthorEmail = "author@example.com";

    console.log(`Creating test repo in ${testRepoPath}`);
    await execJJPromise("git init", {
      cwd: testRepoPath,
    });
    // Set author information in the test repo.
    await execJJPromise(`config set --repo user.name '${testAuthorName}'`, {
      cwd: testRepoPath,
    });
    await execJJPromise(`config set --repo user.email '${testAuthorEmail}'`, {
      cwd: testRepoPath,
    });
    // The initial `jj git init` created an implicit new commit on top of the
    // root commit (0). This will have the system git author information since
    // we configured the author after. We can recreate on top of root to apply
    // the author config from above.
    await execJJPromise(`new 0`, {
      cwd: testRepoPath,
    });

    // Allow passing --grep to tests to isolate certain test cases.
    const args = process.argv.slice(2);
    let grepPattern: string = "";
    const grepIndex = args.indexOf("--grep");
    if (grepIndex > -1 && args[grepIndex + 1]) {
      grepPattern = args[grepIndex + 1];
    }

    // Download VS Code, unzip it and run the integration test
    exitCode = await runTests({
      extensionDevelopmentPath,
      extensionTestsPath,
      launchArgs: [testRepoPath],
      extensionTestsEnv: {
        TEST_REPO_PATH: testRepoPath,
        TEST_REPO_AUTHOR: `${testAuthorName}:${testAuthorEmail}`,
        MOCHA_GREP: grepPattern,
      },
    });
  } catch (err) {
    console.error(err);
    console.error("Failed to run tests");
    exitCode = 1;
  }

  if (testRepoPath) {
    console.log(`Cleaning up test repo in ${testRepoPath}`);
    await fs.rm(testRepoPath, { recursive: true });
  }

  process.exit(exitCode);
}

void main();
