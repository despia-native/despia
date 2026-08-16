//
// keyboard.ts — deterministic desktop keyboard activation for real HTML buttons.
//
// Browsers normally translate Enter/Space on a focused <button> into click. Some
// remote-input and embedded-browser bridges deliver the keyboard events without
// running that default action, which used to make a visibly focused DSX control inert.
// Own the standard mapping at the document edge and prevent the native follow-up so
// hardware browsers, automation bridges and desktop web shells all activate once.

type KeyboardRoot = Pick<Document, "addEventListener" | "removeEventListener">;

type ButtonLike = HTMLButtonElement & {
  disabled: boolean;
  isConnected: boolean;
};

const installed = new WeakMap<object, () => void>();

function buttonFrom(target: EventTarget | null): ButtonLike | null {
  if (target === null || typeof target !== "object") return null;
  const candidate = target as EventTarget & {
    closest?: (selector: string) => Element | null;
    tagName?: string;
  };
  const match = typeof candidate.closest === "function" ? candidate.closest("button") : candidate;
  if (match === null || (match as { tagName?: string }).tagName !== "BUTTON") return null;
  if (typeof (match as { click?: unknown }).click !== "function") return null;
  return match as ButtonLike;
}

function plainActivation(event: KeyboardEvent): boolean {
  return !event.isComposing && !event.metaKey && !event.ctrlKey && !event.altKey;
}

/** Install once per document. The returned disposer is stable for repeated calls. */
export function installButtonKeyboardActivation(root: KeyboardRoot = document): () => void {
  const key = root as object;
  const existing = installed.get(key);
  if (existing !== undefined) return existing;

  let spaceTarget: ButtonLike | null = null;
  const onKeyDown = (event: KeyboardEvent): void => {
    const button = buttonFrom(event.target);
    if (button === null || button.disabled || event.defaultPrevented || !plainActivation(event)) return;
    if (event.key === "Enter") {
      event.preventDefault();
      button.click();
    } else if (event.key === " " || event.key === "Spacebar") {
      event.preventDefault(); // also suppresses page scroll and the native key-up click
      spaceTarget = button;
    }
  };
  const onKeyUp = (event: KeyboardEvent): void => {
    if (event.key !== " " && event.key !== "Spacebar") return;
    const button = buttonFrom(event.target);
    const armed = spaceTarget;
    spaceTarget = null;
    if (armed === null || button !== armed || armed.disabled || !armed.isConnected
        || event.defaultPrevented || !plainActivation(event)) return;
    event.preventDefault();
    armed.click();
  };
  const onFocusOut = (event: FocusEvent): void => {
    if (spaceTarget !== null && buttonFrom(event.target) === spaceTarget) spaceTarget = null;
  };

  root.addEventListener("keydown", onKeyDown as EventListener);
  root.addEventListener("keyup", onKeyUp as EventListener);
  root.addEventListener("focusout", onFocusOut as EventListener);

  const dispose = (): void => {
    root.removeEventListener("keydown", onKeyDown as EventListener);
    root.removeEventListener("keyup", onKeyUp as EventListener);
    root.removeEventListener("focusout", onFocusOut as EventListener);
    spaceTarget = null;
    installed.delete(key);
  };
  installed.set(key, dispose);
  return dispose;
}
