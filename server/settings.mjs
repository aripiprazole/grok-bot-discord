// Reading plugin variables from the environment.

// Unset plugin variables may arrive empty or as the literal "${NAME}" placeholder.
export function setting(value) {
  const v = value?.trim();
  return !v || /^\$\{.*\}$/.test(v) ? undefined : v;
}

export const list = (value) =>
  (setting(value) ?? "")
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter(Boolean);
