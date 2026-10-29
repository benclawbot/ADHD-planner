# Tempo Planner — capability inventory and working specification

Status: working specification and internal review, 29 October 2026. Prepared from the supplied Claude artifact. The user selected the original HTML as the default visual presentation and requires a 100% match. Delivery is settled as a Progressive Web App (PWA) for Android and Windows 11; native Android and Windows packages are not the delivery target. This does not imply that target-platform installation, rendering or runtime behavior has been verified.

## 1. Purpose and evidence

Tempo is a planning concept for neurodivergent people, including people with ADHD, who may benefit from making time visible, reducing the burden of choosing a next action, capturing thoughts quickly, and recovering from interruptions without shame. These are design hypotheses, not clinical claims; test them with people with varied needs. The user requires mobile and desktop with automatic sync between them. Target platforms are Android and Windows 11, with delivery as a PWA. Account method and release scope are undecided; automatic cross-device sync remains a requirement. A self-hosted client/server foundation has been implemented and tested with simulated clients; no service is deployed and real device behavior remains unverified.

Source: `Tempo Planner _1_.html` supplied with this task. It contains six embedded screen previews: mobile Today, Focus, Brain dump, Settings; desktop Today and Week. The embedded screen templates have static example data and essentially empty component logic, except for a design-time accent value. Their controls have no application handlers; the textarea can be edited as an ordinary HTML field, but no saving or processing is specified in the code. Therefore the inventory describes **depicted intentions**, not verified operational features. No application backend, identity, durable storage, actual timer, speech recognition, reminders, or synchronization implementation was found in the screen templates. Browser inspection was unavailable because local browser use was disabled; review is based on unpacked source and layout, not a rendered or interactive accessibility audit.

Evidence notation: **A** = explicitly shown or stated by artifact; **I** = needed to make a depicted feature usable; **P** = proposed design decision needing validation. Each requirement below labels its origin. Acceptance criteria are proposed, not evidence of an existing implementation.

## 2. Complete capability inventory

| ID | Capability in the artifact | Evidence and intended benefit | Coverage / limitation |
|---|---|---|---|
| C01 | Today overview | A: current day/date, day-left duration and bar, current task, up-next list | Mobile and desktop previews; values are examples |
| C02 | Time-aware guidance | A: advice about when to start/finish a task before a call | Two previews give different examples; algorithm unspecified |
| C03 | Single “Now” task | A: task title, approximate duration, due time, focus start and “Stuck?” | How current task is chosen or changed is unspecified |
| C04 | Time-sized queue | A: mobile horizontal blocks proportional to task duration; up-next and “+3 more” | Expansion and ordering not implemented |
| C05 | Daily timeline | A: desktop hour scale, scheduled work, lunch, meeting and gym; blocks sized by duration | Desktop concept only; interaction and overlaps unspecified |
| C06 | Week workload overview | A: five day columns, booked time, proportion of an eight-hour day, light/full labels, current day, open time and unscheduled Later note | Weekends, navigation, customization and precise scale unspecified; see review |
| C07 | Focus session | A: 25-minute start, circular countdown example, current task, session 1 of 2, Pause, Done and Back | No running timer or rules for sessions are implemented |
| C08 | Body double | A: “Silent co-working timer, no camera” with a visual switch | Whether another person exists or it is just a timer is unspecified; do not imply an actual person |
| C09 | Break menu | A: Stretch 2 min, Tea, One song | Displayed suggestions; selection or timing behavior unspecified |
| C10 | Getting unstuck | A: “Stuck?” and an example smallest next step | Source of suggestion, editing and activation unspecified |
| C11 | Brain dump | A: free-text input, voice option, defer sorting until after capture | Speech, saving and handling permissions absent |
| C12 | Sort captured thoughts | A: Sort into queue; six-item count; four examples with title, category/context, estimated duration, due/business-hours detail, Today/This week/Later destinations | Sorting mechanism and user confirmation unspecified; only four of six examples are displayed |
| C13 | Protect the day from unscheduled items | A: unscheduled items go to Later; nothing is due today unless already planned | The exact meaning of due versus scheduled needs clarification |
| C14 | Transition warnings | A: setting shown on, five minutes before switching tasks | Trigger and delivery not defined |
| C15 | Persistent reminders | A: setting shown on, every ten minutes until done | Snooze, limits, quiet hours and delivery not defined |
| C16 | Flexible recurring tasks | A: setting shown on; task can be completed within a week without a fixed day | Recurrence creation and rollover not defined |
| C17 | No-guilt rescheduling | A: setting shown on; no overdue count or broken streaks | Actual rescheduling UI and rules not shown |
| C18 | Hyperfocus check-ins | A: setting shown on; every 60 minutes in Focus | Interaction, timer and delivery not defined |
| C19 | Low-stimulation mode | A: setting shown off; muted colors, no badges, batched alerts | Batch schedule, exceptions and accessible contrast unspecified |
| C20 | Automatic cross-device sync | A: automatic on each task change; phone and desktop status, last sync, online indicator and Sync now | A stated promise only; no sync code found |
| C21 | Conflict history | A: newest edit wins; other version stays in History for 30 days | History UI, clock ordering and restore mechanics unspecified |
| C22 | Navigation and accommodation presentation | A: mobile Today/Plan/Focus/Brain dump bottom labels; desktop Today/Week/Focus/Brain dump sidebar; settings screen | Navigation destinations are previews; no Settings entry is shown, and mobile Plan is not depicted |
| C23 | Legibility and restrained presentation | A: Atkinson Hyperlegible, relatively large controls, labels, muted interface, task durations in text, dark focus screen | These are visual choices, not proof of accessibility or suitability for every person |

