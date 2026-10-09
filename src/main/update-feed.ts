/**
 * A release rehearsal: the packed app takes its update from a feed on this Mac, so the real install and relaunch can
 * be checked before a build is published. Only a loopback http address is taken. Squirrel still refuses an update
 * that is not signed like the running app, and electron-updater never installs an older version.
 */
export function testFeed(env: NodeJS.ProcessEnv = process.env): string | null {
  const url = String(env.BRAIN_TEST_UPDATE_FEED || '')
  return /^http:\/\/127\.0\.0\.1:\d{2,5}\/$/.test(url) ? url : null
}
