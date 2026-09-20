#!/usr/bin/env node
/**
 * sync — pull origin/staging into the checkout, then confirm currency.
 *
 * Pi executes the checkout itself (settings.json `extensions[]` points here),
 * so pulling is the whole install: the next Pi session loads whatever is here.
 * Nothing else to run.
 *
 * Usage: node scripts/sync.mjs
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const repo = dirname(dirname(fileURLToPath(import.meta.url)))

function sh(cmd, args) {
  try {
    return execFileSync(cmd, args, { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
  } catch (e) {
    return `${e.stdout || ''}${e.stderr || ''}`.trim()
  }
}

console.log('== Pi: pull origin staging ==')
console.log(sh('git', ['pull', '--ff-only', 'origin', 'staging']) || 'Already up to date.')
console.log('')

const check = spawnSync('node', [join(repo, 'scripts', 'check-currency.mjs')], { cwd: repo, stdio: 'inherit' })
if ((check.status ?? 1) !== 0) {
  console.log('Next step: none. Pi auto-syncs on launch, so start a new Pi session to load this checkout.')
}
process.exit(check.status ?? 1)
