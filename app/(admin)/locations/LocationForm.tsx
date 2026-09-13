"use client";

import { useState, useTransition } from "react";
import { setLocationGeo, type LocationResult } from "@/app/actions/locations";

/**
 * Three boxes and a button.
 *
 * No client-side validation beyond "is it a number": the database
 * refuses a latitude of 72 and returns a sentence explaining why, and
 * having that rule in one place means the API, a script and this form
 * cannot disagree about what a valid coordinate is.
 */
export default function LocationForm({
  code, lat, lng, radius,
}: { code: string; lat: string; lng: string; radius: string }) {
  const [result, setResult] = useState<LocationResult | null>(null);
  const [pending, start] = useTransition();

  return (
    <form
      style={S.form}
      action={(fd) => start(async () => setResult(await setLocationGeo(fd)))}
    >
      <input type="hidden" name="code" value={code} />
      <label style={S.field}>
        <span style={S.label}>Latitude</span>
        <input name="lat" defaultValue={lat} placeholder="19.1136"
               inputMode="decimal" style={S.input} />
      </label>
      <label style={S.field}>
        <span style={S.label}>Longitude</span>
        <input name="lng" defaultValue={lng} placeholder="72.8697"
               inputMode="decimal" style={S.input} />
      </label>
      <label style={S.field}>
        <span style={S.label}>Serves (km)</span>
        <input name="radius_km" defaultValue={radius} placeholder="10"
               inputMode="decimal" style={S.input} />
      </label>

      <button type="submit" style={S.button} disabled={pending}>
        {pending ? "Saving…" : "Save"}
      </button>

      {result && (
        <p style={result.ok ? S.ok : S.bad}>{result.message}</p>
      )}
    </form>
  );
}

const S: Record<string, React.CSSProperties> = {
  form: { display: "flex", gap: 10, alignItems: "flex-end", flexWrap: "wrap",
          marginTop: 12 },
  field: { display: "flex", flexDirection: "column", gap: 4 },
  label: { fontSize: 11, textTransform: "uppercase", letterSpacing: 0.5, color: "#888" },
  input: { padding: "8px 10px", fontSize: 14, border: "1px solid #ddd",
           borderRadius: 8, width: 130, fontFamily: "ui-monospace, monospace" },
  button: { padding: "9px 18px", background: "#0b5fff", color: "white", border: 0,
            borderRadius: 10, fontSize: 14, fontWeight: 600, cursor: "pointer" },
  ok: { color: "#1a7f37", margin: "4px 0 0", flexBasis: "100%" },
  bad: { color: "#8a1c10", margin: "4px 0 0", flexBasis: "100%" },
};
