const SEMVER_PATTERN = /[0-9]+\.[0-9]+\.[0-9]+/;

/**
 * Parts of a semantic version. Intentionally leaves out any additional metadata
 * beyond the version itself. These are not supported.
 */
export interface SemVerParts {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
}

/** Representation of a semantic version. */
export class SemVer {
  private constructor(private readonly parts: SemVerParts) {}

  /**
   * Parses a semantic version from a string that contains one. The string may
   * contain other text or metadata. Only the major, minor and patch version are
   * parsed and considered. If the string contains multiple versions, only the
   * first one will be considered. Falls back to the default version as returned
   * by {@link SemVer.default} if the version string does not contain a version
   * or is invalid.
   */
  static parse(version: string): SemVer {
    const match = version.match(SEMVER_PATTERN);
    if (!match) {
      return SemVer.default();
    }
    const parts = match[0].split(".");
    if (parts.length !== 3) {
      return SemVer.default();
    }
    const major = Number(parts[0]);
    const minor = Number(parts[1]);
    const patch = Number(parts[2]);
    if (!isFinite(major) || !isFinite(minor) || !isFinite(patch)) {
      return SemVer.default();
    }
    return new SemVer({ major, minor, patch });
  }

  /** Retrieves the default version. */
  static default(): SemVer {
    return new SemVer({ major: 0, minor: 28, patch: 0 });
  }

  /**
   * Whether this version equals another version. All parts must be exactly
   * equal to be considered equal.
   */
  equals(other: SemVer): boolean {
    return (
      this.parts.major === other.parts.major &&
      this.parts.minor === other.parts.minor &&
      this.parts.patch === other.parts.patch
    );
  }

  /** Returns a string representation of the version. */
  toString(): string {
    return `${this.parts.major}.${this.parts.minor}.${this.parts.patch}`;
  }

  /**
   * Whether the version is at least as high as the provided other version.
   * Returns true for the same version.
   */
  isAtLeast(other: SemVer): boolean {
    if (this.parts.major > other.parts.major) {
      return true;
    }
    if (
      this.parts.major === other.parts.major &&
      this.parts.minor > other.parts.minor
    ) {
      return true;
    }
    if (
      this.parts.major === other.parts.major &&
      this.parts.minor === other.parts.minor &&
      this.parts.patch >= other.parts.patch
    ) {
      return true;
    }
    return false;
  }
}
