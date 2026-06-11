export interface ShowTemplateField {
  template: string;
  setter?: (value: string, show: Show) => void;
}

export type FileStatusType = "A" | "M" | "D" | "R" | "C";

export type FileStatus = {
  type: FileStatusType;
  file: string;
  path: string;
  renamedFrom?: string;
};

export interface Change {
  changeId: string;
  commitId: string;
  bookmarks: string[];
  description: string;
  isEmpty: boolean;
  isConflict: boolean;
  isImmutable: boolean;
}

export interface ChangeWithDetails extends Change {
  author: {
    name: string;
    email: string;
  };
  authoredDate: string;
  parentChangeIds: string[];
  isCurrentWorkingCopy: boolean;
  isSynced: boolean;
}

export type RepositoryStatus = {
  fileStatuses: FileStatus[];
  workingCopy: Change;
  parentChanges: Change[];
  conflictedFiles: Set<string>;
};

export type Show = {
  change: ChangeWithDetails;
  fileStatuses: FileStatus[];
  conflictedFiles: Set<string>;
};

export type Operation = {
  id: string;
  description: string;
  tags: string;
  start: string;
  user: string;
  snapshot: boolean;
};
