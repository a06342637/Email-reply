export type ParsedVersion = {
  major: number;
  minor: number;
  normalized: string;
};

const VERSION_PATTERN = /^(?:v)?(\d+)\.(\d+)$/;

export function parseReleaseVersion(value: string): ParsedVersion | null {
  const match = VERSION_PATTERN.exec(value.trim());
  if (!match) return null;
  const major = Number.parseInt(match[1]!, 10);
  const minor = Number.parseInt(match[2]!, 10);
  if (!Number.isSafeInteger(major) || !Number.isSafeInteger(minor)) return null;
  return {
    major,
    minor,
    normalized: `${major}.${minor.toString().padStart(2, "0")}`,
  };
}

export function compareReleaseVersions(left: string, right: string): number {
  const a = parseReleaseVersion(left);
  const b = parseReleaseVersion(right);
  if (!a || !b) throw new Error("Invalid release version");
  return a.major === b.major ? a.minor - b.minor : a.major - b.major;
}

export function latestReleaseTag(tags: string[]): string | null {
  const versions = tags
    .map((tag) => ({ tag: tag.trim(), version: parseReleaseVersion(tag) }))
    .filter((item): item is { tag: string; version: ParsedVersion } =>
      Boolean(item.version),
    )
    .sort((a, b) =>
      compareReleaseVersions(b.version.normalized, a.version.normalized),
    );
  return versions[0]?.tag ?? null;
}

export function releaseVersionFromTag(tag: string): string {
  const parsed = parseReleaseVersion(tag);
  if (!parsed) throw new Error(`Invalid release tag: ${tag}`);
  return parsed.normalized;
}

export function normalizeRepositoryUrl(value: string): string {
  return value
    .trim()
    .replace(/^git@github\.com:/i, "https://github.com/")
    .replace(/\/$/, "")
    .replace(/\.git$/i, "")
    .toLowerCase();
}

export function replaceEnvValue(
  source: string,
  key: string,
  value: string,
): string {
  if (/[\r\n]/.test(value))
    throw new Error("Environment value contains a newline");
  const rows = source.replace(/\r\n/g, "\n").split("\n");
  let replaced = false;
  const next = rows.map((row) => {
    if (!row.startsWith(`${key}=`)) return row;
    replaced = true;
    return `${key}=${value}`;
  });
  if (!replaced) {
    while (next.length && next.at(-1) === "") next.pop();
    next.push(`${key}=${value}`, "");
  }
  return next.join("\n");
}

export function sanitizeUpdaterLog(value: string): string {
  const trimmed = [...value]
    .filter((character) => {
      const code = character.charCodeAt(0);
      return code === 9 || code === 10 || code === 13 || code >= 32;
    })
    .join("")
    .trim();
  if (!trimmed) return "";
  if (/password|passphrase|secret|token|authorization|cookie/i.test(trimmed))
    return "[已隐藏可能包含敏感信息的输出]";
  return trimmed.slice(0, 500);
}
