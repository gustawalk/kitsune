import { expect, test } from "bun:test";
import { renderToString } from "react-dom/server";
import { SchemaDiagram } from "../src/components/SchemaDiagram";
import {
  moveDiagramGesture,
  finishDiagramGesture,
  type DiagramGesture,
  zoomDiagramAtPoint,
} from "../src/lib/diagram-gesture";
function gesture(nodeId: string | undefined = "orders"): DiagramGesture {
  return {
    pointerId: 7,
    startX: 100,
    startY: 200,
    originX: 40,
    originY: 60,
    zoom: 0.5,
    nodeId,
    moved: false,
  };
}
test("one click selects a card, allowing normal pointer jitter", () => {
  const state = gesture();
  expect(moveDiagramGesture(state, 7, 102, 201)).toBeNull();
  expect(finishDiagramGesture(state, 7)).toBe("orders");
});
test("drag uses the starting position and zoom, and never turns into a selection", () => {
  const state = gesture();
  expect(moveDiagramGesture(state, 7, 110, 220)).toEqual({ x: 60, y: 100 });
  expect(moveDiagramGesture(state, 7, 120, 230)).toEqual({ x: 80, y: 120 });
  expect(moveDiagramGesture(state, 7, 100, 200)).toEqual({ x: 40, y: 60 });
  expect(finishDiagramGesture(state, 7)).toBeUndefined();
});
test("background pan uses screen coordinates; unrelated and cancelled pointers cannot select", () => {
  const background = gesture(undefined);
  background.nodeId = undefined;
  expect(moveDiagramGesture(background, 7, 110, 220)).toEqual({ x: 50, y: 80 });
  const card = gesture();
  expect(moveDiagramGesture(card, 9, 500, 600)).toBeNull();
  expect(finishDiagramGesture(card, 9)).toBeUndefined();
  expect(finishDiagramGesture(card, 7, true)).toBeUndefined();
});
test("cursor anchored zoom keeps the database point under the pointer fixed", () => {
  const initial = { zoom: 0.5, pan: { x: 40, y: 60 } };
  const cursor = { x: 180, y: 240 };
  const before = {
    x: (cursor.x - initial.pan.x) / initial.zoom,
    y: (cursor.y - initial.pan.y) / initial.zoom,
  };
  const next = zoomDiagramAtPoint(initial.zoom, initial.pan, cursor, -120);
  expect(next.zoom).toBeGreaterThan(initial.zoom);
  expect((cursor.x - next.pan.x) / next.zoom).toBeCloseTo(before.x);
  expect((cursor.y - next.pan.y) / next.zoom).toBeCloseTo(before.y);
  expect(zoomDiagramAtPoint(1.8, { x: 0, y: 0 }, cursor, -10000).zoom).toBe(
    1.8,
  );
});
test("schema edges use the viewport and keyboard selection remains accessible", () => {
  const table = { schema: "", name: "orders", kind: "table" };
  const html = renderToString(
    <SchemaDiagram
      graph={{
        nodes: [
          {
            id: JSON.stringify(["", "orders"]),
            table,
            external: true,
            x: 0,
            y: 0,
            width: 255,
            height: 98,
          },
        ],
        edges: [],
        omittedRelationships: 0,
      }}
      selected={table}
      onSelect={() => undefined}
    />,
  );
  expect(html).toContain('width="100%" height="100%"');
  expect(html).not.toContain('width="10000"');
  expect(html).toContain('aria-pressed="true"');
  expect(html).toContain("data-schema-node=");
});
