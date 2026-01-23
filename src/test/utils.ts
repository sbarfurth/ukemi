import { exec } from "child_process";

/**
 * Gets the jj executable path to use in tests.
 * Uses environment variable JJ_PATH if set, otherwise defaults to "jj".
 */
export function getJJPath(): string {
  return process.env.JJ_PATH || "jj";
}

export function execPromise(
  command: string,
  options?: Parameters<typeof exec>["1"],
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    exec(command, { timeout: 1000, ...options }, (error, stdout, stderr) => {
      if (error) {
        reject(error);
      } else {
        resolve({ stdout: stdout.toString(), stderr: stderr.toString() });
      }
    });
  });
}

/**
 * Executes a jj command using the configured jj path.
 */
export function execJJPromise(
  args: string,
  options?: Parameters<typeof exec>["1"],
): Promise<{ stdout: string; stderr: string }> {
  const jjPath = getJJPath();
  const command = `${jjPath} ${args}`;
  return execPromise(command, options);
}

/**
 * Gets the path to the test repository.
 * @throws If the TEST_REPO_PATH environment variable is not set.
 */
export function getRepoPath(): string {
  const repoPath = process.env.TEST_REPO_PATH;
  if (!repoPath) {
    throw new Error("TEST_REPO_PATH environment variable is not set");
  }
  return repoPath;
}

/** Author in a repository. */
export interface Author {
  name: string;
  email: string;
}

/**
 * Gets the path to the test repository.
 * @throws If the TEST_REPO_PATH environment variable is not set.
 */
export function getRepoAuthor(): Author {
  const repoAuthor = process.env.TEST_REPO_AUTHOR;
  if (!repoAuthor) {
    throw new Error("TEST_REPO_AUTHOR environment variable is not set");
  }
  const [name, email] = repoAuthor.split(":");
  return { name, email };
}
