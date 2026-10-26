// Install on document so dialogs and menus rendered through portals are covered.
// Cancel only the browser default; application menus may still handle the event.
export function installDesktopInteractions(document: Document): () => void {
  const contextMenu = (event: Event) => {
    if (
      event.target instanceof Element &&
      event.target.closest("[data-app-context-menu]")
    )
      return;
    event.preventDefault();
  };
  const dragStart = (event: Event) => {
    if (!(event.target instanceof Element)) return;
    // The grid uses native HTML drag events deliberately for column reordering.
    if (event.target.closest('[draggable="true"]')) return;
    if (event.target.closest("img, a")) event.preventDefault();
  };
  document.addEventListener("contextmenu", contextMenu, true);
  document.addEventListener("dragstart", dragStart, true);
  return () => {
    document.removeEventListener("contextmenu", contextMenu, true);
    document.removeEventListener("dragstart", dragStart, true);
  };
}
