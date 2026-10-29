# Tempo — home testing checklist

This is a development build, not a verified release. Use test data, keep backups, and do not rely on it for an important departure reminder yet.

## Start locally

Install Node.js 20 or newer on the computer hosting the project, open a terminal in this folder, and run `npm start`. The current package has no external runtime dependencies. Open the address printed by the server. Run `npm test` for the automated suite.

The default server listens only on the computer's loopback interface. To test sync across Android and Windows, both devices must open the **same deployed HTTPS origin** backed by the same running server and data directory. The project does not include a published URL or a ready-made HTTPS deployment. See [server/README.md](server/README.md) for the required proxy, storage, account and security constraints. A phone opening its own `localhost` will not connect to the computer's server. Do not expose the HTTP server directly to the internet.

## Test on each target

- Open the same HTTPS site in the intended Windows 11 browser and Android browser; install the PWA using each browser's own install action. Note browser and OS versions.
- Compare the six supplied reference views at their reference sizes and check large text, keyboard, screen reader and narrow screens. The current build has not been visually certified as a 100% match; the live Today and Week timelines have not been visually tested.
- Create, edit and complete a task; check that original example tasks do not become your tasks. Try an empty day, Brain Dump draft/review/cancel, and manual subtask editing, reordering and undo.
- Start, pause and resume focus; close and reopen the app. Check that session completion does not mark the task complete.
- In Brain Dump, choose Voice and explicitly download the on-device model; allow microphone access, record, stop and review the resulting text. Repeat offline after the model is cached, then test permission denial and cancellation. Audio should remain on the device; resulting draft text follows the sync setting. Android and Windows browser behavior is not yet verified.
- Try an optional leave reminder with an explicit departure time two minutes ahead. Check sound/silent and notification permission. Test while open, backgrounded and closed; delivery with the PWA closed or suspended is **not implemented or guaranteed**.
- Sign in to the same account on both devices. Edit on one and observe the other; repeat in the opposite direction. Make different changes offline on both devices, reconnect, and inspect both. Make a conflicting edit and inspect History and recovery. Do not use important data until this has been verified.
- Test initial offline shell loading only after visiting online. Test behavior after restart and after disconnecting the server.

## Known boundaries

Automatic subtask generation needs a chosen generation method; the current editor accepts a manually entered list. Flexible weekly recurrence is implemented but needs device testing; some accommodations are not complete and the live timelines need device testing. Server data is not encrypted at rest, registration is open to reachable users, and password reset/account recovery/deletion are absent. See the project README and the specification for the current implementation and gaps.
