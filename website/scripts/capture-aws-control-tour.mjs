/**
 * Full-page tour of the aws-control app (accounts → console → drive) for a UI
 * review. Runs the REAL built SPA behind serveDist with every /api/** call
 * answered from fixtures — no gateway, no credentials, no real AWS.
 *
 * Frames:
 *   01-accounts        account list (ok/degraded/unresolved rows + add-accounts)
 *   02-console         healthy account console (costs, connections, drive row)
 *   03-console-setup   degraded account: no bucket yet (setup card) + costs consent missing
 *   04-drive-root      drive root: three section folders + share ledger
 *   05-drive-files     file browser (folders + files + toolbar)
 *   06-drive-share     share-link dialog open on a file
 *   07-drive-library   cloud artifact library (sync states)
 *   08-drive-backup    backup section (runs, remote archive, nightly toggle)
 *
 * Usage: node scripts/capture-aws-control-tour.mjs [outDir] [lang] [theme]
 */
import { chromium } from 'playwright'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'

import { json } from './lib/boot-api.mjs'
import { serveDist } from './lib/serve-dist.mjs'
import { stubDashboardApi, logPageProblems } from './lib/stub-dashboard-api.mjs'

const OUT = process.argv[2] || '/tmp/aws-control-tour'
const LANG = process.argv[3] || 'zh-CN'
const THEME = process.argv[4] || 'dark'
mkdirSync(OUT, { recursive: true })

const NOW = '2026-08-31T06:30:00Z'
const ACC = '111122223333'
const ACC2 = '444455556666'

const nullSummary = { storage: null, sites: null, tasks: null, costMonthToDate: null }
const ACCOUNTS = {
  accounts: [
    {
      account: ACC, name: 'prod-main', health: 'ok', summary: nullSummary,
      profiles: [
        { name: 'prod-main', region: 'us-west-2', kind: 'sso', identityOk: true, account: ACC, arn: `arn:aws:sts::${ACC}:assumed-role/Admin/dev`, detail: '', default: true },
        { name: 'prod-readonly', region: 'us-west-2', kind: 'sso', identityOk: true, account: ACC, arn: `arn:aws:sts::${ACC}:assumed-role/ReadOnly/dev`, detail: '', default: false },
      ],
    },
    {
      account: ACC2, name: 'sandbox', health: 'degraded', summary: nullSummary,
      profiles: [
        { name: 'sandbox', region: 'us-east-1', kind: 'credential-process', identityOk: false, account: ACC2, arn: '', detail: 'ExpiredToken: The security token included in the request is expired', default: true },
      ],
    },
    {
      account: '', name: '', health: 'unknown', summary: nullSummary,
      profiles: [
        { name: 'legacy-keys', region: 'eu-west-1', kind: 'other', identityOk: false, account: '', arn: '', detail: 'identity could not be resolved', default: true },
      ],
    },
  ],
  totals: { accounts: 3, profiles: 4, profilesHealthy: 2 },
  generatedAt: NOW,
}

const CONSENT = (svc) => ({
  service: svc, serviceLabel: svc === 's3' ? 'Amazon S3' : 'AWS Cost Explorer',
  profile: 'prod-main', credentialSource: 'profile prod-main', region: 'us-west-2',
  account: ACC, arn: `arn:aws:sts::${ACC}:assumed-role/Admin/dev`,
  identityResolved: true, identityDetail: '', granted: true, reason: '',
  revokedOnAccountChange: false,
  grant: { account: ACC, region: 'us-west-2', profile: 'prod-main', granted_at: '2026-08-20T09:00:00Z' },
})

const GiB = 1024 ** 3
const MiB = 1024 ** 2
const DRIVE = {
  exists: true, bucket: `kirocrew-drive-${ACC}-usw2`, region: 'us-west-2',
  usage: {
    bytes: 3.2 * GiB, objects: 128,
    sections: {
      drive: { objects: 97, bytes: 1.9 * GiB },
      library: { objects: 23, bytes: 0.4 * GiB },
      backup: { objects: 8, bytes: 0.9 * GiB },
    },
  },
}

const LISTING = {
  folders: ['design-assets', 'photos', 'reports'],
  files: [
    { key: 'roadmap-q3.pdf', size: 2.3 * MiB, modified: '2026-08-25T10:12:00Z' },
    { key: 'team-offsite-notes.md', size: 18 * 1024, modified: '2026-08-27T08:40:00Z' },
    { key: 'usage-export.csv', size: 412 * 1024, modified: '2026-08-30T22:05:00Z' },
  ],
}