## Approved visual reference and fidelity requirement

The user explicitly selected the original supplied `Tempo Planner _1_.html` over the three exploratory Windows concepts. It is the visual authority and default presentation for Android and Windows 11. Match the original design 100% for each depicted screen at its reference dimensions: mobile Today, Focus, Brain dump and Settings at 390 × 844; Windows Today and Week at 1280 × 800. Preserve its layout, hierarchy, typography, colors, spacing, dimensions, copy treatment, controls and visual states. Do not substitute the generated variations or redesign the interface.

The artifact provides no mobile Plan screen or Windows Focus, Brain dump or Settings screen. Those undepicted surfaces and non-reference viewport sizes require faithful adaptations of the same visual language; their exact appearance cannot be verified as a 100% match to a screen that does not exist. Preserve standard platform control behavior and accessibility without gratuitous visual changes. Resolve any direct conflict between exact visual fidelity and correcting a functional issue with the user before changing the reference appearance. The review findings remain risks, not authorization to redesign.

Acceptance requires side-by-side comparison of rendered implementation with the original screen at each reference size, plus checks at practical Android and Windows sizes, zoom and text scaling, and real target runtimes. Browser access was unavailable during the initial review, so the source-derived reference has not yet been visually inspected. A fidelity claim requires actual rendered evidence; the 100% match is the user's target, not a verified result.

## 3. Product principles and boundaries

- I: One clear next action, with access to the rest of the plan; do not hide urgent information solely for simplicity.
- A/I: Capture first and sort later. Never silently place an inferred item into Today or invent a due time. Preserve the original capture and make suggestions editable.
- A/I: Rescheduling is neutral: avoid punitive overdue counts or broken streaks. Actual deadlines remain visible and accurately labeled.
- P: Accommodations are individually configurable; the examples in the preview are starting proposals, not universally suitable defaults. No setting implies a diagnosis.
- P: Core planning is usable offline; automatic sync resumes when connectivity returns. Server/account choices remain open.
- P: Start with human-controlled, deterministic planning and sorting. An AI provider or automated external calendar integration is not evidenced or required by the artifact.

## 4. Functional specification and acceptance criteria

