export type SavedClipboardImage =
  | { ok: true; file: { path: string; name: string } }
  | { ok: false; error: string };

/**
 * Persist the clipboard image and attach it, or report why not. A failure must
 * reach the user: the composer has already swallowed the paste event, so a
 * silent return is indistinguishable from "paste did nothing".
 */
export async function pasteClipboardImage(
  save: () => Promise<SavedClipboardImage>,
  attach: (file: { path: string; name: string }) => void,
  fail: (error: string) => void
): Promise<void> {
  let res: SavedClipboardImage;
  try {
    res = await save();
  } catch (e) {
    res = { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
  if (res.ok) {
    attach(res.file);
    return;
  }
  console.warn('[composer] clipboard image paste failed:', res.error);
  fail(res.error);
}