const SHARES = {
  shares: [
    { id: 'sh-01', account: ACC, section: 'drive', key: 'roadmap-q3.pdf', createdAt: '2026-08-29T12:00:00Z', expiresAt: '2026-09-01T12:00:00Z', note: 'for design review' },
    { id: 'sh-02', account: ACC, section: 'library', key: 'launch-dashboard/v3', createdAt: '2026-08-30T09:00:00Z', expiresAt: '2026-08-31T09:00:00Z', note: '' },
  ],
}

const COSTS_OK = {
  fresh: true, monthToDate: 12.34, projected: 18.9, currency: 'USD',
  byService: [
    { service: 'Amazon Simple Storage Service', amount: 6.1 },
    { service: 'Amazon CloudFront', amount: 3.2 },
    { service: 'AWS Cost Explorer', amount: 0.03 },
  ],
  fetchedAt: NOW,
}
const COSTS_NO_CONSENT = { fresh: false, monthToDate: 0, projected: 0, currency: 'USD', byService: [], fetchedAt: NOW, consentMissing: true }

const LIBRARY = {
  artifacts: [
    { slug: 'launch-dashboard', name: 'Launch Dashboard', kind: 'html', version: 3, updatedAt: '2026-08-30T10:00:00Z', pushedVersion: 3, pushedAt: '2026-08-30T10:05:00Z' },
    { slug: 'kas-session', name: 'KAS Session Deep-Dive', kind: 'markdown', version: 5, updatedAt: '2026-08-29T18:00:00Z', pushedVersion: 2, pushedAt: '2026-08-20T18:00:00Z' },
    { slug: 'cost-report-widget', name: 'Cost Report Widget', kind: 'widget', version: 1, updatedAt: '2026-08-28T14:00:00Z', pushedVersion: null, pushedAt: null },
    { slug: 'team-offsite-photos', name: 'Team Offsite Photos', kind: 'image', version: 1, updatedAt: '2026-08-27T09:00:00Z', pushedVersion: null, pushedAt: null },
  ],
}

const BACKUP = {
  nightly: true,
  runs: {
    snapshot: { key: 'snapshots/workspace-2026-08-30.tar.gz', bytes: 96 * MiB, at: '2026-08-30T02:00:00Z' },
    sessions: { key: 'sessions/2026-08-28T02-00.tar.gz', bytes: 310 * MiB, at: '2026-08-28T02:00:00Z' },
  },
  remote: {
    snapshot: [
      { key: 'snapshots/workspace-2026-08-30.tar.gz', size: 96 * MiB, modified: '2026-08-30T02:01:00Z' },
      { key: 'snapshots/workspace-2026-08-29.tar.gz', size: 95 * MiB, modified: '2026-08-29T02:01:00Z' },
      { key: 'snapshots/workspace-2026-08-28.tar.gz', size: 93 * MiB, modified: '2026-08-28T02:01:00Z' },
    ],
    sessions: [
      { key: 'sessions/2026-08-28T02-00.tar.gz', size: 310 * MiB, modified: '2026-08-28T02:02:00Z' },
    ],
  },
}

const AVAILABLE = {
  profiles: [
    { name: 'prod-main', registered: true },
    { name: 'prod-readonly', registered: true },
    { name: 'sandbox', registered: true },
    { name: 'ml-experiments', registered: false },
    { name: 'personal', registered: false },
  ],
  registeredCount: 3, max: 10, supported: true,
}

const B = '/api/apps/aws-control'

