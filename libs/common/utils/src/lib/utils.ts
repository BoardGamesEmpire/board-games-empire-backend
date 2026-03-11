import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * Recursively walks a directory and returns absolute paths of files matching a pattern.
 *
 * @param dir - The root directory to walk
 * @param pattern - A RegExp or string pattern to match file names/paths against
 * @param exclusions - An array of RegExp or string patterns to exclude
 * @returns An array of absolute file paths that match the pattern
 */
export function walkDir(dir: string, pattern: RegExp | string, exclusions: (RegExp | string)[] = []): string[] {
  const matchPattern = typeof pattern === 'string' ? new RegExp(pattern) : pattern;
  const excludePatterns = exclusions.map((e) => (typeof e === 'string' ? new RegExp(e) : e));

  const isExcluded = (filePath: string): boolean => excludePatterns.some((p) => p.test(filePath));

  const results: string[] = [];

  const walk = (currentDir: string): void => {
    const absDir = path.resolve(currentDir);

    if (isExcluded(absDir)) return;

    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(absDir, { withFileTypes: true });
    } catch {
      return; // Skip unreadable directories
    }

    for (const entry of entries) {
      const absPath = path.join(absDir, entry.name);

      if (isExcluded(absPath)) continue;

      if (entry.isDirectory()) {
        walk(absPath);
      } else if (entry.isFile() && matchPattern.test(absPath)) {
        results.push(absPath);
      }
    }
  };

  walk(dir);
  return results;
}