### F01 — Tasks, scheduling and Today (C01–C05, C13, C17)

**Model.** I: A task has a stable ID, title, optional notes/context, estimated duration, optional deadline, status, optional scheduled start/end or date, and optional smallest next step. Keep deadline, scheduled time and Today membership distinct. A task with no schedule stays in Later unless the user explicitly places it in a day or a flexible window. P: Support create, edit, complete, undo completion, reschedule, and recoverable delete; record creation/update metadata for sync. Do not infer deadlines or priority from sparse input.

**Today.** A/I: Show local date, one user-selected or explainably chosen Now task, duration and deadline if present, focus start, Stuck, and ordered upcoming work. Expand the full queue with a visible way back. Empty, completed and no-schedule days should offer a calm useful action. Users can change Now without changing task data accidentally.

**Time display.** P: Let the user configure day start/end and time zone. Day left means remaining wall-clock time until configured end, clamped to zero, not free time; label it accordingly. Show unscheduled work separately. Avoid claiming a task will finish before an appointment unless a reliable start, duration and relevant constraint exist; show estimates and identify conflicts. Use durations consistently, including time-zone/DST changes. Distinguish past, current, future and unscheduled items.

**Acceptance.** A task saved as Later never appears as scheduled today without an explicit user action; a due-today task remains visibly due without being silently scheduled. Changing a schedule updates Today and timeline; undo restores prior state. Now has a meaningful empty state. Expanding the queue exposes every item. Advice disappears or becomes an explicit conflict when the required time does not fit.

### F02 — Timeline and week (C05–C06)

A/I: Desktop Today presents timed events and tasks on a time axis; show start/end and proportional heights, with text equivalents. Week shows actual booked durations, availability and unscheduled items separately. P: Provide a usable mobile Plan view with a day/week list as well as desktop; the artifact does not provide its design. Provide previous/next/current period and accessible non-drag controls for creating or moving an item. The displayed range and day length are user-configurable; weekends are available.

P: Calculate booked time from the union of timed intervals so overlaps do not double-count occupied time; show overlap and item totals separately. An untimed duration is not counted as booked until scheduled. Define workload percentage as occupied minutes / configured day minutes; show exact values beyond 100% when applicable, without clipping the textual value. Avoid categorical “light/full” thresholds until validated or show an explained, configurable rule. If minimum visual size makes a short block no longer proportional, say so and preserve the exact text. A true timeline leaves open space in its actual position; a stacked duration summary must be labeled as such.

**Acceptance.** A 30-minute and 60-minute block use the same scale except for declared minimum touch size; empty space is represented. Overlapping events are distinguishable and do not double-count occupied time. All seven days, time-zone changes and days with no plan are accessible. No unscheduled item inflates a day’s booking.

### F03 — Focus, breaks and getting unstuck (C03, C07–C10, C18)

A/I: Start a 25-minute focus session for a chosen task; show task, time remaining, pause/resume, done and exit. P: Duration is adjustable; pause freezes remaining time, resume preserves it, and Done ends the session without automatically marking the task complete unless the user explicitly chooses that action. Store state and absolute timing information so reopening after backgrounding recalculates accurately; handle device clock changes and sleep. On end, provide a quiet completion state and optional break. The artifact's “session 1 of 2” has no defined cycle; make cycle count optional until designed.

A/I: Provide break suggestions (stretch, tea, one song) without mandatory timers. “Stuck?” reveals an editable smallest next step; user can create or select it, dismiss it or return. No generated claim is presented as fact. Body double must be labeled as a silent timer unless a real, consent-based co-working service is designed; no camera or other person is implied by the current concept.

P: If enabled, check in at the chosen interval of active focus time, default proposal 60 minutes; allow continue, pause or dismiss. Avoid firing repeated alerts while paused. Synchronize session state and prevent two devices from unknowingly starting duplicate sessions; define one active session per account with a clear takeover flow, and use a server revision when online. Offline simultaneous sessions must be reconciled without deleting either record or pretending they were one session.

