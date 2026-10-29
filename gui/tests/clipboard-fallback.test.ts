import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { Window } from "happy-dom";
import { copyTextToClipboard } from "../src/oauth-health-display";

/**
 * `navigator.clipboard` only exists in a secure context. A LAN-bound GUI
 * (`hostname: 0.0.0.0` over plain HTTP) is not one, so the legacy execCommand
 * path is that deployment's only way to copy a login URL or a doctor command.
 */

const globals = ["document", "window", "navigator"] as const;
let previous: Record<(typeof globals)[number], unknown>;
let win: Window;

function useClipboard(value: unknown) {
  Object.defineProperty(win.navigator, "clipboard", { configurable: true, value });
}

function useExecCommand(value: unknown) {
  Object.defineProperty(win.document, "execCommand", { configurable: true, value });
}

beforeEach(() => {
  previous = Object.fromEntries(globals.map((k) => [k, Reflect.get(globalThis, k)])) as typeof previous;
  win = new Window({ url: "http://192.168.0.10:10100/" });
  Object.defineProperties(globalThis, {
    document: { configurable: true, value: win.document },
    window: { configurable: true, value: win },
    navigator: { configurable: true, value: win.navigator },
  });
});

afterEach(async () => {
  for (const key of globals) {
    Object.defineProperty(globalThis, key, { configurable: true, value: previous[key] });
  }
  await win.happyDOM?.close?.();
});

test("falls back to execCommand when the Clipboard API is absent", async () => {
  useClipboard(undefined);
  const execCommand = mock(() => true);
  useExecCommand(execCommand);

  expect(await copyTextToClipboard("https://auth.example/authorize")).toBe(true);
  expect(execCommand).toHaveBeenCalledWith("copy");
});

test("falls back when writeText rejects, as in a denied permission prompt", async () => {
  useClipboard({ writeText: async () => { throw new Error("denied"); } });
  const execCommand = mock(() => true);
  useExecCommand(execCommand);

  expect(await copyTextToClipboard("https://auth.example/authorize")).toBe(true);
  expect(execCommand).toHaveBeenCalledWith("copy");
});

test("leaves no scratch textarea behind", async () => {
  useClipboard(undefined);
  useExecCommand(mock(() => true));

  await copyTextToClipboard("https://auth.example/authorize");

  expect(win.document.querySelector("textarea")).toBeNull();
});

test("removes the scratch textarea even when execCommand throws", async () => {
  useClipboard(undefined);
  useExecCommand(() => { throw new Error("blocked"); });

  expect(await copyTextToClipboard("https://auth.example/authorize")).toBe(false);
  expect(win.document.querySelector("textarea")).toBeNull();
});

test("reports failure only when both paths are unavailable", async () => {
  useClipboard(undefined);
  useExecCommand(undefined);

  expect(await copyTextToClipboard("https://auth.example/authorize")).toBe(false);
});

test("prefers the Clipboard API and never touches the legacy path", async () => {
  const writeText = mock(async () => {});
  useClipboard({ writeText });
  const execCommand = mock(() => true);
  useExecCommand(execCommand);

  expect(await copyTextToClipboard("https://auth.example/authorize")).toBe(true);
  expect(writeText).toHaveBeenCalledWith("https://auth.example/authorize");
  expect(execCommand).not.toHaveBeenCalled();
});

test("copies inside the active dialog and restores focus and the original input selection", async () => {
  useClipboard(undefined);
  const dialog = win.document.createElement("dialog");
  dialog.setAttribute("open", "");
  const input = win.document.createElement("input");
  input.value = "existing redirect";
  dialog.append(input);
  win.document.body.append(dialog);
  input.focus();
  input.setSelectionRange(2, 6);
  useExecCommand(() => {
    const area = dialog.querySelector("textarea");
    expect(area?.value).toBe("https://auth.example.test/authorize?state=fixture");
    expect(win.document.activeElement).toBe(area);
    expect(area?.selectionStart).toBe(0);
    expect(area?.selectionEnd).toBe(area?.value.length);
    return true;
  });
  expect(await copyTextToClipboard("https://auth.example.test/authorize?state=fixture")).toBe(true);
  expect(win.document.activeElement).toBe(input);
  expect([input.selectionStart, input.selectionEnd]).toEqual([2, 6]);
  expect(dialog.querySelector("textarea")).toBeNull();
});

test("a denied Clipboard API still copies within the modal instead of inert body", async () => {
  useClipboard({ writeText: async () => { throw new Error("denied"); } });
  const dialog = win.document.createElement("dialog");
  dialog.setAttribute("open", "");
  win.document.body.append(dialog);
  useExecCommand(() => !!dialog.querySelector("textarea"));
  expect(await copyTextToClipboard("fixture login code")).toBe(true);
});

test("a throwing clipboard getter also reaches the legacy fallback", async () => {
  Object.defineProperty(win.navigator, "clipboard", { configurable: true, get() { throw new Error("denied"); } });
  useExecCommand(() => true);
  expect(await copyTextToClipboard("fixture login code")).toBe(true);
});
