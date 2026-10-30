import { test } from "node:test";
import assert from "node:assert/strict";
import { tokenNeedsRefresh } from "../src/pb.js";

const jwt = (exp) => "h." + Buffer.from(JSON.stringify({ exp })).toString("base64url") + ".s";

test("tokenNeedsRefresh re-auths before the superuser token expires", () => {
  const now = Date.now();
  assert.equal(tokenNeedsRefresh(jwt(now / 1000 + 86_400), { now }), false);
  assert.equal(tokenNeedsRefresh(jwt(now / 1000 + 600), { now }), true);
  assert.equal(tokenNeedsRefresh(jwt(now / 1000 - 1), { now }), true);
  assert.equal(tokenNeedsRefresh("", { now }), true);
  assert.equal(tokenNeedsRefresh("garbage", { now }), true);
});
