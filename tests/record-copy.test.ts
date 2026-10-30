import { expect, test } from "bun:test";
import {
  copyFieldText,
  copyRecordJson,
  copyRowsJson,
  jsonSelectionRows,
} from "../src/lib/record-copy";
import type { DbValue, ResultSet } from "../src/lib/types";

test("inspector copies complete stored fields without losing precision", () => {
  const fields: DbValue[] = [
    { kind: "text", value: "long".repeat(10000) },
    { kind: "integer", value: "9007199254740993" },
    { kind: "decimal", value: "123.450000" },
    { kind: "boolean", value: false },
    { kind: "null" },
    { kind: "json", value: '{"nested":[1,true]}' },
    { kind: "binary", value: "AAE=" },
  ];
  expect(fields.map(copyFieldText)).toEqual([
    "long".repeat(10000),
    "9007199254740993",
    "123.450000",
    "false",
    "NULL",
    '{"nested":[1,true]}',
    "AAE=",
  ]);
  const result = {
    columns: fields.map((_, i) => `field${i}`),
    rows: [fields],
  } as ResultSet;
  expect(JSON.parse(copyRecordJson(result))).toEqual({
    field0: "long".repeat(10000),
    field1: "9007199254740993",
    field2: "123.450000",
    field3: false,
    field4: null,
    field5: '{"nested":[1,true]}',
    field6: "AAE=",
  });
  expect(() => copyRecordJson({ ...result, rows: [] })).toThrow(
    "no longer exists",
  );
});

test("multi-row JSON copies ordinary records in displayed order without losing values", () => {
  const result = {
    columns: ["id", "active", "note", "payload"],
    rows: [
      [
        { kind: "integer", value: "9007199254740993" },
        { kind: "boolean", value: false },
        { kind: "null" },
        { kind: "json", value: '{"a":1}' },
      ],
      [
        { kind: "integer", value: "2" },
        { kind: "boolean", value: true },
        { kind: "text", value: "" },
        { kind: "text", value: "long".repeat(1000) },
      ],
    ],
  } as ResultSet;
  const rows = JSON.parse(copyRowsJson(result, [1, 0, 1]));
  expect(rows).toEqual([
    { id: "9007199254740993", active: false, note: null, payload: '{"a":1}' },
    { id: "2", active: true, note: "", payload: "long".repeat(1000) },
  ]);
  expect(JSON.parse(copyRowsJson(result, [1]))).toEqual(rows[1]);
  expect(() => copyRowsJson(result, [])).toThrow("Select at least one");
  expect(() => copyRowsJson(result, [5])).toThrow("no longer available");
});
test("JSON export preserves duplicate SQL result column names without dropping data", () => {
  const result = {
    columns: ["id", "id"],
    rows: [
      [
        { kind: "integer", value: "1" },
        { kind: "integer", value: "2" },
      ],
      [
        { kind: "integer", value: "3" },
        { kind: "integer", value: "4" },
      ],
    ],
  } as ResultSet;
  expect(JSON.parse(copyRowsJson(result, [0, 1]))).toEqual({
    columns: ["id", "id"],
    rows: [
      ["1", "2"],
      ["3", "4"],
    ],
  });
});
test("JSON selection supports checkbox selections and shift-selected row ranges", () => {
  expect(jsonSelectionRows(10, [7, 2, 7], 0, 0)).toEqual([2, 7]);
  expect(jsonSelectionRows(10, [], 4, 1)).toEqual([1, 2, 3, 4]);
  expect(jsonSelectionRows(3, [], 9, 1)).toEqual([1, 2]);
  expect(jsonSelectionRows(0, [], 0, 0)).toEqual([]);
});
