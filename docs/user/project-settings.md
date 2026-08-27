# Project settings

## Customize a project icon

T3 Code selects a project icon automatically. It checks `t3.json`, common favicon and app icon
paths, and icon links in project HTML files.

To choose a different icon:

1. Open **Settings** and select **Projects**.
2. Select the project.
3. Under **Appearance**, select **Choose a project file**.
4. Search for an image file and select it.

T3 Code supports SVG, PNG, ICO, JPEG, GIF, AVIF, and WebP files. The selected path applies to
each checkout in the project group and appears on your connected clients.

To use automatic detection again, select **Automatic**.

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
