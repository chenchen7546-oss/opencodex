/** Clipboard writes are user-initiated; never read the clipboard or log its contents. */
export async function copyTextToClipboard(text: string): Promise<boolean> {
  try {
    if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* HTTP pages and denied permissions use the synchronous fallback. */
  }
  return copyViaExecCommand(text);
}

function copyViaExecCommand(text: string): boolean {
  if (typeof document === "undefined" || typeof document.execCommand !== "function") return false;
  const active = document.activeElement as HTMLElement | null;
  const selection = document.getSelection();
  const ranges = selection
    ? Array.from({ length: selection.rangeCount }, (_, i) => selection.getRangeAt(i).cloneRange())
    : [];
  const input = active as HTMLInputElement | HTMLTextAreaElement | null;
  const start = input?.selectionStart,
    end = input?.selectionEnd;
  const area = document.createElement("textarea");
  area.value = text;
  area.readOnly = true;
  area.tabIndex = -1;
  area.style.cssText = "position:fixed;left:0;top:0;opacity:0;pointer-events:none";
  // showModal() makes the rest of the document inert. A textarea on body cannot
  // receive focus there, even though execCommand may report success for old text.
  const dialogs = document.querySelectorAll("dialog[open]");
  const host = active?.closest('dialog[open], [role="dialog"]') ?? dialogs.item(dialogs.length - 1) ?? document.body;
  try {
    host.appendChild(area);
    area.focus({ preventScroll: true });
    area.select();
    area.setSelectionRange(0, text.length);
    return document.execCommand("copy") === true;
  } catch {
    return false;
  } finally {
    area.remove();
    try {
      active?.focus({ preventScroll: true });
      if (start != null && end != null && typeof input?.setSelectionRange === "function")
        input.setSelectionRange(start, end);
      if (selection) {
        selection.removeAllRanges();
        for (const range of ranges) selection.addRange(range);
      }
    } catch {
      /* The dialog or its original focus may have been removed. */
    }
  }
}