/** aws-control fixture router. Returns true when handled. */
const extra = async (path, route) => {
  const url = new URL(route.request().url())
  const p = url.pathname
  if (p === `${B}/accounts`) return json(route, ACCOUNTS), true
  if (p === '/api/aws/consent') return json(route, CONSENT(url.searchParams.get('service') || 's3')), true
  if (p === `${B}/profiles/available`) return json(route, AVAILABLE), true
  if (p.startsWith(`${B}/profiles/`) && p.endsWith('/reconnect-plan')) {
    return json(route, { method: 'terminal', kind: 'credential-process', command: 'mwinit -o && aws sts get-caller-identity --profile sandbox' }), true
  }
  if (p === `${B}/iam-policy`) return json(route, { policy: '{\n  "Version": "2012-10-17",\n  "Statement": []\n}' }), true
  if (p === `${B}/drive/${ACC}`) return json(route, DRIVE), true
  if (p === `${B}/drive/${ACC2}`) return json(route, { exists: false }), true
  if (p === `${B}/drive/${ACC}/list`) {
    const section = url.searchParams.get('section') || 'drive'
    if (section === 'library') {
      return json(route, { folders: ['launch-dashboard', 'kas-session', 'cost-report-widget'], files: [] }), true
    }
    if (section === 'backup') {
      return json(route, { folders: ['snapshots', 'sessions'], files: [] }), true
    }
    return json(route, LISTING), true
  }
  if (p === `${B}/costs/${ACC}`) return json(route, COSTS_OK), true
  if (p === `${B}/costs/${ACC2}`) return json(route, COSTS_NO_CONSENT), true
  if (p === '/api/shares' || p === `${B}/shares`) return json(route, SHARES), true
  if (p === `${B}/library/${ACC}`) return json(route, LIBRARY), true
  if (p === `${B}/backup/${ACC}`) return json(route, BACKUP), true
  if (p === `${B}/drive/${ACC}/share` && route.request().method() === 'POST') {
    return json(route, {
      url: `https://kirocrew-drive-${ACC}-usw2.s3.us-west-2.amazonaws.com/drive/roadmap-q3.pdf?X-Amz-Signature=...`,
      share: { id: 'sh-03', account: ACC, section: 'drive', key: 'roadmap-q3.pdf', createdAt: NOW, expiresAt: '2026-09-01T06:30:00Z', note: '' },
    }), true
  }
  return false
}

const { srv, base } = await serveDist()
const browser = await chromium.launch()
const ctx = await browser.newContext({ viewport: { width: 1500, height: 950 }, deviceScaleFactor: 1 })
const page = await ctx.newPage()
logPageProblems(page)
await stubDashboardApi(page, {
  slots: [], theme: THEME,
  localStorageEntries: { 'mc-lang': LANG },
  extra,
})

const shot = async (name) => {
  await page.waitForTimeout(400)
  await page.screenshot({ path: join(OUT, name) })
  console.log('captured', name)
}

await page.goto(base + '/aws-control', { waitUntil: 'domcontentloaded' })
await page.getByTestId('accounts-list').waitFor({ timeout: 20_000 })
await shot('01-accounts.png')

// Healthy account console
await page.getByTestId('account-card').first().click()
await page.getByTestId('capability-drive').waitFor({ timeout: 15_000 })
await shot('02-console.png')

// Drive root (sections + share ledger)
await page.getByTestId('capability-drive').click()
await page.getByTestId('drive-sections').waitFor({ timeout: 15_000 })
await page.getByTestId('access-section').waitFor({ timeout: 15_000 })
await shot('04-drive-root.png')

// Files section
await page.getByTestId('drive-section-drive').click()
await page.getByTestId('drive-file').first().waitFor({ timeout: 15_000 })
await shot('05-drive-files.png')

// Share dialog (share lives in the row's overflow menu)
await page.getByTestId('drive-more').first().click()
await page.getByTestId('drive-share').first().click()
await page.getByTestId('share-dialog').waitFor({ timeout: 15_000 })
await shot('06-drive-share.png')
await page.getByTestId('share-close').click()

// Library section
await page.getByTestId('drive-crumb-back').click()
await page.getByTestId('drive-sections').waitFor({ timeout: 15_000 })
await page.getByTestId('drive-section-library').click()
await page.getByTestId('library-section').waitFor({ timeout: 15_000 })
await page.getByText(/launch.dashboard/i).first().waitFor({ timeout: 15_000 })
await shot('07-drive-library.png')

// Backup section
await page.getByTestId('drive-crumb-back').click()
await page.getByTestId('drive-sections').waitFor({ timeout: 15_000 })
await page.getByTestId('drive-section-backup').click()
await page.getByTestId('backup-section').waitFor({ timeout: 15_000 })
await shot('08-drive-backup.png')

// Degraded account: setup card + consent-missing costs
await page.goto(base + '/aws-control', { waitUntil: 'domcontentloaded' })
await page.getByTestId('accounts-list').waitFor({ timeout: 20_000 })
await page.getByTestId('account-card').nth(1).click()
await page.getByTestId('drive-setup').waitFor({ timeout: 15_000 })
await shot('03-console-setup.png')

await browser.close()
srv.close()
console.log('done →', OUT)
