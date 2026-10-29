// China-direct routing: which hosts qualify, and DoH answers with private or fake-IP addresses are refused.
import assert from "node:assert/strict";
import { test } from "node:test";
import { isCnDirectHost, isStaleLocalAddressError, pickLocalAddress, publicAddressesFrom } from "@aihot/backend/lib/cn-direct";

test("CN-direct host matching", () => {
  for (const h of ["www.pbc.gov.cn", "www.stcn.com", "stcn.com", "www.smpaa.cn", "www.shfe.com.cn", "www.cnpharm.com", "x.example.cn"]) assert.equal(isCnDirectHost(h), true, h);
  for (const h of ["grok.com", "api2.cursor.sh", "notstcn.com", "notcnpharm.com", "cn.example.com", "27.148.154.33"]) assert.equal(isCnDirectHost(h), false, h);
});

test("DoH answers: public A records only", () => {
  assert.deepEqual(publicAddressesFrom([{ type: 5, data: "a.cdn." }, { type: 1, data: "27.148.154.33", TTL: 60 }], "h").addresses, ["27.148.154.33"]);
  assert.throws(() => publicAddressesFrom([{ type: 1, data: "198.18.0.5" }], "h"), /Blocked/);
  assert.throws(() => publicAddressesFrom([{ type: 1, data: "27.148.154.33" }, { type: 1, data: "10.0.0.1" }], "h"), /Blocked/);
  assert.throws(() => publicAddressesFrom([], "h"), /No address/);
});
const v4 = (address: string, internal = false) => ({ address, family: "IPv4", internal });

test("auto local address: physical Wi-Fi, skipping virtual, TUN, link-local and fake-IP", () => {
  const ifaces = {
    "vEthernet (WSL (Hyper-V firewall))": [v4("172.21.80.1")],
    "WLAN 5": [v4("169.254.153.162")],
    "以太网": [v4("169.254.32.8")],
    "FlClash": [v4("198.18.0.1")],
    "WLAN": [{ address: "fe80::1", family: "IPv6", internal: false }, v4("192.168.71.47")],
    "Tailscale": [v4("100.64.0.2")],
    "Meta": [v4("198.19.0.1")],
    "Loopback Pseudo-Interface 1": [v4("127.0.0.1", true)],
    "VMware Network Adapter VMnet8": [v4("192.168.200.1")],
  };
  assert.deepEqual(pickLocalAddress(ifaces), { name: "WLAN", address: "192.168.71.47" });
});

test("auto local address: Wi-Fi over Ethernet, Ethernet over other, null when nothing usable", () => {
  assert.equal(pickLocalAddress({ "以太网": [v4("10.0.0.5")], "Wi-Fi": [v4("192.168.1.9")] })?.address, "192.168.1.9");
  assert.equal(pickLocalAddress({ "无线网络连接": [v4("192.168.3.3")], "Ethernet": [v4("10.0.0.5")] })?.address, "192.168.3.3");
  assert.equal(pickLocalAddress({ "Some NIC": [v4("10.1.1.1")], "Ethernet 2": [v4("10.0.0.5")] })?.address, "10.0.0.5");
  assert.equal(pickLocalAddress({ "Wintun": [v4("10.8.0.2")], "docker0": [v4("172.17.0.1")], "WLAN": [v4("169.254.1.1")] }), null);
});

test("stale local address errors", () => {
  assert.equal(isStaleLocalAddressError(Object.assign(new TypeError("fetch failed"), { cause: { code: "EADDRNOTAVAIL" } })), true);
  assert.equal(isStaleLocalAddressError({ code: "ECONNRESET" }), false);
});
