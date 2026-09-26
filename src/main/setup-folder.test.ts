import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import {
  bridgeInstallUrl,
  clonePlan,
  githubAppInstallUrl,
  githubInstallReady,
  bridgeSelectionBlocksSync,
  onlySelectedInstall,
  plyntrBrainSyncInstallUrl,
  plyntrGithubInstallReady,
  plyntrInstallPin,
  reuseExistingFolder
} from './setup-folder.ts'

test('reuseExistingFolder never returns a different team folder', () => {
  assert.equal(
    reuseExistingFolder({
      slug: 'harolds-books',
      watchingPath: '/Users/joe/Projects/agency-brain',
      watchingSlug: 'plyntr',
      accountFolder: '/Users/joe/Projects/agency-brain',
      accountSlug: 'plyntr'
    }),
    null
  )
  assert.equal(
    reuseExistingFolder({
      slug: 'harolds-books',
      watchingPath: '/Users/joe/Projects/harolds-books-brain',
      watchingSlug: 'harolds-books',
      accountFolder: null,
      accountSlug: null
    }),
    '/Users/joe/Projects/harolds-books-brain'
  )
  assert.equal(
    reuseExistingFolder({
      slug: '',
      watchingPath: '/Users/joe/Projects/agency-brain',
      watchingSlug: 'plyntr',
      accountFolder: null,
      accountSlug: null
    }),
    '/Users/joe/Projects/agency-brain'
  )
})

