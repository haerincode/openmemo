import { formatInTimeZone } from "date-fns-tz";

/**
 * If the LLM produced an ISO with Z or +00:00 but the owner is not in UTC,
 * the wall-clock the user said was almost certainly local. Reinterpret it.
 *
 * Example: owner in America/Santiago (UTC-4), LLM emitted "2026-05-17T04:00:00Z".
 * The user meant 04:00 local, not 00:00 local. We rebuild the ISO as
 * "2026-05-17T04:00:00-04:00".
 */
export function reinterpretUtcAsLocal(iso: string, timezone: string): string {
  if (timezone === "UTC" || timezone === "Etc/UTC") return iso;
  const m = iso.match(
    /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?)(?:Z|\+00:00|-00:00)$/,
  );
  if (!m) return iso;
  const wall = m[1];
  const offset = formatInTimeZone(new Date(`${wall}Z`), timezone, "xxx");
  if (offset === "Z" || offset === "+00:00") return iso;
  return `${wall}${offset}`;
}
