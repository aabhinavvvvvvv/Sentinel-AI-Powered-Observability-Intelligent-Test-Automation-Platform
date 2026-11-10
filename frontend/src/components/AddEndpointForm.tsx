/**
 * Form to add a website. The BACKEND decides what's valid (one source of rules);
 * this form simply shows the backend's error messages if something is wrong.
 */
import { useState, type FormEvent } from "react";
import { api, ApiError } from "../api";

const INTERVALS = [
  { seconds: 30, label: "30 seconds" },
  { seconds: 60, label: "1 minute" },
  { seconds: 300, label: "5 minutes" },
  { seconds: 900, label: "15 minutes" },
  { seconds: 3600, label: "1 hour" },
];

export function AddEndpointForm({ onCreated }: { onCreated: () => void }) {
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [intervalSeconds, setIntervalSeconds] = useState(60);
  const [errors, setErrors] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault(); // stop the browser from reloading the page
    setSaving(true);
    setErrors([]);
    try {
      await api.createEndpoint({ name, url, interval_seconds: intervalSeconds });
      setName("");
      setUrl("");
      onCreated();
    } catch (err) {
      if (err instanceof ApiError && err.details.length > 0) {
        setErrors(err.details.map((d) => `${d.field}: ${d.message}`));
      } else {
        setErrors([err instanceof Error ? err.message : String(err)]);
      }
    } finally {
      setSaving(false);
    }
  }

  return (
    <form className="add-form" onSubmit={submit}>
      <label>
        Name
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Payments API" />
      </label>
      <label>
        URL
        <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://example.com/health" />
      </label>
      <label>
        Check every
        <select value={intervalSeconds} onChange={(e) => setIntervalSeconds(Number(e.target.value))}>
          {INTERVALS.map((i) => (
            <option key={i.seconds} value={i.seconds}>
              {i.label}
            </option>
          ))}
        </select>
      </label>
      <button type="submit" disabled={saving}>
        {saving ? "Adding…" : "Add website"}
      </button>
      {errors.length > 0 && (
        <ul className="error" role="alert">
          {errors.map((message) => (
            <li key={message}>{message}</li>
          ))}
        </ul>
      )}
    </form>
  );
}
