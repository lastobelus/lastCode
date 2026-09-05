# Browser annotations

Use the browser's annotation picker to select page elements, mark a region, or
draw feedback. Add a comment and attach the annotation to your conversation, or
send it using the annotation editor's send shortcut. The annotation includes the
selected content and a screenshot of the marked area.

Elements inside same-origin iframes are selectable, including embedded `srcdoc`
previews and nested frames. Highlights follow scrolling within the frame and the
surrounding page. Screenshot crops use the element's visible position in the
browser. If a frame navigates or is removed, its old selections are discarded;
select the replacement content to annotate it.
The packaged element context includes the embedded document's URL and the path
through its containing frames, so selectors can be resolved inside the correct
preview, including nested `srcdoc` frames.

Style adjustments inside frames remain temporary and are restored when the
annotation ends. Escape cancels the picker from either the page or a same-origin
frame. Cross-origin frame contents are not supported. Frames with rotation, skew,
mirroring, or perspective cannot be inspected internally; ordinary positioning
and positive scaling are supported.
