import { readFile, writeFile } from 'node:fs/promises';
import { execSync } from 'node:child_process';

const BASELINE_FILE = '.quality-baseline.json';

function run(cmd) {
  try {
    execSync(cmd, { stdio: 'pipe', encoding: 'utf8' });
    return { exitCode: 0, stdout: '', stderr: '' };
  } catch (e) {
    return {
      exitCode: e.status ?? 1,
      stdout: e.stdout?.toString() ?? '',
      stderr: e.stderr?.toString() ?? '',
    };
  }
}

function countLintErrors(output) {
  const lines = output.split('\n');
  let errors = 0;
  let warnings = 0;
  for (const line of lines) {
    const m = line.match(/(\d+)\s+error/i);
    if (m) errors += parseInt(m[1], 10);
    const w = line.match(/(\d+)\s+warning/i);
    if (w) warnings += parseInt(w[1], 10);
  }
  // Also count individual error/warning lines
  const errorLines = lines.filter((l) => /^\s*✖|error\s|Error:/.test(l)).length;
  const warningLines = lines.filter((l) => /warning\s/i.test(l)).length;
  return {
    errors: errors || errorLines,
    warnings: warnings || warningLines,
  };
}

async function collectBaseline() {
  console.log('Collecting quality baseline...');

  const tsc = run('npx tsc --noEmit');
  const lint = run('npx next lint');
  const prettier = run('npx prettier --check "src/**/*.{ts,tsx,css,json,md}"');

  const lintOutput = lint.stdout + lint.stderr;
  const prettierOutput = prettier.stdout + prettier.stderr;
  const prettierUnformatted = (prettierOutput.match(/\[warn\]/g) || []).length;

  const lintStats = countLintErrors(lintOutput);

  const baseline = {
    timestamp: new Date().toISOString(),
    tsc: { exitCode: tsc.exitCode, errorCount: tsc.exitCode === 0 ? 0 : 1 },
    lint: {
      exitCode: lint.exitCode,
      errors: lintStats.errors,
      warnings: lintStats.warnings,
    },
    prettier: {
      exitCode: prettier.exitCode,
      unformattedFiles: prettierUnformatted,
    },
  };

  await writeFile(BASELINE_FILE, JSON.stringify(baseline, null, 2) + '\n', 'utf8');
  console.log('Baseline saved to', BASELINE_FILE);
  console.log(JSON.stringify(baseline, null, 2));
  return baseline;
}

async function checkRatchet() {
  let baseline;
  try {
    baseline = JSON.parse(await readFile(BASELINE_FILE, 'utf8'));
  } catch {
    console.error('No baseline found. Run: node scripts/quality-ratchet.mjs --record');
    process.exit(1);
  }

  const failures = [];

  // Typecheck
  const tsc = run('npx tsc --noEmit');
  if (tsc.exitCode !== 0 && baseline.tsc.exitCode === 0) {
    failures.push(`tsc: was ${baseline.tsc.exitCode}, now ${tsc.exitCode} (regression)`);
  } else if (tsc.exitCode !== 0 && baseline.tsc.exitCode !== 0) {
    // Both failed - check if error count increased
    const oldErrors = baseline.tsc.errorCount || 1;
    const newErrors = (tsc.stderr.match(/error TS/g) || []).length || oldErrors;
    if (newErrors > oldErrors) {
      failures.push(`tsc: error count increased from ${oldErrors} to ${newErrors}`);
    }
  }

  // Lint
  const lint = run('npx next lint');
  const lintOutput = lint.stdout + lint.stderr;
  const lintStats = countLintErrors(lintOutput);
  if (lintStats.errors > (baseline.lint?.errors || 0)) {
    failures.push(
      `lint: errors increased from ${baseline.lint?.errors || 0} to ${lintStats.errors}`,
    );
  }

  // Prettier
  const prettier = run('npx prettier --check "src/**/*.{ts,tsx,css,json,md}"');
  const prettierOutput = prettier.stdout + prettier.stderr;
  const prettierUnformatted = (prettierOutput.match(/\[warn\]/g) || []).length;
  if (prettierUnformatted > (baseline.prettier?.unformattedFiles || 0)) {
    failures.push(
      `prettier: unformatted files increased from ${baseline.prettier?.unformattedFiles || 0} to ${prettierUnformatted}`,
    );
  }

  if (failures.length) {
    console.error('Quality ratchet FAILED:\n' + failures.join('\n'));
    process.exit(1);
  }

  console.log('Quality ratchet passed — no new issues introduced.');
  console.log(
    `Baseline: tsc=${baseline.tsc.exitCode}, lint errors=${baseline.lint?.errors || 0}, unformatted=${baseline.prettier?.unformattedFiles || 0}`,
  );
}

const mode = process.argv[2];
if (mode === '--record') {
  collectBaseline();
} else {
  checkRatchet();
}
