Fixed: 1, 3, 7. Still open: none. New: none.

**1.** The refuse list now includes the sign-in-host near-misses (`https://github.com/login/devicex`, `https://github.com/devices`, `https://accounts.google.com/o/oauth2/auth?client_id=a` with neither `response_type` nor `redirect_uri`) and the two container hosts (`https://not.github.com/login/device`, `https://github.com.evil.com/login/device`). A host suffix or substring match allows the container hosts, and a path `startsWith` or `includes` match allows `/login/devicex` and `/devices`, so that shim now fails step 1. The exact-match rule is in the same sentence, with the only prefix exception still `/workplace/auth/cli/`.

**3.** On this Mac, `ps -axo pid=,comm=` is the executable path with no arguments, and it stays the full path even with `COLUMNS=40`. One process ends with `/MacOS/Google Chrome`. The helpers end with `Google Chrome Helper` and `Google Chrome Helper (Renderer)`, so they do not match. A new renderer is not a new oracle pid.

**7.** The 2-second `pgrep -P` / `lsof` sample is gone. The test process and every child it starts run under one `sandbox-exec` profile that denies `file-write*` on the agency brain, real userData, Agency Brain config, `/Applications/Brain.app`, and the real CLI homes. That covers a child that exits immediately, including a git write under the brain and an unlink of `~/.grok/leader-brain-app.sock`. The pre-launch `touch` must fail and leave no file. `--no-sandbox` is only the launch flag the probe needed so Chromium can start inside that profile; the packed-app click, key, and paste checks are unchanged.

APPROVE
