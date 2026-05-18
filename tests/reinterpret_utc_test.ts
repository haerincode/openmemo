/**
 * OpenMemo - reinterpretUtcAsLocal unit test.
 *
 * Guards the timezone bug fix: when the LLM emits an ISO with Z or +00:00 but
 * the user is not in UTC, the wall-clock the user said was almost certainly
 * local. Verify the rebuild stamps the user's IANA offset, including DST.
 */

import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { reinterpretUtcAsLocal } from "../supabase/functions/_shared/tz.ts";

Deno.test("noop when timezone is UTC", () => {
  assertEquals(
    reinterpretUtcAsLocal("2026-05-17T04:00:00Z", "UTC"),
    "2026-05-17T04:00:00Z",
  );
  assertEquals(
    reinterpretUtcAsLocal("2026-05-17T04:00:00Z", "Etc/UTC"),
    "2026-05-17T04:00:00Z",
  );
});

Deno.test("noop when ISO already has a non-UTC offset", () => {
  assertEquals(
    reinterpretUtcAsLocal("2026-05-17T20:00:00-04:00", "America/Santiago"),
    "2026-05-17T20:00:00-04:00",
  );
  assertEquals(
    reinterpretUtcAsLocal("2026-05-17T20:00:00+02:00", "Europe/Madrid"),
    "2026-05-17T20:00:00+02:00",
  );
});

Deno.test("Santiago Z reinterpreted to local offset", () => {
  // Santiago is UTC-4 standard, UTC-3 DST. May 17 2026 has no DST -> -04:00.
  assertEquals(
    reinterpretUtcAsLocal("2026-05-17T20:00:00Z", "America/Santiago"),
    "2026-05-17T20:00:00-04:00",
  );
});

Deno.test("Madrid Z reinterpreted respecting DST", () => {
  assertEquals(
    reinterpretUtcAsLocal("2026-07-15T09:00:00Z", "Europe/Madrid"),
    "2026-07-15T09:00:00+02:00",
  );
  assertEquals(
    reinterpretUtcAsLocal("2026-01-15T09:00:00Z", "Europe/Madrid"),
    "2026-01-15T09:00:00+01:00",
  );
});

Deno.test("Tokyo Z reinterpreted to +09:00 year-round", () => {
  assertEquals(
    reinterpretUtcAsLocal("2026-03-01T08:00:00Z", "Asia/Tokyo"),
    "2026-03-01T08:00:00+09:00",
  );
  assertEquals(
    reinterpretUtcAsLocal("2026-08-01T08:00:00Z", "Asia/Tokyo"),
    "2026-08-01T08:00:00+09:00",
  );
});

Deno.test("+00:00 suffix is treated like Z", () => {
  assertEquals(
    reinterpretUtcAsLocal("2026-05-17T20:00:00+00:00", "America/Santiago"),
    "2026-05-17T20:00:00-04:00",
  );
  assertEquals(
    reinterpretUtcAsLocal("2026-05-17T20:00:00-00:00", "America/Santiago"),
    "2026-05-17T20:00:00-04:00",
  );
});

Deno.test("ISO with sub-second precision keeps wall clock", () => {
  assertEquals(
    reinterpretUtcAsLocal("2026-05-17T20:00:00.123Z", "America/Santiago"),
    "2026-05-17T20:00:00.123-04:00",
  );
});

Deno.test("malformed ISO is returned as-is", () => {
  assertEquals(
    reinterpretUtcAsLocal("not a date", "America/Santiago"),
    "not a date",
  );
  assertEquals(
    reinterpretUtcAsLocal("2026-05-17", "America/Santiago"),
    "2026-05-17",
  );
});
