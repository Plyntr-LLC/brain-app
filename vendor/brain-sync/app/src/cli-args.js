const COMMANDS = new Set(["setup", "watch", "status", "sync", "uninstall"]);
const SEAT_ID = /^[a-z0-9][a-z0-9-]{2,40}$/;

export function resolveCliCommand(argv) {
  const cmd = argv[2] || "";
  const rest = argv[3] || "";
  if (cmd === "watch") return { action: "watch", seatId: rest };
  if (cmd === "setup" || cmd === "") return { action: "setup" };
  if (cmd === "status") return { action: "status", seatId: rest };
  if (cmd === "sync") return { action: "sync", seatId: rest };
  if (cmd === "uninstall") return { action: "uninstall", seatId: rest };
  if (SEAT_ID.test(cmd) && !COMMANDS.has(cmd)) return { action: "watch", seatId: cmd };
  return { action: "help" };
}