**Acceptance.** A 25-minute session remains accurate after app background/reopen; pause holds time; end and task completion are distinct. The same online session is visible across devices, with a clear takeover action. No body-double participant is claimed without one. A check-in can be dismissed without ending work.

### F03a — Task decomposition and editable subtasks (user-requested)

**Intent.** The user asks to decompose a larger task into a proposed list of subtasks linked to their parent, and to let the person rearrange, delete and edit them. Show the complete proposed list first so the person can review the sequence. This is an approved capability; the mechanism for producing proposals (manual, rules or AI), provider and any associated cost or data processing remain undecided. Do not assume a remote AI service or invent factual details, deadlines or dependencies.

**Flow.** From a task, request a proposed breakdown. Present the parent and all proposed steps in an editable ordered list. Let the person edit a step's text, remove any step, and move steps up or down before accepting; also permit adding a step. Accepting creates ordered subtasks linked to the parent. Cancel preserves the original task and does not create subtasks. An empty or failed proposal leaves the task intact and offers manual entry or retry. After acceptance, the person can edit, add, reorder, complete, uncomplete and remove subtasks without losing the parent; offer undo for removal. The parent remains a separate task, and completion of its subtasks does not silently complete it. Whether and how to show parent progress requires design review.

**Meaning of linked.** Each subtask belongs to its parent and retains a stable ID and order. The list order does not automatically imply a blocking dependency: explicit prerequisite logic is not yet requested. The person can work out of order. Subtasks persist offline and sync between Android and Windows alongside parent tasks; concurrent edits, removal and reorder must preserve recoverable data under the sync conflict policy. The breakdown is optional; no task requires subtasks.

**Visual constraint.** Keep the approved original HTML as the visual authority. The original does not show a subtask editing screen, so this new interaction needs a faithful extension and user review; do not change the existing reference screens simply to introduce it.

**Acceptance.** Given a parent task, the person requests a breakdown and sees a complete proposed, ordered list before acceptance. They edit one step, move another, remove one and add another; after acceptance the resulting steps appear in that order under the correct parent. Cancel creates no steps. Completing a step leaves the parent and other steps intact; a removed step can be undone. The accepted list survives restart and appears on the other device after sync. Offline concurrent changes do not silently discard a step. Test with a task such as “prepare taxes,” without asserting that a generated suggestion is fact.

### F04 — Brain dump and triage (C11–C13)

A/I: Capture free text without required categorization, save draft automatically, and keep original text through sorting. P: Voice is optional, explicitly permissioned, with a visible recording state, stop/cancel and editable transcript; typing remains fully usable when voice is unavailable or denied. Disclose where audio/transcription is processed before use; do not start recording automatically.

A/I: Sort produces reviewable candidate items, showing the proposed title, category/context, duration, deadline and destination only when supported by input or explicitly marked as a suggestion. User edits, rejects or accepts each candidate, including a bulk accept action. Preserve unsorted text on errors. A user may assign Today, This week or Later; a flexible weekly item is not a fixed appointment. The preview's proposed phone duration, business hours and budget deadline cannot be established from its raw text; such values must not be silently invented. P: Exact parsing technology is undecided, and any remote processing is opt-in with disclosed data handling.

**Acceptance.** A mixed dump can be saved offline, reopened, split into reviewed candidates and later synced. An ambiguous “dentist sometime” has no invented date; suggested facts are labeled and editable. Permission denial leaves typed capture working. A failed sort preserves text.

### F05 — Accommodations and reminders (C14–C19)

A/I: Provide independent, accessible controls for transition warnings, repeated reminders, flexible recurrence, neutral rescheduling, hyperfocus check-ins and low-stimulation presentation. The preview examples are 5, 10 and 60 minutes, respectively. P: Make intervals, delivery channel, quiet hours and maximum repeats configurable. Default notification permissions to system-controlled opt-in. Provide snooze, dismiss, complete and disable actions; distinguish a reminder from a fixed calendar event. If OS permission is denied or background delivery is restricted, display that state and do not promise delivery. Quiet hours and low-stimulation batching must not silently suppress a user-designated important reminder; define and disclose exceptions.

