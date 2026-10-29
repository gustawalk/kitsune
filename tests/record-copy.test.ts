import { expect, test } from "bun:test";
import { copyFieldText, copyRecordJson } from "../src/lib/record-copy";
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
