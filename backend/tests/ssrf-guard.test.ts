import { describe, expect, it } from "vitest";
import { isBlockedAddress } from "../src/checks/ssrf-guard.js";

describe("isBlockedAddress", () => {
  it.each([
    "127.0.0.1", // this machine
    "10.1.2.3", // private
    "172.16.0.1", // private
    "192.168.1.1", // home network
    "169.254.169.254", // cloud metadata service
    "0.0.0.0",
    "::1", // IPv6 localhost
    "fe80::1", // IPv6 link-local
    "fd00::1", // IPv6 private
    "::ffff:127.0.0.1", // 127.0.0.1 disguised as IPv6
    "not-an-ip",
  ])("blocks %s", (ip) => {
    expect(isBlockedAddress(ip)).toBe(true);
  });

  it.each(["8.8.8.8", "93.184.215.14", "2606:4700:4700::1111"])("allows public address %s", (ip) => {
    expect(isBlockedAddress(ip)).toBe(false);
  });
});
