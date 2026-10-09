The checks exercise real CLIs, a packed app, and the picture. I would still not ship this commit as it is.

1. **Cmd and Ctrl chords other than A, C, V, X, and Z never reach the page.** In `BrowserPicture`, any Meta chord on Mac (Ctrl on Windows) that is not one of those edit keys returns before a `browser:key` send. Cmd+Left, Cmd+Right, Cmd+Up, Cmd+Down, Cmd+Backspace, and Cmd+Shift+Arrow are the Mac ways to move and select in a field; Ctrl+Arrow is the same on Windows. Behavior 6 says arrows, Backspace, Delete, Home, End, PageUp, and PageDown go through with modifiers. The render check only sends Tab, Home, a letter, the edit chords, and Cmd+Q, so it stays green. Send those navigation keys with their modifiers. Leave non-editing app chords such as Cmd+Q local.

2. **A drag that ends in the empty band never releases the button.** `pagePoint` clamps `move` and `up` to the element box, then `mapClick` returns null for the object-fit bands inside that box. The `up` is dropped, and there is no window-level `mouseup`, so a release outside the button is dropped too. The packed picture was 583×318 for an 1100×800 page, so those bands are the normal wide layout. The live drag stayed inside the field, which is why it passed. On `up` and `move` while a button is held, clamp into the contained page rectangle and send that point, including a release that happens outside the picture.

3. **The commit is still version 0.1.135.** `package.json` and `package-lock.json` bump to 0.1.136 only in the unstaged tree. The plan’s version is 0.1.136, and the packed check ran from that dirty tree. A clean pack of `fb16811` is 0.1.135, which will not update an install that is already 0.1.135. Include the bump in the release commit.

REJECT
