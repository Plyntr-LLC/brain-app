/** Path B package. Caps match the brain-sync worker. Checkout stays out of this app. */
export const PLYNTR_PACKAGE = {
  builders: 2,
  team: 10,
  projectCap: null
} as const

export function plyntrPackageCopy(): string {
  return 'This brain includes 2 builders (owner and scout), 10 agency team seats, and project-only seats with no numeric cap.'
}
