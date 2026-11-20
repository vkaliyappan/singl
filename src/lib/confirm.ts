/**
 * Native yes/no dialog. Use instead of `window.confirm`: inside Tauri the
 * dialog plugin replaces it with a Promise-returning version, which is always
 * truthy when used synchronously.
 */
export async function askConfirm(message: string, title = "Confirm"): Promise<boolean> {
  try {
    const { ask } = await import("@tauri-apps/plugin-dialog")
    return await ask(message, { title, kind: "warning" })
  } catch {
    return false
  }
}
