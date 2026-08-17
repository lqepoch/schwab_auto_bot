import assert from "node:assert/strict";
import test from "node:test";
import { weeklyReauthorizationWeek } from "../src/automation/auth/provider.ts";

test("weekly reauthorization boundary changes at Monday 06:00 Beijing time", () => {
  assert.equal(weeklyReauthorizationWeek(new Date("2026-07-19T21:59:00Z")), "2026-07-13");
  assert.equal(weeklyReauthorizationWeek(new Date("2026-07-19T22:00:00Z")), "2026-07-20");
  assert.equal(weeklyReauthorizationWeek(new Date("2026-07-24T12:00:00Z")), "2026-07-20");
});
