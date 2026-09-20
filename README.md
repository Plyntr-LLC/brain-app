# Brain

The room in front of Agency Brain. Chat with Grok, Claude, Cursor, or ChatGPT against your watched brain folder.

## Download

**[Latest release](https://github.com/Plyntr-LLC/brain-app/releases/latest)**

- Mac (Apple Silicon): signed and notarized `.dmg` on the latest release
- Windows: unsigned `.exe` (SmartScreen may warn)

Direct Mac:

- https://github.com/Plyntr-LLC/brain-app/releases/latest/download/Brain-0.1.14-mac.dmg

After 0.1.1, the app checks GitHub for updates and can install them. Settings has Check for update.

## Dev

```
npm install
npm run dev
```

`npm run pack:mac` builds the signed dmg. `npm run pack:win` builds the Windows installer (unsigned until we have an Authenticode cert).
