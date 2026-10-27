#!/usr/bin/env node
/**
 * check-currency — is the Pi plugin checkout at its upstream?
 *
 * Pi executes the checkout itself: settings.json `extensions[]` points at this
 * directory, so there is no separate installed copy that can go stale. Currency
 * is simply "is this checkout at origin/<branch>".
 *
 * Run from the repo root:  node scripts/check-currency.mjs
 * Exit 0 = current, non-zero = stale (or unreadable).
 */
import { execFileSync } from 'node:child_process'

const repo = process.cwd()

function git(args) {
  return execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim()
}

let upstream
try {
  upstream = git(['rev-parse', '--abbrev-ref', '@{upstream}'])
} catch {
  console.error('Pi check-currency: this checkout has no upstream configured.')
  process.exit(1)
}

try {
  git(['fetch', '--quiet', 'origin', upstream.replace(/^origin\//, '')])
} catch (err) {
  console.error(`Pi check-currency: fetch failed: ${err.message}`)
  process.exit(1)
}

const head = git(['rev-parse', 'HEAD'])
const origin = git(['rev-parse', `refs/remotes/${upstream}`])
const current = head === origin

console.log('host: Pi')
console.log(`runtime path (the checkout itself): ${repo}`)
console.log(`runtime commit: ${head}`)
console.log(`origin ${upstream}: ${origin}`)
console.log(`currency: ${current ? 'CURRENT' : 'STALE'}`)

process.exit(current ? 0 : 1)
