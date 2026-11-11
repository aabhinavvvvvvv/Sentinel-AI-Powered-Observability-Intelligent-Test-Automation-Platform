/**
 * Tests checkEndpoint against a tiny fake website running on this computer.
 * Because the fake site is on localhost (an "inside" address), most tests pass
 * allowPrivateAddresses: true. The SSRF tests leave it off on purpose.
 */
import { createServer, type Server } from "node:http";
import { createServer as createNetServer, type AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { checkEndpoint, type CheckTarget } from "../src/checks/check-endpoint.js";

let server: Server;
let baseUrl: string;

beforeAll(async () => {
  server = createServer((req, res) => {
    if (req.url === "/ok") return res.writeHead(200).end("fine");
    if (req.url === "/broken") return res.writeHead(500).end("oops");
    if (req.url === "/redirect") return res.writeHead(301, { location: "http://127.0.0.1:1/" }).end();
    if (req.url === "/slow") return setTimeout(() => res.writeHead(200).end(), 2000);
    res.writeHead(404).end();
  });
  // Port 0 = "pick any free port".
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => {
  server.closeAllConnections();
  server.close();
});

const target = (path: string, extra: Partial<CheckTarget> = {}): CheckTarget => ({
  url: baseUrl + path,
  method: "GET",
  timeout_ms: 1000,
  expected_status: 200,
  ...extra,
});
const local = { allowPrivateAddresses: true };

describe("checkEndpoint (fake website)", () => {
  it("reports a healthy endpoint as ok", async () => {
    const result = await checkEndpoint(target("/ok"), local);
    expect(result).toMatchObject({ ok: true, status_code: 200, error_type: null });
    expect(result.response_time_ms).toBeGreaterThanOrEqual(0);
    expect(result.checked_at).toBeInstanceOf(Date);
  });

  it("names a wrong status by its kind: 5xx server_error, 4xx client_error, 3xx redirect", async () => {
    expect(await checkEndpoint(target("/broken"), local)).toMatchObject({ status_code: 500, error_type: "server_error" });
    expect(await checkEndpoint(target("/missing"), local)).toMatchObject({ status_code: 404, error_type: "client_error" });
    const redirect = await checkEndpoint(target("/redirect"), local);
    expect(redirect).toMatchObject({ ok: false, status_code: 301, error_type: "redirect" });
    expect(redirect.error_message).toBe("Expected status 200, got 301 → http://127.0.0.1:1/"); // says where it points
  });

  it("reports unexpected_status for a success that wasn't expected (200 when 404 was)", async () => {
    const result = await checkEndpoint(target("/ok", { expected_status: 404 }), local);
    expect(result).toMatchObject({ ok: false, status_code: 200, error_type: "unexpected_status" });
  });

  it("reports connection_reset when the server hangs up mid-request", async () => {
    // A raw TCP server that reads the request, then slams the connection shut (a "reset").
    const rude = createNetServer((socket) => socket.on("data", () => socket.resetAndDestroy()));
    await new Promise<void>((resolve) => rude.listen(0, "127.0.0.1", resolve));
    const port = (rude.address() as AddressInfo).port;
    const result = await checkEndpoint({ ...target(""), url: `http://127.0.0.1:${port}/` }, local);
    rude.close();
    expect(result).toMatchObject({ ok: false, status_code: null, error_type: "connection_reset" });
  });

  it("is ok when the status matches expected_status, even if it is not 200", async () => {
    const result = await checkEndpoint(target("/broken", { expected_status: 500 }), local);
    expect(result.ok).toBe(true);
  });

  it("supports HEAD requests", async () => {
    const result = await checkEndpoint(target("/ok", { method: "HEAD" }), local);
    expect(result).toMatchObject({ ok: true, status_code: 200 });
  });

  it("does not follow redirects; it reports the redirect status itself", async () => {
    const result = await checkEndpoint(target("/redirect"), local);
    expect(result.status_code).toBe(301);
  });

  it("gives up after timeout_ms", async () => {
    const result = await checkEndpoint(target("/slow", { timeout_ms: 200 }), local);
    expect(result).toMatchObject({ ok: false, status_code: null, error_type: "timeout" });
    expect(result.response_time_ms).toBeLessThan(1500);
  });

  it("reports connection_refused when nothing is listening", async () => {
    // Open a server on a free port, then close it: now nothing listens on that port.
    // (We can't just use port 1: fetch refuses some ports on purpose and reports "bad port".)
    const temp = createServer();
    await new Promise<void>((resolve) => temp.listen(0, "127.0.0.1", resolve));
    const freePort = (temp.address() as AddressInfo).port;
    await new Promise((resolve) => temp.close(resolve));

    const result = await checkEndpoint({ ...target(""), url: `http://127.0.0.1:${freePort}/` }, local);
    expect(result.error_type).toBe("connection_refused");
  });

  it("reports dns when the website name does not exist", async () => {
    // ".invalid" is reserved: it is guaranteed never to exist.
    const result = await checkEndpoint({ ...target(""), url: "http://no-such-site.invalid/" }, local);
    expect(result.error_type).toBe("dns");
  });
});

describe("checkEndpoint SSRF guard (default settings)", () => {
  it("blocks an inside IP typed directly in the URL", async () => {
    const result = await checkEndpoint(target("/ok"));
    expect(result).toMatchObject({ ok: false, error_type: "blocked", status_code: null });
  });

  it("blocks a name that resolves to an inside address (localhost)", async () => {
    const result = await checkEndpoint({ ...target("/ok"), url: baseUrl.replace("127.0.0.1", "localhost") + "/ok" });
    expect(result).toMatchObject({ ok: false, error_type: "blocked" });
  });

  it("blocks IPv6 localhost", async () => {
    const result = await checkEndpoint({ ...target(""), url: "http://[::1]:5432/" });
    expect(result.error_type).toBe("blocked");
  });
});
