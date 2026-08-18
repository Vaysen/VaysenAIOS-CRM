import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const exceptionsPath = path.join(repositoryRoot, 'security', 'npm-audit-exceptions.json');
const severities = new Set(['high', 'critical']);
const maximumExceptionDays = 90;
const allowedOwners = new Set(['team:vaysen-security']);
const auditContexts = Object.freeze({
  root: repositoryRoot,
  backend: path.join(repositoryRoot, 'backend'),
  frontend: path.join(repositoryRoot, 'frontend'),
  electron: path.join(repositoryRoot, 'electron'),
  openclaw: path.join(repositoryRoot, 'deploy', 'openclaw', 'plugins', 'vaysen-crm'),
});

function assertAuditRuntime() {
  if (process.versions.node !== '20.18.0') {
    throw new Error(`Production audit requires Node 20.18.0, got ${process.versions.node}`);
  }
  const npmUserAgent = process.env.npm_config_user_agent || '';
  if (!/^npm\/10\.8\.2(?:\s|$)/.test(npmUserAgent)) {
    throw new Error(
      `Production audit requires npm 10.8.2, got ${npmUserAgent.split(' ', 1)[0] || 'unknown'}`,
    );
  }
}

function advisoryId(value) {
  if (typeof value?.url === 'string') return value.url.split('/').pop();
  return String(value?.source || '');
}

export function collectBlockingAdvisories(report) {
  const vulnerabilities = report?.vulnerabilities || {};
  const findings = new Map();

  function visit(packageName, seen = new Set()) {
    if (seen.has(packageName)) return;
    seen.add(packageName);
    const node = vulnerabilities[packageName];
    if (!node) return;
    for (const via of node.via || []) {
      if (typeof via === 'string') {
        visit(via, seen);
        continue;
      }
      if (!severities.has(via.severity)) continue;
      const finding = {
        package: String(via.dependency || via.name || packageName),
        advisory: advisoryId(via),
        severity: via.severity,
        title: String(via.title || ''),
      };
      findings.set(`${finding.package}|${finding.advisory}`, finding);
    }
  }

  for (const [packageName, node] of Object.entries(vulnerabilities)) {
    if (severities.has(node.severity)) visit(packageName);
  }
  return [...findings.values()].sort((a, b) =>
    `${a.package}|${a.advisory}`.localeCompare(`${b.package}|${b.advisory}`),
  );
}

function validateAuditReport(report) {
  if (!report || typeof report !== 'object' || Array.isArray(report)) {
    throw new Error('npm audit report must be an object');
  }
  if (report.error) {
    throw new Error(`npm audit report contains an error: ${report.error.code || report.error.summary || 'unknown'}`);
  }
  if (!report.vulnerabilities || typeof report.vulnerabilities !== 'object' || Array.isArray(report.vulnerabilities)) {
    throw new Error('npm audit report is missing vulnerabilities');
  }
  const totals = report.metadata?.vulnerabilities;
  if (!totals || typeof totals !== 'object' || Array.isArray(totals)) {
    throw new Error('npm audit report is missing vulnerability metadata');
  }
  for (const severity of ['info', 'low', 'moderate', 'high', 'critical', 'total']) {
    if (!Number.isSafeInteger(totals[severity]) || totals[severity] < 0) {
      throw new Error(`npm audit report has invalid ${severity} metadata`);
    }
  }
}

function parseCalendarDate(value, label) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error(`Invalid expiry for ${label}`);
  const timestamp = Date.parse(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString().slice(0, 10) !== value) {
    throw new Error(`Invalid expiry for ${label}`);
  }
  return timestamp;
}

