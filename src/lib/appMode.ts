/**
 * Shell mode is deliberately the default while Writer Studio's next data model
 * is being designed. It must not make a request to Railway or Supabase.
 *
 * Set VITE_WRITER_DATA_MODE=connected only after the V2 data adapter exists.
 */
export const isShellMode = import.meta.env.VITE_WRITER_DATA_MODE !== "connected"

// V2 is temporarily operated as a shared internal tool. Set this to
// "required" before exposing it beyond the trusted team.
export const isAuthDisabled = import.meta.env.VITE_WRITER_AUTH_MODE !== "required"

export const shellUser = {
  id: "shell-designer",
  email: "designer@local",
  role: "admin" as const,
}