test('setup lists Agency Brain and still reaches ready without it', () => {
  const src = readFileSync(new URL('./install.ts', import.meta.url), 'utf8')
  assert.match(src, /label: 'Agency Brain'/)
  assert.match(src, /Boolean\(folder && pickedPresent && gitPresent\(\) && cloudflaredPresent\(\)\)/)
  assert.match(src, /currentBrainFolder\(\)/)
  assert.match(src, /id: 'cloudflared'/)
  assert.match(src, /cloudflaredPresent\(\)/)
  assert.match(src, /SUDO_ASKPASS/)
  assert.match(src, /cloudflared-darwin-arm64\.tgz/)
  assert.match(src, /AbortSignal\.timeout\(120_000\)/)
  assert.match(src, /return resolveCloudflaredBin\(\) !== null/)
  const cf = readFileSync(new URL('./cloudflared-bin.ts', import.meta.url), 'utf8')
  assert.match(cf, /env\.CLOUDFLARED_BIN/)
  assert.match(cf, /spawnSync\('where', \['cloudflared'\]/)
  const phone = readFileSync(new URL('./phone.ts', import.meta.url), 'utf8')
  assert.match(phone, /import \{ resolveCloudflaredBin \} from '\.\/install'/)
  const ipc = readFileSync(new URL('./ipc-stubs.ts', import.meta.url), 'utf8')
  assert.match(ipc, /clone skipped in dry-run/)
  assert.match(ipc, /switchBrain\(cloned\.dest\)/)
  const clone = readFileSync(new URL('./clone.ts', import.meta.url), 'utf8')
  assert.match(clone, /credential\.helper=/)
  assert.match(clone, /x-access-token:\$\{t\}@/)
  const sync = readFileSync(new URL('./brain-sync.ts', import.meta.url), 'utf8')
  assert.match(sync, /gitSyncAuthed/)
  assert.match(sync, /if \(!sync\.ok\)/)
  assert.match(sync, /lastFolder/)
})

test('bridgeInstallUrl opens Brain Bridge for one repo', () => {
  const url = bridgeInstallUrl('acme/brain')
  assert.match(url, /^https:\/\/github.com\/apps\/plyntr-brain-bridge\/installations\/new\?state=/)
  const state = decodeURIComponent(url.split('state=')[1] || '')
  const body = JSON.parse(Buffer.from(state, 'base64').toString('utf8')) as { hq_repo?: string }
  assert.equal(body.hq_repo, 'acme/brain')
  const pinned = bridgeInstallUrl('acme/brain', 332862614, 1383221929)
  assert.match(pinned, /\/permissions\?target_id=332862614&repository_ids%5B%5D=1383221929&state=/)
})

test('githubAppInstallUrl keeps state on installations/new', () => {
  assert.equal(
    githubAppInstallUrl('harolds-books'),
    'https://github.com/apps/agency-brain-sync/installations/new?state=harolds-books'
  )
  assert.equal(
    githubAppInstallUrl('harolds-books', 12345),
    'https://github.com/apps/agency-brain-sync/installations/new?state=harolds-books&suggested_target_id=12345'
  )
  assert.equal(
    githubAppInstallUrl('harolds-books', 0),
    'https://github.com/apps/agency-brain-sync/installations/new?state=harolds-books'
  )
  assert.ok(!githubAppInstallUrl('x', 1).includes('/permissions'))
})

test('Path B install URL pins org and repo on /permissions', () => {
  const url = plyntrBrainSyncInstallUrl('a867878e-79d9-493c-a396-f82736ffa8a3', 332862614, 424242)
  assert.equal(
    url,
    'https://github.com/apps/plyntr-brain-sync/installations/new/permissions?suggested_target_id=332862614&repository_ids%5B%5D=424242&state=a867878e-79d9-493c-a396-f82736ffa8a3'
  )
  assert.ok(url.includes('/permissions'))
  assert.equal(url.includes('/installations/new?'), false)
  assert.equal(url.includes('248626756'), false)
  assert.equal(url.includes('organizations/its-a-test-rosene/settings/apps'), false)
  assert.equal(plyntrBrainSyncInstallUrl('a867878e-79d9-493c-a396-f82736ffa8a3', 332862614), '')
  assert.equal(plyntrBrainSyncInstallUrl('a867878e-79d9-493c-a396-f82736ffa8a3', 0, 424242), '')
  assert.equal(plyntrBrainSyncInstallUrl('a867878e-79d9-493c-a396-f82736ffa8a3', 332862614, 0), '')
  assert.equal(plyntrBrainSyncInstallUrl('id', -1, 424242), '')
  assert.equal(plyntrBrainSyncInstallUrl('id', 332862614, -1), '')
  assert.equal(plyntrBrainSyncInstallUrl('', 332862614, 424242), '')
  assert.equal(plyntrBrainSyncInstallUrl('id', 1.5, 424242), '')
  const pin = plyntrInstallPin({
    brainId: 'a867878e-79d9-493c-a396-f82736ffa8a3',
    orgName: 'its-a-test-rosene',
    repo: 'its-a-test-rosene/rose-wine-brain',
    orgId: 332862614,
    repoId: 424242,
    repoOwner: 'its-a-test-rosene'
  })
  assert.equal(pin.ok, true)
  assert.equal(pin.url, url)
  assert.equal(plyntrInstallPin({ brainId: '', orgName: 'acme', repo: 'acme/x-brain', orgId: 1, repoId: 2 }).detail, 'This brain has no install id yet.')
  assert.equal(plyntrInstallPin({ brainId: 'id', orgName: 'acme', repo: '', orgId: 1, repoId: 2 }).detail, 'This brain has no GitHub repository name yet.')
  assert.match(
    String(plyntrInstallPin({ brainId: 'id', orgName: 'its-a-test-rosene', repo: 'Plyntr-LLC/rose-wine-brain', orgId: 1, repoId: 2 }).detail),
    /not a repository in its-a-test-rosene/
  )
  assert.match(
    String(
      plyntrInstallPin({
        brainId: 'id',
        orgName: 'its-a-test-rosene',
        repo: 'its-a-test-rosene/rose-wine-brain',
        orgId: 1,
        repoId: 2,
        repoOwner: 'Plyntr-LLC'
      }).detail
    ),
    /not a repository in its-a-test-rosene/
  )
  assert.match(
    String(plyntrInstallPin({ brainId: 'id', orgName: 'acme', repo: 'acme/x-brain', orgId: 1 }).detail),
    /organization or repository id is missing/
  )
  const ipc = readFileSync(new URL('./ipc-stubs.ts', import.meta.url), 'utf8')
  assert.equal(ipc.includes('plyntrBrainSyncInstallUrl(issuedId, look.ok ? look.id : undefined)'), false)
  assert.equal(ipc.includes('lookupGithubAccount(parts.org)'), false)
  assert.equal(ipc.includes('https://github.com/apps/plyntr-brain-sync/installations/new?'), false)
  assert.equal(ipc.includes("resolvePlyntrRepoName(orgName, '', repo)"), false)
  assert.match(ipc, /plyntrInstallPin\(/)
  assert.match(ipc, /pinnedPlyntrInstall\(issuedId, parts\.org, parts\.repo\)/)
  assert.match(ipc, /repoOwner: rid\.owner/)
})

test('clonePlan refuses an empty checkout and replaces a blank folder', () => {
  assert.equal(
    clonePlan({ destExists: false, isGit: false, sameOrigin: false, hasMarker: false, empty: false }),
    'clone'
  )
  assert.equal(
    clonePlan({ destExists: true, isGit: true, sameOrigin: true, hasMarker: true, empty: false }),
    'reuse'
  )
  assert.equal(
    clonePlan({ destExists: true, isGit: true, sameOrigin: true, hasMarker: false, empty: false }),
    'refuse-empty-brain'
  )
  assert.equal(
    clonePlan({ destExists: true, isGit: true, sameOrigin: false, hasMarker: false, empty: false }),
    'refuse-other-repo'
  )
  assert.equal(
    clonePlan({ destExists: true, isGit: false, sameOrigin: false, hasMarker: false, empty: true }),
    'replace-empty'
  )
  assert.equal(
    clonePlan({ destExists: true, isGit: false, sameOrigin: false, hasMarker: false, empty: false }),
    'refuse-not-empty'
  )
})

test('plyntrGithubInstallReady rejects the wrong repo and All repositories', () => {
  const repo = 'harolds-books/harolds-books-brain'
  assert.equal(
    plyntrGithubInstallReady({ installed: true, repositorySelection: 'selected', repo }, repo),
    true
  )
  assert.equal(
    plyntrGithubInstallReady({ installed: true, repositorySelection: 'selected', repo: 'other/other-brain' }, repo),
    false
  )
  assert.equal(
    plyntrGithubInstallReady({ installed: true, repositorySelection: 'all', repo }, repo),
    false
  )
  assert.equal(githubInstallReady({ installed: true, repoUrl: 'https://github.com/acme/acme-brain' }), true)
})

test('onlySelectedInstall accepts a one-repo install', () => {
  assert.equal(onlySelectedInstall('selected'), true)
  assert.equal(onlySelectedInstall('selected_repositories'), true)
  assert.equal(onlySelectedInstall('all'), false)
  assert.equal(onlySelectedInstall('all_repositories'), false)
  assert.equal(onlySelectedInstall(''), false)
  assert.equal(onlySelectedInstall(undefined), false)
  assert.equal(bridgeSelectionBlocksSync('all'), true)
  assert.equal(bridgeSelectionBlocksSync('all_repositories'), true)
  assert.equal(bridgeSelectionBlocksSync('selected'), false)
  assert.equal(bridgeSelectionBlocksSync(''), false)
  assert.equal(bridgeSelectionBlocksSync(undefined), false)
})

test('githubInstallReady is true only when GitHub says the app is installed', () => {
  assert.equal(githubInstallReady({ installed: true }), false)
  assert.equal(githubInstallReady({ installed: true, repoUrl: 'https://github.com/acme/brain' }), true)
  assert.equal(githubInstallReady({ installed: true, repo: 'acme/brain' }), true)
  assert.equal(githubInstallReady({ installed: true, allRepositories: true, repoUrl: 'https://github.com/acme/brain' }), false)
  assert.equal(githubInstallReady({ repo: 'acme/brain' }), false)
  assert.equal(githubInstallReady({ installed: false, repoUrl: 'https://github.com/acme/brain' }), false)
  assert.equal(githubInstallReady({ installed: false }), false)
  assert.equal(githubInstallReady(null), false)
})

test('setup:install accepts Agency Brain id', () => {
  const src = readFileSync(new URL('./install.ts', import.meta.url), 'utf8')
  assert.match(src, /TOOL_IDS: NeedId\[\] = \[[^\]]*'ab'/)
  assert.match(src, /export function isNeedId/)
})
