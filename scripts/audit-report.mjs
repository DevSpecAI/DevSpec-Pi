/** Validate evidence before applying the existing advisory triage policy.
 * Item d5a9645a: npm error JSON is not a clean vulnerability report.
 * Error messages deliberately omit raw registry responses and subprocess errors.
 */
const severities = ['info', 'low', 'moderate', 'high', 'critical']
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const count = value => Number.isSafeInteger(value) && value >= 0

export function parseAuditReport(raw, status) {
  if (status !== 0 && status !== 1) throw new Error('npm audit did not complete with a supported exit status.')
  let audit
  try { audit = JSON.parse(raw) } catch { throw new Error('npm audit returned invalid JSON.') }
  if (!object(audit) || Object.hasOwn(audit, 'error')) throw new Error('npm audit returned an operational error, not audit evidence.')
  if (audit.auditReportVersion !== 2) throw new Error('Unsupported or missing npm audit report version.')
  if (!object(audit.vulnerabilities) || !object(audit.metadata?.vulnerabilities)
    || !count(audit.metadata?.dependencies?.total)) throw new Error('Incomplete npm audit report structure.')
  const summary = audit.metadata.vulnerabilities
  if (![...severities, 'total'].every(key => count(summary[key]))) throw new Error('Invalid npm audit vulnerability counts.')
  if (severities.reduce((sum, key) => sum + summary[key], 0) !== summary.total
    || Object.keys(audit.vulnerabilities).length !== summary.total) throw new Error('Contradictory npm audit vulnerability counts.')
  if (status === 1 && summary.total === 0) throw new Error('npm audit exited unsuccessfully without vulnerability evidence.')
  const actual = Object.fromEntries(severities.map(key => [key, 0]))
  for (const vulnerability of Object.values(audit.vulnerabilities)) {
    if (!object(vulnerability) || !severities.includes(vulnerability.severity)
      || !Array.isArray(vulnerability.via) || vulnerability.via.length === 0) throw new Error('Incomplete npm audit vulnerability entry.')
    actual[vulnerability.severity]++
    for (const via of vulnerability.via) {
      if (typeof via === 'string') {
        if (!Object.hasOwn(audit.vulnerabilities, via)) throw new Error('npm audit references missing advisory evidence.')
      } else if (!object(via) || !severities.includes(via.severity)) {
        throw new Error('Invalid npm audit advisory evidence.')
      }
    }
  }
  if (severities.some(key => actual[key] !== summary[key])) throw new Error('npm audit severity counts do not match its entries.')

  function hasBlockingSource(name, seen = new Set()) {
    if (seen.has(name)) return false
    seen.add(name)
    return audit.vulnerabilities[name].via.some(via => typeof via === 'string'
      ? hasBlockingSource(via, seen)
      : ['high', 'critical'].includes(via.severity))
  }
  for (const [name, vulnerability] of Object.entries(audit.vulnerabilities)) {
    if (['high', 'critical'].includes(vulnerability.severity) && !hasBlockingSource(name)) {
      throw new Error('High/critical packages lack source advisory evidence.')
    }
  }
  return audit
}
