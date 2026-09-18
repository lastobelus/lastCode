# LastCode appearance preferences

## Make scrollbars easier to grab

Open **Settings → LastCode → Appearance** and enable **Larger scrollbars**. Two controls appear:

- **Scrollbar width** sets the visible thumb from 1 px through 12 px in one-pixel increments.
- **Scrollbar margin** adds 0 px through 6 px of clear space between the thumb and the pane edge.

The default larger-scrollbar profile uses a 10 px thumb and a 4 px margin. That margin keeps the
thumb clear of the resize handle between adjacent panes. Changes apply immediately to native app
scrollbars, styled scroll areas, and terminal scrollback, and are stored in the current LastCode
profile. Turning the setting off restores the standard scrollbar appearance without discarding the
chosen width and margin.

LastCode desktop and Chromium-based web browsers apply the exact pixel values to native
scrollbars. Firefox exposes only system scrollbar sizes: enabling the setting selects its larger
system scrollbar, while the width and margin sliders continue to apply exactly to LastCode's
styled scroll areas.
