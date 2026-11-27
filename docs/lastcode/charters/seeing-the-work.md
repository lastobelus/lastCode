---
area: seeing-the-work
title: Seeing what agents build
tier: prefer-ours
paths:
  - apps/server/src/preview/
  - apps/server/src/mcp/toolkits/preview/
  - apps/desktop/src/preview/
  - apps/web/src/browser/
  - apps/web/src/components/preview/
  - apps/server/src/device/
  - apps/server/src/mcp/toolkits/device/
  - apps/web/src/components/device/
---

# Seeing what agents build

## Purpose

An agent can check its own work in a real browser or simulator without taking over the user's screen, and leave a prepared preview the user can open whenever they come back. The user can point at what they see and send it back to the agent.

## Intents

### Background browser for agent QA

- An agent's QA runs in its own background tab against isolated state; it never needs a permission prompt, steals focus, or repurposes a tab the user is looking at.
- Automation acts on the page the user would see: clicks, screenshots and popups stay bound to the displayed page, and an ambiguous or timed-out click says why.
- An agent can choose where the browser runs (the environment or a connected desktop) and which profile it uses, and the tool reports the host and profile it actually got.

### Preview hosting and handoff links

- A preview an agent hands off stays usable until the user stops it, or archives or deletes the thread. Idle processes sleep and restart when the link or Browser panel is opened; sleeping is not expiry.
- Previews and documents an agent publishes are hosted by the environment that owns the thread, so the link works from any client, including remote and shared HTTPS access.
- The user can see which processes a thread is keeping alive and stop them.
- A broken preview asks the owning thread to recover it, from whichever client the user is on.
- Links to other threads opened from a preview go to that thread.

### Browser profiles, import and annotations

- Named profiles keep their sign-ins across environments connected to the same desktop; Default and Incognito stay separate per environment.
- The user can select elements, mark regions or draw on a page, including inside same-origin frames, and send that with a screenshot to the conversation.

### Simulator and emulator devices

- Agents use simulators and emulators only when the project allows it, and revoking access stops running agents on their next request.
- A device an agent started is powered off when its thread settles, archives or is deleted, after a period without device commands, or when the server stops. Devices the user started stay on.
