/** Previous company-setup step. Null means Back leaves the wizard. */
export function previousCreateStep(step: number, hasBrain: boolean): number | null {
  if (step <= 2) return null
  if (step === 4 && hasBrain) return 2
  return step - 1
}