export function evaluateAudit({ report, exceptionFile, scope, today = new Date() }) {
  validateAuditReport(report);
  if (!['root', 'backend', 'frontend', 'electron', 'openclaw'].includes(scope)) throw new Error(`Unsupported audit scope: ${scope}`);
  if (exceptionFile?.version !== 1 || !Array.isArray(exceptionFile.exceptions)) {
    throw new Error('Audit exception file must use version 1 with an exceptions array');
  }
  const todayIso = today.toISOString().slice(0, 10);
  const todayTimestamp = parseCalendarDate(todayIso, 'evaluation date');
  const maximumExpiryTimestamp = todayTimestamp + maximumExceptionDays * 24 * 60 * 60 * 1000;
  const allKeys = new Set();
  for (const entry of exceptionFile.exceptions) {
    if (!['root', 'backend', 'frontend', 'electron', 'openclaw'].includes(entry.scope)) {
      throw new Error(`Invalid audit exception scope: ${entry.scope}`);
    }
    for (const field of ['package', 'advisory', 'reason', 'owner', 'expiresAt']) {
      if (typeof entry[field] !== 'string' || !entry[field].trim()) {
        throw new Error(`Invalid ${entry.scope} exception: missing ${field}`);
      }
    }
    if (!/^GHSA-[a-z0-9-]+$/i.test(entry.advisory)) {
      throw new Error(`Invalid advisory id: ${entry.advisory}`);
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(entry.expiresAt)) {
      throw new Error(`Invalid expiry for ${entry.package}/${entry.advisory}`);
    }
    const expiryTimestamp = parseCalendarDate(
      entry.expiresAt,
      `${entry.package}/${entry.advisory}`,
    );
    if (expiryTimestamp <= todayTimestamp) {
      throw new Error(`Expired audit exception: ${entry.package}/${entry.advisory} (${entry.expiresAt})`);
    }
    if (expiryTimestamp > maximumExpiryTimestamp) {
      throw new Error(`Audit exception is too far in the future: ${entry.package}/${entry.advisory}`);
    }
    if (entry.reason.trim().length < 30) {
      throw new Error(`Audit exception reason is too short: ${entry.package}/${entry.advisory}`);
    }
    if (!allowedOwners.has(entry.owner)) {
      throw new Error(`Audit exception owner is not allowlisted: ${entry.package}/${entry.advisory}`);
    }
    const key = `${entry.scope}|${entry.package}|${entry.advisory}`;
    if (allKeys.has(key)) throw new Error(`Duplicate audit exception: ${key}`);
    allKeys.add(key);
  }

  const scoped = exceptionFile.exceptions.filter((entry) => entry.scope === scope);
  const keys = new Set(scoped.map((entry) => `${entry.package}|${entry.advisory}`));
  const findings = collectBlockingAdvisories(report);
  const findingKeys = new Set(findings.map((item) => `${item.package}|${item.advisory}`));
  const unapproved = findings.filter((item) => !keys.has(`${item.package}|${item.advisory}`));
  const unused = scoped.filter((entry) => !findingKeys.has(`${entry.package}|${entry.advisory}`));
  return { findings, unapproved, unused, approved: findings.length - unapproved.length };
}

export function auditInvocation(scope) {
  const cwd = auditContexts[scope];
  if (!cwd) throw new Error(`Unsupported audit scope: ${scope}`);
  return {
    cwd,
    args: ['--workspaces=false', 'audit', '--omit=dev', '--json'],
  };
}

function runAudit(scope) {
  const npmCli = process.env.npm_execpath;
  const command = npmCli ? process.execPath : process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const args = npmCli ? [npmCli] : [];
  const invocation = auditInvocation(scope);
  args.push(...invocation.args);
  const result = spawnSync(command, args, {
    cwd: invocation.cwd,
    encoding: 'utf8',
    maxBuffer: 20 * 1024 * 1024,
  });
  if (!result.stdout?.trim()) {
    throw new Error(`npm audit did not return JSON: ${result.stderr || `exit ${result.status}`}`);
  }
  try {
    return JSON.parse(result.stdout);
  } catch {
    throw new Error(`npm audit returned invalid JSON: ${result.stdout.slice(0, 200)}`);
  }
}

function main() {
  assertAuditRuntime();
  const scopeIndex = process.argv.indexOf('--scope');
  const scope = scopeIndex >= 0 ? process.argv[scopeIndex + 1] : 'root';
  const exceptionFile = JSON.parse(readFileSync(exceptionsPath, 'utf8'));
  const report = runAudit(scope);
  const result = evaluateAudit({ report, exceptionFile, scope });
  const totals = report.metadata?.vulnerabilities || {};

  console.log(
    `[production-audit] scope=${scope} low=${totals.low || 0} moderate=${totals.moderate || 0} high=${totals.high || 0} critical=${totals.critical || 0} blockingAdvisories=${result.findings.length} approved=${result.approved}`,
  );
  if (result.unused.length) {
    for (const entry of result.unused) {
      console.error(`[production-audit] stale exception ${entry.package}/${entry.advisory}`);
    }
  }
  if (result.unapproved.length) {
    for (const finding of result.unapproved) {
      console.error(
        `[production-audit] unapproved ${finding.severity} ${finding.package}/${finding.advisory}: ${finding.title}`,
      );
    }
  }
  if (result.unused.length || result.unapproved.length) process.exitCode = 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
