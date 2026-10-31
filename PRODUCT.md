# Tempo Planner

<!-- impeccable:product-schema 1 -->

## Platform

web

## Stack

Delegated for the first runnable foundation: a dependency-free, installable web app with local-first browser storage. This does not settle the eventual native Android or Windows 11 packaging approach.

## Users

People who benefit from making time visible, capturing thoughts quickly, choosing a next action, and returning to a plan after interruptions. ADHD and neurodivergent people are included in the intended audience; these are design hypotheses, not clinical claims.

## Product Purpose

Tempo is a planner concept for organizing tasks around the day, making focus time easier to begin, and keeping unplanned work out of today's schedule until the user places it there. Success means the person can see a useful next action, capture and sort thoughts without losing the original, and change plans without shame.

## Positioning

Tempo combines a time-sized view of the day with an explicit Later list and capture-first planning. The supplied screen templates depict this mechanism; they do not verify it in use.

## Operating Context

The intended devices are Android and Windows 11. The approved source artifact depicts four 390 × 844 phone screens (Today, Focus, Brain dump, Settings) and two 1280 × 800 desktop screens (Today, Week). The same visual presentation is the binding reference for those six screens. The first runnable foundation is browser based and stores data on the current device.

## Capabilities and Constraints

The initial implementation should make local task creation, capture, editable linked subtasks, ordering, removal, a basic focus timer, on-device voice capture, and reminder preferences useful. Unscheduled work stays in Later unless the user schedules it. A two-minute pre-departure reminder is an adjustable, per-event starting value. Accounts, native notification scheduling, and native Android / Windows packages are open implementation gaps; do not imply that the reference's static sample labels are operational functionality.

## Brand Commitments

Tempo's original supplied HTML is the visual authority. Match its depicted screen structure, color, typography, content treatment, proportions, controls, and states at the stated reference sizes. Do not redesign the six screens. Extend the same visual language for surfaces the artifact does not show.

## Evidence on Hand

- `Tempo Planner - capability inventory and specification.md` is a working specification and capability inventory, not a user-approved final product contract.
- The six reference screen templates are retained as standalone templates in `src/templates/`; their displayed actions do not have application handlers.
- A file-based sync service (`server/sync-server.mjs`) and on-device voice capture exist; accounts, notification scheduling, and native packages were not supplied.

## Product Principles

- Keep the user in control of task selection, scheduling, and rescheduling.
- Preserve the original capture when deriving editable tasks from it.
- Keep unscheduled items out of the day's plan.
- Make focus and reminders optional and adjustable.
- Describe local, sync, and notification status accurately.

## Accessibility & Inclusion

Use the reference's Atkinson Hyperlegible typeface, readable labels, keyboard-operable controls, native form behavior, and screen-reader names. Test practical text scaling and keyboard use. The intended audience is varied; avoid presenting design assumptions as clinical evidence.
