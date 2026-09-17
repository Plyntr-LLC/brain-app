/// <reference types="vite/client" />

import type { BrainApi } from '../../preload/index'

declare global {
  interface Window {
    brain: BrainApi
  }
}

declare namespace JSX {
  interface IntrinsicElements {
    webview: React.DetailedHTMLProps<React.HTMLAttributes<HTMLElement> & { src?: string }, HTMLElement>
  }
}

export {}