P: A flexible recurring task has a recurrence rule, time zone, completion window and an explicit missed-window policy. One completion satisfies the current occurrence; a missed occurrence does not become a punitive streak or silently vanish. An actual deadline is still presented. Users can reschedule with a single clear action and undo it.

**Acceptance.** Setting changes persist and sync; disabling an alert cancels pending notifications. A reminder can be snoozed or stopped; no infinite notification loop. A weekly task can be completed any day in its window and creates only one completion for that occurrence. Screen readers can identify and toggle every control.

### F05a — Gentle leaving-the-house reminder (user-requested)

For an event that requires leaving home, the person can set a departure time and opt in to a gentle notification two minutes before that time. For example, if they need to leave at 14:00, notify at 13:58: “Time to get ready to leave for your appointment.” The notification should be concise and non-disruptive, with no full-screen interruption. The lead time and notification sound or silent delivery are adjustable; two minutes is the requested starting example, not a prediction of how long getting ready takes. The person may set an earlier preparation reminder separately if useful. Do not assume a journey duration or create a departure time from the appointment automatically.

The reminder is optional for each applicable event. Provide dismiss and snooze, allow the person to turn it off or change it, and retain the event and reminder settings across Android and Windows sync. Notification permission and actual delivery remain device-specific; show when permission is unavailable and do not claim delivery if the operating system prevents it. Avoid duplicate alerts across devices where practical; define device delivery behavior during implementation. Follow the approved visual reference, extending it faithfully where the artifact has no corresponding screen.

**Acceptance.** An event with a 14:00 departure and a two-minute reminder schedules a gentle notification for 13:58 in the event's time zone. Changing departure or lead time updates the scheduled reminder; disabling it cancels it. Dismiss and snooze work, and an optional separate preparation reminder remains distinct. Settings sync across devices; a denied notification permission is visible, and no reminder is claimed delivered without evidence. Test on actual Android and Windows 11 devices, including time-zone changes and background operation.

### F06 — Automatic sync and recovery (C20–C21)

**Scope.** A: automatically synchronize changes and offer Sync now, device status and conflict history for 30 days. I/P: Sync all task fields, schedules, completion, captures, recurrence, user settings and session records, with per-device notification permissions remaining local. Sign in to the same account on each device. Initial merge must never silently replace local unsynced work; show a review if account data and local data conflict. Define account and recovery method before implementation.

**Transport and ordering.** P: Save edits locally first in a durable operation queue; assign stable IDs and idempotency keys. Send automatically after each committed change when online, retry with bounded backoff and on reconnect, and pull remote changes on sign-in, resume and notification/poll. A manual Sync now initiates the same process; it does not override conflicts. Server assigns an authoritative revision/commit order, not device wall-clock time, since device clocks can differ. This refines the artifact's “newest edit wins”: last accepted server revision is the deterministic provisional winner for simultaneous edits; show the losing version and its provenance in recoverable history. Prefer field-level merges for independent fields; preserve both values for overlapping changes. Repeated delivery must not duplicate data. The final sync/conflict policy is a product decision, not an existing implementation.

**Deletion and history.** P: Synchronize tombstones, retain prior versions for at least 30 days from conflict resolution, allow preview and restore as a new revision. A delete versus edit is a conflict: retain the edited content for recovery and show the outcome. Specify backup and account-deletion policies before launch; 30-day conflict history is not a complete backup strategy.

**State.** I: Show pending, syncing, synced with actual last successful time, offline, authentication needed and error; expose unsent change count without alarming badges. Never display “synced” until local pending changes are acknowledged and remote changes pulled. Offer retry and explain whether data is safe locally. Communicate storage failure rather than pretending a save succeeded.

