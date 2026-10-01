// The application always operates against the isolated EB V2 backend.
// VITE_WRITER_DATA_MODE is deliberately ignored; a simulated runtime is gone.
export const isShellMode = false

// This is a shared internal application. Authentication and role-based access
// are intentionally not part of its runtime or deployment configuration.
export const isAuthDisabled = true

export const shellUser = {
  id: "shell-designer",
  email: "designer@local",
  role: "admin" as const,
}
