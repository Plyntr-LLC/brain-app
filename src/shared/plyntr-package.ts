/** Path B package. Caps match the brain-sync worker. Checkout stays out of this app. */
export const PLYNTR_PACKAGE = {
  builders: 2,
  team: 10,
  projectCap: null
} as const

export function plyntrPackageCopy(): string {
  return 'At most 2 builders (owner and scout). People caps follow the plan on that business. Project-only seats have no numeric cap.'
}
