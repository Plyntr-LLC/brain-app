export function fillTemplate(tmpl, map) {
  let out = String(tmpl);
  for (const [k, v] of Object.entries(map)) {
    out = out.split(`__${k}__`).join(String(v));
  }
  return out;
}

export function launchdLabel() {
  return "com.plyntr.brain-sync";
}

export function windowsTaskName(seatId) {
  return `BrainBridge-${seatId}`;
}

export function renderLaunchd(tmpl, { node, watchJs, seatId, logDir }) {
  return fillTemplate(tmpl, {
    NODE: node,
    WATCH_JS: watchJs,
    SEAT_ID: seatId,
    LOG_DIR: logDir,
  });
}

export function renderWindowsTask(tmpl, { node, watchJs, seatId }) {
  return fillTemplate(tmpl, {
    NODE: node,
    WATCH_JS: watchJs,
    SEAT_ID: seatId,
  });
}

export function macInstallCommands({ plistPath, label = launchdLabel() }) {
  return [
    `launchctl bootout gui/$(id -u)/${label} 2>/dev/null || true`,
    `launchctl bootstrap gui/$(id -u) ${plistPath}`,
    `launchctl enable gui/$(id -u)/${label}`,
    `launchctl kickstart -k gui/$(id -u)/${label}`,
  ];
}

export function windowsInstallCommands({ xmlPath, taskName }) {
  return [`schtasks /Create /TN "${taskName}" /XML "${xmlPath}" /F`];
}
