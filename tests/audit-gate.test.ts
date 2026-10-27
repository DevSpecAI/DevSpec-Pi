// Regression tests for the triaged audit gate (item 5367920e), mirrored from
// DevSpecV2's scripts/audit-gate.test.mjs. The gate runs against a fake `npm` so
// every case is offline and deterministic: what a real registry returns is the
// gate's input, not something these tests depend on.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync, chmodSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { parseAuditReport } from '../scripts/audit-report.mjs'

const ghsa = 'GHSA-abcd-1234-efgh'
const severities = ['info', 'low', 'moderate', 'high', 'critical']
function report(vulnerabilities = {}) {
  const counts = Object.fromEntries(severities.map(key => [key, 0]))
  for (const v of Object.values(vulnerabilities)) counts[v.severity]++
  return { auditReportVersion: 2, vulnerabilities, metadata: { vulnerabilities: { ...counts, total: Object.keys(vulnerabilities).length }, dependencies: { total: 10 } } }
}
const source = severity => ({ severity, via: [{ severity, url: `https://github.com/advisories/${ghsa}`, title: 'controlled advisory fixture' }] })

function invoke(t, body, status = 0, advisories = []) {
  const dir = mkdtempSync(join(tmpdir(), 'devspec-audit-gate-test-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  for (const file of ['audit-gate.mjs', 'audit-report.mjs']) writeFileSync(join(dir, file), readFileSync(new URL(`../scripts/${file}`, import.meta.url)))
  writeFileSync(join(dir, 'audit-allowlist.json'), JSON.stringify({ advisories }))
  writeFileSync(join(dir, 'response.json'), typeof body === 'string' ? body : JSON.stringify(body))
  const npm = join(dir, 'npm')
  writeFileSync(npm, '#!/usr/bin/env node\nprocess.stdout.write(require("node:fs").readFileSync(process.env.AUDIT_FIXTURE_FILE)); process.exit(Number(process.env.AUDIT_FIXTURE_EXIT));\n')
  chmodSync(npm, 0o700)
  return spawnSync(process.execPath, [join(dir, 'audit-gate.mjs')], {
    encoding: 'utf8', timeout: 15_000,
    env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, AUDIT_FIXTURE_FILE: join(dir, 'response.json'), AUDIT_FIXTURE_EXIT: String(status) },
  })
}

test('original false-green reproducer now blocks without printing the registry error body', t => {
  const result = invoke(t, { error: { code: 'EAUDITTEST', summary: 'credential-marker-do-not-print' } }, 1)
  assert.equal(result.status, 2)
  assert.doesNotMatch(result.stdout, /PASS/)
  assert.match(result.stderr, /valid audit evidence unavailable/)
  assert.doesNotMatch(result.stdout + result.stderr, /credential-marker-do-not-print/)
})
for (const body of ['', '<html>credential-marker-do-not-print</html>', {}, [], { vulnerabilities: {} }, { ...report(), auditReportVersion: 3 }, { ...report(), vulnerabilities: null }]) {
  test(`incomplete/unrecognized report blocks: ${JSON.stringify(body)}`, t => {
    const result = invoke(t, body)
    assert.equal(result.status, 2)
    assert.doesNotMatch(result.stdout + result.stderr, /PASS|credential-marker-do-not-print/)
  })
}
for (const status of [2, 124, 137]) test(`unexpected npm exit ${status} cannot be masked by valid stdout`, t => {
  const result = invoke(t, report(), status)
  assert.equal(result.status, 2)
  assert.doesNotMatch(result.stdout, /PASS/)
})
test('killed process and exit1-with-no-vulnerabilities are not successful audits', () => {
  assert.throws(() => parseAuditReport(JSON.stringify(report()), null), /exit status/)
  assert.throws(() => parseAuditReport(JSON.stringify(report()), 1), /unsuccessfully/)
})
test('valid clean audit passes', t => {
  const result = invoke(t, report())
  assert.equal(result.status, 0)
  assert.match(result.stdout, /audit-gate: PASS/)
})
for (const severity of ['low', 'moderate']) test(`valid ${severity} findings preserve nonblocking policy`, t => {
  const result = invoke(t, report({ source: source(severity) }), 1)
  assert.equal(result.status, 0)
  assert.match(result.stdout, /audit-gate: PASS/)
})
for (const severity of ['high', 'critical']) test(`untriaged ${severity} findings still block`, t => {
  const result = invoke(t, report({ source: source(severity) }), 1)
  assert.equal(result.status, 1)
  assert.match(result.stdout, /audit-gate: FAIL/)
})
test('current acceptance and expired acceptance retain their different outcomes', t => {
  const entry = { ghsa, package: 'source', reason: 'isolated reachability fixture', expires: new Date(Date.now() + 86_400_000).toISOString() }
  assert.equal(invoke(t, report({ source: source('high') }), 1, [entry]).status, 0)
  const expired = invoke(t, report({ source: source('high') }), 1, [{ ...entry, expires: '2000-01-01' }])
  assert.equal(expired.status, 1)
  assert.match(expired.stdout, /EXPIRED/)
})
test('transitive references work when source evidence is present', () => {
  const fixture = report({ source: source('high'), parent: { severity: 'high', via: ['source'] } })
  assert.deepEqual(parseAuditReport(JSON.stringify(fixture), 1), fixture)
})
test('summary contradictions, missing references, malformed via and evidence-free cycles fail closed', () => {
  const contradictory = report()
  contradictory.metadata.vulnerabilities.high = 1
  for (const fixture of [
    contradictory,
    { ...report(), metadata: { vulnerabilities: { info: 0, low: 0, moderate: 0, high: 0, critical: 0, total: 0 } } },
    report({ bad: { severity: 'high', via: ['missing'] } }),
    report({ bad: { severity: 'high', via: [{}] } }),
    report({ bad: { severity: 'high', via: [] } }),
    report({ a: { severity: 'high', via: ['b'] }, b: { severity: 'high', via: ['a'] } }),
  ]) assert.throws(() => parseAuditReport(JSON.stringify(fixture), 1))
})
