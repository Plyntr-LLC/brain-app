import { protocol } from 'electron'
import { handleBrainMediaRequest } from './play.ts'

export const BRAIN_MEDIA_SCHEME = 'brain-media'

export function registerBrainMediaScheme(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: BRAIN_MEDIA_SCHEME,
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        stream: true,
        corsEnabled: true,
        bypassCSP: true
      }
    }
  ])
}

export function handleBrainMediaProtocol(): void {
  protocol.handle(BRAIN_MEDIA_SCHEME, (request) => handleBrainMediaRequest(request))
}
