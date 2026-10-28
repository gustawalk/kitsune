let finishActiveResize: (() => void) | undefined;

export function startResize(
  event: Pick<PointerEvent, "button" | "preventDefault">,
  move: (event: PointerEvent) => void,
) {
  if (event.button !== 0) return;
  finishActiveResize?.();
  event.preventDefault();
  window.getSelection()?.removeAllRanges();
  const root = document.documentElement;
  root.classList.add("is-resizing");
  const preventSelection = (event: Event) => event.preventDefault();
  const onMove = (event: PointerEvent) => {
    event.preventDefault();
    move(event);
  };
  const finish = () => {
    root.classList.remove("is-resizing");
    window.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerup", finish);
    window.removeEventListener("pointercancel", finish);
    window.removeEventListener("blur", finish);
    document.removeEventListener("selectstart", preventSelection);
    if (finishActiveResize === finish) finishActiveResize = undefined;
  };
  finishActiveResize = finish;
  window.addEventListener("pointermove", onMove, { passive: false });
  window.addEventListener("pointerup", finish);
  window.addEventListener("pointercancel", finish);
  window.addEventListener("blur", finish);
  document.addEventListener("selectstart", preventSelection);
  return finish;
}
