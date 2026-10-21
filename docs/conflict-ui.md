# Conflict screen

The resolve screen is for a phone held in one hand. It is stacked, one choice at a time, and it does not hide text that would be lost.

## What each tool does

**VS Code's merge editor.** Each conflict region has Accept Current, Accept Incoming, and Accept Combination. The combination keeps both sides, and the result editor below is a real document you can still type in. Regions that did not change collapse, so the eye stays on the conflict. Color is paired with a control, not used as the only signal.

Taken: a choice on every changed block (this phone, GitHub, or both), an editable result, and collapsed unchanged lines. "Both" also asks which side comes first, because a phone cannot show a side-by-side combination the way the desktop editor can.

**GitHub's web conflict editor.** The conflicted files are a list. Opening one shows the two sides, and nothing is resolved until an explicit action. You can still edit the text before that action.

Taken: a list of every conflicted note, with the path and why it is here, and one primary Resolve button. The button stays disabled until every block has a choice, so a half-decided note cannot be saved by accident.

**Obsidian Sync.** A conflict becomes a second note, `Note (conflict date).md`. The app does not merge. The person copies the text they want to keep. That is safe and clumsy: the copy is easy to miss, and the original stays conflicted with no screen to finish.

Taken: a separate note only when someone taps "Keep both as separate notes." Older `(conflict …).md` copies already on the phone stay in the list and can be opened against the original or dismissed. Dismiss deletes that copy only after the tap. A new conflict stores GitHub's text on the note and still writes that copy, so a failed screen never loses a side.

**Working Copy on iOS.** A phone is too narrow for columns. The diff is stacked, the targets are large, and resolving is one commit you can still edit. Ours and theirs are named in words.

Taken: "On this phone" and "On GitHub" as the only side names, each with the time that side last changed on this phone's clock. GitHub's time is when this phone read that version ("As of …"), not a guessed commit date. The app does not call the commits API for blame; a failed extra request must not block resolving. Targets are at least 44pt, type is `rem` on the system font, and additions and deletions use a `+` / `−` plus the words Added and Removed. The colors are tested for contrast in light and dark. The merged text has a preview before Resolve. Undo keeps a local backup of the discarded side and a toast.

## Offline

Resolve writes the note and the sync queue on the phone. If the network is down, the push waits. Synced is still shown only after GitHub accepts the ref update.
