import assert from "node:assert/strict";
import { test } from "node:test";
import { cloudflareAuthResult } from "../services/inbound-cloudflare.js";

test("accepts Cloudflare's first authentication result", () => {
  const result = cloudflareAuthResult("mx.cloudflare.net; spf=pass; dkim=pass header.d=example.test; dmarc=pass");
  assert.equal(result?.spf, "pass"); assert.equal(result?.dkimDomain, "example.test"); assert.equal(result?.dmarc, "pass");
});
test("does not trust sender-supplied results or later duplicate headers", () => {
  assert.equal(cloudflareAuthResult("attacker.test; spf=pass; dkim=pass; dmarc=pass"), null);
  const result = cloudflareAuthResult("mx.cloudflare.net; spf=fail, attacker.test; dkim=pass; dmarc=pass");
  assert.equal(result?.spf, "fail"); assert.equal(result?.dkim, "none"); assert.equal(result?.dmarc, "none");
});
