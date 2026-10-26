export interface DiagramGesture {
  pointerId: number;
  startX: number;
  startY: number;
  originX: number;
  originY: number;
  zoom: number;
  nodeId?: string;
  moved: boolean;
}
export function moveDiagramGesture(
  gesture: DiagramGesture,
  pointerId: number,
  x: number,
  y: number,
) {
  if (pointerId !== gesture.pointerId) return null;
  const dx = x - gesture.startX,
    dy = y - gesture.startY;
  const moved = gesture.moved || Math.hypot(dx, dy) >= 4;
  gesture.moved = moved;
  if (!moved) return null;
  const scale = gesture.nodeId ? gesture.zoom : 1;
  return { x: gesture.originX + dx / scale, y: gesture.originY + dy / scale };
}
export function finishDiagramGesture(
  gesture: DiagramGesture,
  pointerId: number,
  cancelled = false,
): string | undefined {
  return pointerId === gesture.pointerId && !gesture.moved && !cancelled
    ? gesture.nodeId
    : undefined;
}
