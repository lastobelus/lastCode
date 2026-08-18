# Organizing threads

Pin a thread from its context menu to keep it in the pinned section above your active work.
Pinned threads are shown independently of their project, including when you connect to more than
one environment.

Pinned threads still move to **Settled** when they become inactive. They also move when their pull
request merges if **Auto-settle merged threads** is enabled.

When you un-settle a thread, it returns to the top of the active list so you can find it right
away. Its timestamps do not change. Other threads keep their positions.

Right-click a pull request link in a thread and choose **Link to thread** to show that pull request
in the sidebar. The thread settles when the linked pull request merges if **Auto-settle merged
threads** is enabled. Right-click the same link and choose **Unlink from thread** to remove it.

On web and desktop, drag a pinned thread to change its position. On mobile, open the thread's menu
and choose **Move up** or **Move down**. The order is stored by the server and appears on your
other connected devices.

If reordering is unavailable for one environment, update the T3 Code server running in that
environment. Older servers can still pin and unpin threads, but do not understand synced ordering;
their pinned threads keep the default newest-first order below the ones you have arranged.

## Environment artwork

Dev and Nightly environments can identify themselves with artwork at the top of the sidebar and in
the send button. Choose **Artwork**, **Version pill**, or **None** in Settings under environment
identification. Artwork is recolored to match each built-in theme. Custom themes use the **Version
pill** fallback because their colors are not controlled by T3 Code.

To generate a fresh title from the conversation, open a thread's context menu and choose
**Regenerate title**. While T3 Code is generating it, the action reads **Regenerating…** and cannot
be selected again. The option is hidden when the connected environment needs a server update.

## Legacy sidebar scale in LastCode

When the legacy sidebar is enabled, LastCode can make its project and thread rows more compact.
Open **Settings -> LastCode** and adjust **Scale legacy sidebar** from 50% through 100%. The 75%
mark is labeled as a useful compact reference point. The default is 100%, and your selection is
stored locally and retained when LastCode restarts.

This setting compacts project headings and thread rows while keeping project favicons and action
or status icons at their standard size. The LastCode header, Search field, Projects heading,
drafts, status notices, and footer also stay at their standard size. On desktop, **View -> Actual
Size**, **Zoom In**, and **Zoom Out** continue to zoom the whole application and compose with the
legacy sidebar scale.
