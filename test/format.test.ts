import assert from "node:assert/strict";
import test from "node:test";
import { shortVersion } from "../src/lib/format.ts";

const releases = { "v2.1.2": "1dea7a088142f54c80c41fd3ba3d617ca408bf18" };

test("a stable build of a release's own commit reads as the release", () => {
  assert.equal(shortVersion("v2.1.2-stable-1dea7a08", releases), "v2.1.2");
  assert.equal(shortVersion("v2.1.2-stable-1DEA7A08", releases), "v2.1.2");
});

test("any other build keeps its full version", () => {
  assert.equal(shortVersion("v2.1.2-stable-deadbeef", releases), "v2.1.2-stable-deadbeef");
  assert.equal(shortVersion("v2.1.3-stable-1dea7a08", releases), "v2.1.3-stable-1dea7a08");
  assert.equal(shortVersion("v2.1.2-unstable-1dea7a08", releases), "v2.1.2-unstable-1dea7a08");
  assert.equal(shortVersion("v2.1.2-stable", releases), "v2.1.2-stable");
  assert.equal(shortVersion("v2.1.2-stable-1dea7a08", {}), "v2.1.2-stable-1dea7a08");
});