**Acceptance.** Edit on mobile online and observe the same change on desktop after automatic sync; repeat in the other direction. Make independent offline edits on both devices, reconnect and confirm both survive. Make conflicting edits, including deletion versus edit, and confirm deterministic outcome, visible losing version and restoration within 30 days. Retry duplicated operations without duplicate tasks. Verify stale credentials, interrupted transfers, offline restart, device clock skew, and local storage failure. Measure propagation latency under representative conditions; do not promise instantaneous delivery while offline or under OS restrictions.

### F07 — Navigation, accessibility and privacy (C22–C23)

I: Every destination, including Settings, has an obvious route and a return path on mobile and desktop. Navigation uses native semantic links/buttons, visible selected state and keyboard focus; don't rely on color alone. Support screen readers, keyboard operation, text enlargement, reduced motion and touch targets, visible labels and errors. The content must scroll and reflow at narrow screens, zoom, long translations and dynamic text without clipping or overlaying navigation. Test real devices and assistive technology; aim for WCAG 2.2 AA where applicable, then validate rather than asserting compliance.

P: Collect only necessary account and planning data. Encrypt in transit and at rest, enforce per-account authorization server-side, protect secrets, define retention, export and account deletion, and make backup and recovery behavior clear. Planning data may contain sensitive information; do not infer diagnoses from it. Default telemetry to minimal, avoid raw task content, and explain any optional analytics or external processors. Confirm platform-specific notification and microphone behavior in the actual release environments.

## 5. Data and lifecycle outline

| Entity | Minimum suggested fields | Important rules |
|---|---|---|
| Task | ID, title, notes/context, estimate, deadline, status, next step, timestamps/revision | Deadline and scheduling are distinct; optional fields remain unknown if not supplied |
| Subtask | ID, parent task ID, text, completion state, order, timestamps/revision | Linked to parent; ordering is not an implicit prerequisite; sync and recover changes |
| Schedule block | ID, task/event ID, start/end, time zone, revision | Supports overlaps and DST; preserve event semantics |
| Capture | ID, original text, draft state, candidates, created/updated revision | Retain source until user explicitly discards it |
| Recurrence | ID, rule, window, zone, occurrence/completion records | Define missed windows and edits to series versus occurrence |
| Focus session | ID, task, state, duration, start/pause/finish timestamps, revision | Separate session end from task completion; preserve concurrent offline records |
| Preferences | per-account accommodation settings, day bounds; per-device permission state | Apply notifications only where permitted |
| Sync operation/history | operation ID, entity ID, base and server revision, change, tombstone, conflict versions, timestamps | Idempotent retry; 30-day conflicting-version recovery; access controlled |

## 6. Review findings and unresolved decisions

| Priority | Finding | Evidence / impact | Recommended disposition |
|---|---|---|---|
| High | Previews do not implement the behavior they suggest | Screen component logic contains no feature handlers or storage/sync | Treat as visual/product reference, build and validate each behavior |
| High | Week scale misrepresents time | Each day's task blocks use flex weights inside a fixed 400px column, so the booked blocks expand to fill it; gaps/minimum heights further distort the claimed eight-hour scale | Preserve the approved reference appearance; document the discrepancy and seek a user decision before any visible correction. Test time calculations separately |
| High | Inferred brain-dump details are unsupported | Input contains “budget” and “call the bank re card,” while results add 40 min, due 17:00, 10 min and business-hours needs | Label suggestions, request review, do not manufacture deadlines |
| High | Sync conflict promise is incomplete | “Newest edit wins” has no definition of clocks, offline edits, deletion or restore | Decide server ordering, preserve losing data and test multi-device cases |
| High | Fixed mobile dimensions and clipping risk | Mobile templates specify 390×844 and `overflow: hidden`; bottom navigation is absolutely positioned | Reflow and scroll; test smaller screens, large text and keyboard |
| High | Visible controls lack accessible semantics/behavior | Several switches and mobile navigation are styled divs/spans; controls lack handlers | Use semantic controls, labels and keyboard/screen-reader tests |
| Medium | Navigation and settings coverage incomplete | No visible Settings entry; Plan has no mobile screen; desktop Focus/Brain dump/Settings not shown | Design reachable, equivalent flows across devices |
| Medium | Inconsistent example schedules and counts | Mobile advice differs from desktop; six sorted items but four shown; queue and timeline examples differ | Derive all screens from shared data; indicate hidden items |
| Medium | Day-left and capacity semantics unclear | Example says 5 h 40 and 62%; week assumes eight hours, desktop timeline 09:00–19:00 | Define configured day bounds, capacity, overlaps and labeling |
| Medium | Reminders may overwhelm or fail silently | Repeats every 10 min until done; batching and OS constraints unspecified | User-controlled limits, snooze, quiet hours, permission/status visibility |
| Medium | Body double and focus completion ambiguous | “Silent co-working timer, no camera” does not establish another participant; Done has no defined outcome | Describe honestly and separate session completion from task completion |
| Medium | ADHD suitability is unvalidated | Artifact provides design hypotheses, no user research or outcome evidence | Test with diverse neurodivergent users; allow personalization and avoid medical claims |

