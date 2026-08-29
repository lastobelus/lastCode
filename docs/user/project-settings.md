# Project settings

Open **Settings → Projects** and select a project to change its preferences.

## Project icons

Choose an icon, emoji, or image from the project to make it easier to recognize. The choice applies
to every checkout in the project group and appears on connected clients. Choose **Automatic** to
let T3 Code detect an icon again.

## Choose the icon shape

Project icons keep the shape of their source image by default. To round their corners in the web
or desktop app, open **Settings → LastCode** and enable **Rounded project icons**. This preference
is saved in the current LastCode profile.

T3 Code Mobile stores the same preference separately on each device. Open
**Settings → Appearance** and enable **Rounded project icons** on every mobile device where you
want rounded corners.

## Let an agent run an Action and resume

Project Actions can hand long-running work back to Codex or Claude when they finish. Edit an
Action, enable **Allow Codex and Claude to run and resume**, and save it. When the agent launches
that Action, it can end its turn while the command runs in a dedicated terminal. LastCode sends one
automated follow-up after the command exits so the agent can continue the original task.

Completed Action output is collapsed by default. The compact card shows the Action name and exit
code on its first line and the command's final output line on its second line. Expand the card to
read the captured output tail; the dedicated terminal remains available as the longer output
artifact.

For a useful compact result, make every resumable Action print one concise summary as its final
output line. Include the result that the agent needs next, such as which checks passed, why a wait
ended, or what requires attention.

To delegate the workflow design and one-time setup, see
[use an agent to add resumable Project Actions](./resumable-project-actions-for-agents.md).

## Keep the default branch current

Enable **Automatically pull** to keep the default-branch checkout up to date with its configured
upstream.

T3 Code only pulls when it can fast-forward and the checkout has no changed files, untracked files,
or local commits. It skips checkouts on another branch or without an upstream. If a checkout has
local work, resolve it yourself before automatic pulls can resume.
