/// <reference types="vite/client" />

import type { BrainApi } from '../../preload/index'

declare global {
  interface Window {
    brain: BrainApi
  }
}

export {}
