/**
 * Renders the form in a fake browser (jsdom) with a fake `fetch`,
 * then types, submits, and checks what the user would see.
 */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AddEndpointForm } from "./AddEndpointForm";

afterEach(() => {
  cleanup(); // remove the rendered form between tests
  vi.unstubAllGlobals(); // put the real fetch back
});

/** Make `fetch` answer with this status and JSON body. */
function fakeFetch(status: number, body: unknown) {
  const fetchMock = vi.fn(async () => new Response(JSON.stringify(body), { status }));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function fillAndSubmit(name: string, url: string) {
  fireEvent.change(screen.getByLabelText("Name"), { target: { value: name } });
  fireEvent.change(screen.getByLabelText("URL"), { target: { value: url } });
  fireEvent.click(screen.getByRole("button", { name: "Add website" }));
}

describe("AddEndpointForm", () => {
  it("sends the website to the API and clears the form", async () => {
    const fetchMock = fakeFetch(201, { id: 1 });
    const onCreated = vi.fn();
    render(<AddEndpointForm onCreated={onCreated} />);

    fillAndSubmit("Payments API", "https://pay.example.com");

    await vi.waitFor(() => expect(onCreated).toHaveBeenCalled());
    const [path, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(path).toBe("/api/endpoints");
    expect(JSON.parse(init.body as string)).toEqual({
      name: "Payments API",
      url: "https://pay.example.com",
      interval_seconds: 60,
    });
    expect(screen.getByLabelText("Name")).toHaveProperty("value", "");
  });

  it("shows the backend's validation messages", async () => {
    fakeFetch(400, {
      error: {
        code: "VALIDATION_ERROR",
        message: "Request body is invalid",
        details: [{ field: "url", message: "must be an http:// or https:// URL" }],
      },
    });
    const onCreated = vi.fn();
    render(<AddEndpointForm onCreated={onCreated} />);

    fillAndSubmit("x", "ftp://nope");

    expect(await screen.findByRole("alert")).toHaveProperty(
      "textContent",
      "url: must be an http:// or https:// URL",
    );
    expect(onCreated).not.toHaveBeenCalled();
  });
});
