"use client";

import Runner from "@/components/Runner";

/** §7 step 1 in isolation: keyboard only, for tuning game feel. */
export default function Play() {
  return <Runner seed={1} hudNote="← → lanes · ↑ jump · ↓ duck" />;
}
