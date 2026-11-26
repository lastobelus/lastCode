---
area: thread-organization
title: Keeping many threads manageable
tier: prefer-ours
paths:
  - apps/web/src/components/lastcodeSidebarFamilies.logic.ts
  - apps/web/src/components/sidebar/
  - apps/web/src/components/Sidebar.tsx
  - apps/web/src/components/Sidebar.logic.ts
  - apps/web/src/components/thread-annotation/
  - apps/server/src/orchestration-v2/LastCodeAnnotationHideTriggers.ts
  - apps/server/src/orchestration-v2/LastCodeArchivePlanner.ts
  - apps/server/src/orchestration-v2/LastCodePeerArchiveDispatch.ts
  - apps/server/src/orchestration-v2/LastCodePeerArchiveDestination.ts
  - apps/server/src/orchestration-v2/LastCodeLinkedArchiveOperations.ts
  - apps/server/src/orchestration-v2/ThreadManagementService.ts
  - apps/web/src/hooks/lastcodeThreadArchiveActions.ts
  - apps/web/src/hooks/useThreadActions.ts
  - apps/web/src/components/ThreadArchiveDialog.tsx
  - packages/client-runtime/src/state/threadArchive.ts
  - apps/mobile/src/features/home/lastcodeThreadArchiveActions.ts
  - docs/user/thread-sidebar.md
---

# Keeping many threads manageable

## Purpose

The owner runs dozens of threads at once, many of them started by agents. This area keeps that list readable: related threads sit together as families, a thread can carry a note and step aside until something happens, and a finished family leaves in one step without stranding its children or its work on other machines.

## Intents

### Sidebar families and conveniences

- Threads that belong together show as one family: a parent with its children nested to any depth, with the family's status and child count visible at the parent.
- Agents can group threads under a group thread and undo the move. Moving changes only where a thread sits, never its owner or its running work.
- The LastCode sidebar, with its project tree, annotations and family controls, stays available as a setting, and switching between it and upstream's sidebar loses nothing.

### Pin, snooze and settle

- No intents of their own. Upstream's pin, snooze, settle, automatic settlement and drag gestures are the behaviour. LastCode changes here follow lean upstream.

### Thread annotations

- A thread has one current Markdown note that can be read, edited and resolved from the sidebar and from inside the thread. Resolved notes keep their place in the conversation.
- A note can hide its thread, and the threads it owns, until a date, a merged pull request, another thread's archive or a newer installed checkpoint. A thread that needs an answer or approval never stays hidden, and a revealed thread says why it came back.

### Archiving thread families

- Archiving a parent archives its family, and says first which members are still working, waiting for an answer or unread.
- Family members on other linked environments are archived too. If one can't be reached, the family stays listed with a way to retry, and nothing is lost.
- Undo or restoring brings the whole family back, on web, desktop and mobile.
