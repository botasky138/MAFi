// China-direct routing: which hosts qualify, and DoH answers with private or fake-IP addresses are refused.
import assert from "node:assert/strict";
import { test } from "node:test";
import { isCnDirectHost, publicAddressesFrom } from "@aihot/backend/lib/cn-direct";

test("CN-direct host matching", () => {
  for (const h of ["www.pbc.gov.cn", "www.stcn.com", "stcn.com", "www.smpaa.cn", "www.shfe.com.cn", "x.example.cn"]) assert.equal(isCnDirectHost(h), true, h);
  for (const h of ["grok.com", "api2.cursor.sh", "notstcn.com", "cn.example.com", "27.148.154.33"]) assert.equal(isCnDirectHost(h), false, h);
});

test("DoH answers: public A records only", () => {
  assert.deepEqual(publicAddressesFrom([{ type: 5, data: "a.cdn." }, { type: 1, data: "27.148.154.33", TTL: 60 }], "h").addresses, ["27.148.154.33"]);
  assert.throws(() => publicAddressesFrom([{ type: 1, data: "198.18.0.5" }], "h"), /Blocked/);
  assert.throws(() => publicAddressesFrom([{ type: 1, data: "27.148.154.33" }, { type: 1, data: "10.0.0.1" }], "h"), /Blocked/);
  assert.throws(() => publicAddressesFrom([], "h"), /No address/);
});