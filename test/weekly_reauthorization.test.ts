import assert from "node:assert/strict";
import test from "node:test";
import { createWeeklyReauthorizationEnsurer } from "../src/weekly_reauthorization.ts";

test("weekly reauthorization opens one interactive login and rechecks before continuing", async () => {
  let authorized = false;
  let interactiveLogins = 0;
  let requiredEvents = 0;
  let completedEvents = 0;
  const ensure = createWeeklyReauthorizationEnsurer({
    requireWeeklyReauthorization: async () => {
      if (!authorized) throw new Error("AUTH_WEEKLY_REAUTH_REQUIRED");
    },
    reauthorizeInteractively: async () => {
      interactiveLogins += 1;
      authorized = true;
    },
    onReauthorizationRequired: () => { requiredEvents += 1; },
    onReauthorized: () => { completedEvents += 1; },
  });

  await ensure();

  assert.equal(interactiveLogins, 1);
  assert.equal(requiredEvents, 1);
  assert.equal(completedEvents, 1);
});

test("concurrent weekly reauthorization checks share the same interactive login", async () => {
  let authorized = false;
  let interactiveLogins = 0;
  let releaseLogin: (() => void) | undefined;
  const loginStarted = new Promise<void>((resolve) => { releaseLogin = resolve; });
  const ensure = createWeeklyReauthorizationEnsurer({
    requireWeeklyReauthorization: async () => {
      if (!authorized) throw new Error("AUTH_WEEKLY_REAUTH_REQUIRED");
    },
    reauthorizeInteractively: async () => {
      interactiveLogins += 1;
      await loginStarted;
      authorized = true;
    },
  });

  const first = ensure();
  const second = ensure();
  await Promise.resolve();
  assert.equal(interactiveLogins, 1);
  releaseLogin?.();
  await Promise.all([first, second]);
});
