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

## Keep the default branch current

Enable **Automatically pull** to keep the default-branch checkout up to date with its configured
upstream.

T3 Code only pulls when it can fast-forward and the checkout has no changed files, untracked files,
or local commits. It skips checkouts on another branch or without an upstream. If a checkout has
local work, resolve it yourself before automatic pulls can resume.
