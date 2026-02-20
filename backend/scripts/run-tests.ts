import { existsSync, readdirSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const projectRoot = process.cwd();

const listTestFiles = (rootDir: string): string[] => {
  const absoluteRoot = resolve(projectRoot, rootDir);
  if (!existsSync(absoluteRoot)) {
    return [];
  }

  const files: string[] = [];
  const stack: string[] = [absoluteRoot];

  while (stack.length > 0) {
    const currentDir = stack.pop() as string;
    const entries = readdirSync(currentDir, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const fullPath = join(currentDir, entry.name);
      if (entry.isDirectory()) {
        stack.push(fullPath);
        continue;
      }
      if (entry.isFile() && entry.name.endsWith('.test.ts')) {
        files.push(relative(projectRoot, fullPath));
      }
    }
  }

  return files;
};

const testFiles = [...listTestFiles('src'), ...listTestFiles('tests')]
  .sort((left, right) => left.localeCompare(right));

if (testFiles.length === 0) {
  console.error('No test files found');
  process.exit(1);
}

const tsxBin = process.platform === 'win32'
  ? resolve(projectRoot, 'node_modules', '.bin', 'tsx.cmd')
  : resolve(projectRoot, 'node_modules', '.bin', 'tsx');

if (!existsSync(tsxBin)) {
  console.error(`Missing tsx binary at ${tsxBin}`);
  process.exit(1);
}

for (const file of testFiles) {
  console.log(`\nRUN ${file}`);
  const result = spawnSync(tsxBin, [file], {
    cwd: projectRoot,
    stdio: 'inherit',
  });
  if (result.error) {
    console.error(result.error);
    process.exit(1);
  }
  if (typeof result.status !== 'number') {
    console.error(`Test process exited without a status for ${file}`);
    process.exit(1);
  }
  if (result.status !== 0) {
    process.exit(result.status);
  }
}

console.log(`\nExecuted ${testFiles.length} test files.`);
