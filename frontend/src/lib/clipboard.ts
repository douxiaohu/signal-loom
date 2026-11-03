/**
 * Copies text to the clipboard and reports whether it worked. The async
 * Clipboard API is only available on secure origins and can be denied, so a
 * failure is an expected outcome, not an exception.
 */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // denied or unsupported: try the legacy path below
  }
  return legacyCopy(text);
}

/**
 * Copies an image blob to the clipboard. Image copy needs the async Clipboard
 * API with ClipboardItem, which only exists on secure origins and can be denied,
 * so a failure is an expected outcome the caller falls back to download for.
 */
export async function copyImage(blob: Blob): Promise<boolean> {
  try {
    if (navigator.clipboard && "write" in navigator.clipboard && typeof ClipboardItem !== "undefined") {
      await navigator.clipboard.write([new ClipboardItem({ [blob.type]: blob })]);
      return true;
    }
  } catch {
    // denied or unsupported
  }
  return false;
}

function legacyCopy(text: string): boolean {
  const area = document.createElement("textarea");
  area.value = text;
  area.setAttribute("readonly", "");
  area.style.position = "fixed";
  area.style.opacity = "0";
  document.body.appendChild(area);
  try {
    area.select();
    return typeof document.execCommand === "function" && document.execCommand("copy");
  } catch {
    return false;
  } finally {
    area.remove();
  }
}
