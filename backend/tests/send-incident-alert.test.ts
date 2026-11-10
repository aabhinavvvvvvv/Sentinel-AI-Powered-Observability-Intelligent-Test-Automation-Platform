import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { Email, Mailer } from "../src/alerts/mailer.js";
import { sendIncidentAlert } from "../src/alerts/send-incident-alert.js";
import { createDatabase } from "../src/db.js";
import { createEndpoint } from "../src/endpoints/repository.js";
import { CreateEndpointSchema } from "../src/endpoints/schemas.js";
import { openIncident } from "../src/incidents/repository.js";
import { resetDb, silentLogger } from "./helpers.js";

const db = createDatabase(process.env.TEST_DATABASE_URL!, silentLogger);

/** A fake mailer that only remembers what it was asked to send. */
function fakeMailer(fail = false): Mailer & { sent: Email[] } {
  const sent: Email[] = [];
  return {
    sent,
    async send(email) {
      if (fail) throw new Error("SMTP server unavailable");
      sent.push(email);
    },
    close() {},
  };
}

beforeEach(() => resetDb(db));
afterAll(() => db.close());

async function makeIncident() {
  const endpoint = await createEndpoint(
    db,
    CreateEndpointSchema.parse({ name: "Payments API", url: "https://pay.example.com" }),
  );
  return (await openIncident(db, {
    endpoint_id: endpoint.id,
    started_at: new Date(),
    error_type: "timeout",
    error_message: null,
  }))!;
}

describe("sendIncidentAlert", () => {
  it("emails every recipient about the incident", async () => {
    const incident = await makeIncident();
    const mailer = fakeMailer();
    const sent = await sendIncidentAlert(db, mailer, ["a@example.com", "b@example.com"], {
      incidentId: incident.id,
      kind: "opened",
    });

    expect(sent).toBe(true);
    expect(mailer.sent).toHaveLength(1);
    expect(mailer.sent[0]).toMatchObject({ to: ["a@example.com", "b@example.com"], subject: "🔴 DOWN: Payments API" });
  });

  it("skips (no email) if the incident no longer exists", async () => {
    const mailer = fakeMailer();
    expect(await sendIncidentAlert(db, mailer, ["a@example.com"], { incidentId: 999, kind: "opened" })).toBe(false);
    expect(mailer.sent).toHaveLength(0);
  });

  it("throws when sending fails, so BullMQ will retry", async () => {
    const incident = await makeIncident();
    await expect(
      sendIncidentAlert(db, fakeMailer(true), ["a@example.com"], { incidentId: incident.id, kind: "opened" }),
    ).rejects.toThrow("SMTP server unavailable");
  });
});
