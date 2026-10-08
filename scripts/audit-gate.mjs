#!/usr/bin/env node
/**
 * Triaged dependency-audit gate (item 5367920e).
 *
 * Fails on any HIGH or CRITICAL advisory that is NOT explicitly triaged in
 * scripts/audit-allowlist.json with a reason and a not-yet-passed expiry.
 * Moderate/low advisories are summarised but never block. The whole installed
 * tree is audited, development dependencies included: an advisory that only
 * reaches the Pi host we develop against is triaged with that reason, not
 * hidden by --omit=dev, so it resurfaces when its expiry passes.
 *
 * Matching is at the GHSA level on purpose: allowlisting a package for one
 * advisory does NOT suppress a future, different high advisory on it.
 *
 * Mirrors DevSpecV2's scripts/audit-gate.mjs (and audit-report.mjs, which is
 * byte-identical). The plugin repositories deliberately share no sync tooling,
 * so a fix to either gate is made in both by hand.
 *
 * Zero dependencies, pure Node, deliberately: a security gate should not widen
 * the dependency surface it polices.
 */

import { execFileSync } from 'node:child_process'
import { parseAuditReport } from './audit-report.mjs'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const BLOCKING = new Set(['high', 'critical'])
const here = dirname(fileURLToPath(import.meta.url))
const allowlistPath = join(here, 'audit-allowlist.json')

function loadAllowlist() {
  try {
    const raw = JSON.parse(readFileSync(allowlistPath, 'utf8'))
    const map = new Map()
    for (const a of raw.advisories || []) map.set(a.ghsa, a)
    return map
  } catch (e) {
    console.error(`audit-gate: could not read ${allowlistPath}: ${e.message}`)
    process.exit(2)
  }
}

function runAudit() {
  // Exit 1 can mean vulnerabilities OR an operational error. Stdout by itself
  // is not proof the registry produced a report (item d5a9645a).
  try {
    return { raw: execFileSync('npm', ['audit', '--json'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      maxBuffer: 64 * 1024 * 1024,
      timeout: 120_000,
    }), status: 0 }
  } catch (e) {
    return { raw: e.stdout ?? '', status: e.status }
  }
}

function ghsaFrom(via) {
  const m = typeof via?.url === 'string' && via.url.match(/GHSA-[0-9a-z-]+/i)
  return m ? m[0] : null
}

const allow = loadAllowlist()
let audit
try {
  const { raw, status } = runAudit()
  audit = parseAuditReport(raw, status)
} catch (error) {
  console.error(`audit-gate: ERROR — valid audit evidence unavailable. ${error.message}`)
  process.exit(2)
}
const today = new Date()

const blocking = [] // high/critical source advisories with no live allowlist entry
const accepted = [] // covered by a current allowlist entry
const expiredHit = [] // allowlisted, but the acceptance has expired and it's still present
const usedGhsa = new Set()

for (const [pkg, v] of Object.entries(audit.vulnerabilities)) {
  for (const via of Array.isArray(v.via) ? v.via : []) {
    if (typeof via !== 'object' || !BLOCKING.has(via.severity)) continue
    const ghsa = ghsaFrom(via)
    const rec = { pkg, ghsa: ghsa || '(no GHSA id)', severity: via.severity, title: via.title || '' }
    const entry = ghsa && allow.get(ghsa)
    if (!entry) {
      blocking.push(rec)
      continue
    }
    usedGhsa.add(ghsa)
    if (entry.expires && new Date(entry.expires) < today) expiredHit.push({ ...rec, expires: entry.expires })
    else accepted.push({ ...rec, reason: entry.reason, expires: entry.expires })
  }
}

// Allowlist entries that no longer match any current advisory — prune them so the
// list reflects reality (warn only; a fixed advisory is good news, not a failure).
const stale = [...allow.values()].filter((a) => !usedGhsa.has(a.ghsa))

const meta = audit.metadata?.vulnerabilities
if (meta) {
  console.log(
    `audit-gate: ${meta.critical} critical, ${meta.high} high, ${meta.moderate} moderate, ${meta.low} low across ${audit.metadata.dependencies?.total ?? '?'} deps.`,
  )
}

const fmt = (r) => `  ${r.severity.toUpperCase().padEnd(8)} ${r.ghsa.padEnd(22)} ${r.pkg} — ${r.title}`

if (accepted.length) {
  console.log(`\n✓ ${accepted.length} high/critical advisory(ies) accepted as not reachable:`)
  for (const r of accepted) console.log(`${fmt(r)}\n      ↳ until ${r.expires}: ${r.reason}`)
}
if (stale.length) {
  console.log(`\n⚠ ${stale.length} allowlist entry(ies) no longer match any advisory — prune from audit-allowlist.json:`)
  for (const a of stale) console.log(`  ${a.ghsa}  (${a.package})`)
}
if (expiredHit.length) {
  console.log(`\n✗ ${expiredHit.length} allowlisted advisory(ies) EXPIRED and still present — re-review reachability and re-stamp expiry:`)
  for (const r of expiredHit) console.log(`${fmt(r)}  [expired ${r.expires}]`)
}
if (blocking.length) {
  console.log(`\n✗ ${blocking.length} high/critical advisory(ies) NOT triaged — assess reachability, then fix the dep or add a reason + expiry to audit-allowlist.json:`)
  for (const r of blocking) console.log(fmt(r))
}

const failures = blocking.length + expiredHit.length
if (failures > 0) {
  console.log(`\naudit-gate: FAIL — ${failures} blocking finding(s). See scripts/audit-allowlist.json.\n`)
  process.exit(1)
}
console.log('\naudit-gate: PASS — no untriaged or expired high/critical advisories.\n')
process.exit(0)
