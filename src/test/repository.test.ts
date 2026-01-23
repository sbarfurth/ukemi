import * as assert from "assert/strict";
import {
  parseRenamePaths,
  JJRepository,
  Change,
  FileStatus,
  Show,
  ChangeWithDetails,
} from "../repository"; // Adjust path as needed
import { getJJPath, getRepoAuthor, getRepoPath } from "./utils";
import fs from "fs/promises";
import path from "path";

suite("JJRepository", () => {
  let suiteDir: string;

  suiteSetup(async () => {
    suiteDir = await fs.mkdtemp(path.join(getRepoPath(), "suite-"));
  });

  suiteTeardown(async () => {
    await fs.rm(suiteDir, { recursive: true });
  });

  suite("getStatus", () => {
    test("retrieves the status of the jj workspace", async () => {
      const fileName = "file.txt";
      const relativeFilePath = path.join(path.basename(suiteDir), fileName);
      const filePath = path.join(suiteDir, fileName);

      await fs.writeFile(filePath, "Initial content");
      const repo = new JJRepository(getRepoPath(), getJJPath(), "0.37.0", []);

      const status = await repo.getStatus();

      assert.deepStrictEqual(status.conflictedFiles, new Set<string>());
      assert.deepStrictEqual(status.fileStatuses, [
        {
          file: relativeFilePath,
          path: filePath,
          type: "A",
        } satisfies FileStatus,
      ]);
      assert.strictEqual(status.parentChanges.length, 1);
      assert.deepStrictEqual(status.parentChanges[0], {
        bookmarks: undefined,
        changeId: "zzzzzzzz",
        commitId: "00000000",
        description: "",
        isConflict: false,
        isEmpty: true,
        isImmutable: true,
      } satisfies Change);
      assert.partialDeepStrictEqual(status.workingCopy, {
        bookmarks: undefined,
        description: "",
        isEmpty: false,
        isConflict: false,
        isImmutable: false,
      } satisfies Partial<Change>);
      assert.match(status.workingCopy.changeId, /^[k-z]{8}$/);
      assert.match(status.workingCopy.commitId, /^[a-f0-9]{8}$/);
    });
  });

  suite("showAll", () => {
    test("shows all commits for a revset", async () => {
      const fileName = "file.txt";
      const relativeFilePath = path.join(path.basename(suiteDir), fileName);
      const filePath = path.join(suiteDir, fileName);
      const repoAuthor = getRepoAuthor();

      await fs.writeFile(filePath, "Initial content");
      const repo = new JJRepository(getRepoPath(), getJJPath(), "0.37.0", []);

      const show = await repo.showAll(["::"]);

      assert.strictEqual(relativeFilePath, relativeFilePath);
      assert.strictEqual(show.length, 2);
      assert.partialDeepStrictEqual(show[0], {
        conflictedFiles: new Set<string>(),
        fileStatuses: [
          {
            file: relativeFilePath,
            path: filePath,
            type: "A",
          },
        ],
      } satisfies Partial<Show>);
      assert.partialDeepStrictEqual(show[0].change, {
        author: {
          email: repoAuthor.email,
          name: repoAuthor.name,
        },
        description: "",
        isConflict: false,
        isEmpty: false,
        isImmutable: false,
      } satisfies Partial<ChangeWithDetails>);
      assert.match(show[0].change.changeId, /^[k-z]{32}$/);
      assert.match(show[0].change.commitId, /^[a-f0-9]{40}$/);
      assert.deepStrictEqual(show[1], {
        change: {
          author: {
            email: "",
            name: "",
          },
          authoredDate: "1970-01-01 00:00:00",
          changeId: "zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz",
          commitId: "0000000000000000000000000000000000000000",
          description: "",
          isConflict: false,
          isEmpty: true,
          isImmutable: true,
        },
        conflictedFiles: new Set<string>(),
        fileStatuses: [],
      } satisfies Show);
    });
  });
});

suite("parseRenamePaths", () => {
  test("should handle rename with no prefix or suffix", () => {
    const input = "{old => new}";
    const expected = {
      fromPath: "old",
      toPath: "new",
    };
    assert.deepStrictEqual(parseRenamePaths(input), expected);
  });

  test("should handle rename with only suffix", () => {
    const input = "{old => new}.txt";
    const expected = {
      fromPath: "old.txt",
      toPath: "new.txt",
    };
    assert.deepStrictEqual(parseRenamePaths(input), expected);
  });

  test("should handle rename with only prefix", () => {
    const input = "prefix/{old => new}";
    const expected = {
      fromPath: "prefix/old",
      toPath: "prefix/new",
    };
    assert.deepStrictEqual(parseRenamePaths(input), expected);
  });

  test("should handle empty fromPart", () => {
    const input = "src/test/{ => basic-suite}/main.test.ts";
    const expected = {
      fromPath: "src/test/main.test.ts",
      toPath: "src/test/basic-suite/main.test.ts",
    };
    assert.deepStrictEqual(parseRenamePaths(input), expected);
  });

  test("should handle empty toPart", () => {
    const input = "src/{old => }/file.ts";
    const expected = {
      fromPath: "src/old/file.ts",
      toPath: "src/file.ts",
    };
    assert.deepStrictEqual(parseRenamePaths(input), expected);
  });

  test("should parse rename with leading and trailing directories", () => {
    const input = "a/b/{c => d}/e/f.txt";
    const expected = {
      fromPath: "a/b/c/e/f.txt",
      toPath: "a/b/d/e/f.txt",
    };
    assert.deepStrictEqual(parseRenamePaths(input), expected);
  });

  test("should handle extra spaces within curly braces", () => {
    const input = "src/test/{  =>   basic-suite  }/main.test.ts";
    const expected = {
      fromPath: "src/test/main.test.ts",
      toPath: "src/test/basic-suite/main.test.ts",
    };
    assert.deepStrictEqual(parseRenamePaths(input), expected);
  });

  test("should handle paths with dots in segments", () => {
    const input = "src/my.component/{old.module => new.module}/index.ts";
    const expected = {
      fromPath: "src/my.component/old.module/index.ts",
      toPath: "src/my.component/new.module/index.ts",
    };
    assert.deepStrictEqual(parseRenamePaths(input), expected);
  });

  test("should handle paths with spaces", () => {
    // This test depends on how robust the regex is to special path characters.
    // The current regex is simple and might fail with complex characters.
    const input = "src folder/{a b => c d}/file name with spaces.txt";
    const expected = {
      fromPath: "src folder/a b/file name with spaces.txt",
      toPath: "src folder/c d/file name with spaces.txt",
    };
    assert.deepStrictEqual(parseRenamePaths(input), expected);
  });

  test("should return null for simple rename without curly braces", () => {
    const input = "old.txt => new.txt";
    assert.strictEqual(parseRenamePaths(input), null);
  });

  test("should return null for non-rename lines", () => {
    const input = "M src/some/file.ts";
    assert.strictEqual(parseRenamePaths(input), null);
  });

  test("should return null for empty input", () => {
    const input = "";
    assert.strictEqual(parseRenamePaths(input), null);
  });
});