Decisions still required before implementation: (1) account, hosting and recovery requirements; (2) MVP feature selection and which accommodations default on; (3) the generation method for AI-assisted task decomposition and its privacy and cost; voice recognition was requested on-device; (4) exact conflict/history and deletion policy; (5) calendar integrations, if any; (6) PWA browser/platform support expectations and acceptable notification behavior and sync latency. PWA delivery for Android and Windows 11 is settled; native packages are not the delivery target. The specification's other P-labeled choices are recommendations for review, not settled decisions. The original HTML is the settled visual reference; the generated variations are rejected.

## 7. Suggested delivery and verification plan

1. Validate task model, Today/Later semantics, scheduling, text capture and navigation with target users. Resolve platform and identity choices.
2. Implement durable local storage and account sync, including offline recovery and conflict history, before claiming cross-device reliability. Build Today, task editing and weekly view from shared records.
3. Add focus, accommodations and notification behaviors; validate platform delivery separately. Voice transcription is requested on-device; the current browser implementation downloads a pinned local model and must be verified on Android and Windows. Automatic task-decomposition AI remains a separate decision.
4. Test complete workflows: capture → review → schedule → focus → pause/complete → reschedule; mobile-to-desktop and desktop-to-mobile; offline, conflict and restore; recurrence and reminders; accessible controls and responsive layouts. Use actual supported devices and OSs, plus keyboard/screen reader, low-vision zoom, reduced motion and permission-denied cases.
5. Conduct moderated tests with people with differing ADHD and neurodivergent experiences. Observe task initiation, ability to find/change the next task, missed reminders, perceived pressure, recovery after interruption and understanding of sync; include negative findings. These are research measures, not clinical outcomes.

## 8. Review status

This draft has been checked against all six embedded templates, visible text, controls and component scripts. It separates explicit artifact features from proposed behaviors and identifies gaps, conflicts and acceptance tests. The PWA delivery choice and original HTML visual authority are settled. The sync client and self-hosted server have automated tests but are not deployed or verified on target devices. Dependable background notifications and Android/Windows target verification remain outstanding. This specification has not been clinically evaluated or validated with participants. Browser/computer automation is unavailable for this task, so rendered-screen comparison and target-device verification remain outstanding.

## Voice implementation update

The user selected on-device speech-to-text for Android and Windows 11. The PWA uses a pinned multilingual Whisper Tiny model in an on-device browser worker, downloaded on first setup. Microphone audio is processed locally; transcribed text becomes a normal draft and follows the user-configured sync setting. The model has been exercised offline in a Node CPU harness with public sample audio, but browser WASM, microphone permissions, recognition accuracy and performance have not yet been verified on either target. Browser locale chooses the speech language, with English fallback for unsupported locales.
