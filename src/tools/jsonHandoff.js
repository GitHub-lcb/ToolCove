export const JSON_HANDOFF_EVENT = "json-workspace-handoff";

export function createJsonHandoffQueue({
  loadState,
  saveState,
  prepareState,
  idFactory,
  onOpen,
  onError = () => {},
}) {
  let queue = Promise.resolve();

  async function handoff(text) {
    let loadFailed = false;
    let current;
    try {
      current = await loadState((detail) => {
        if (detail?.phase === "load") loadFailed = true;
      });
    } catch {
      loadFailed = true;
    }
    if (loadFailed) {
      onError("load-failed");
      return { ok: false, reason: "load-failed" };
    }

    const prepared = prepareState(current, text, idFactory);
    if (!prepared.ok) {
      onError(prepared.reason);
      return { ok: false, reason: prepared.reason };
    }

    let saved;
    try {
      saved = await saveState(prepared.value);
    } catch (error) {
      saved = { ok: false, error };
    }
    if (!saved?.ok) {
      onError("save-failed");
      return { ok: false, reason: "save-failed", error: saved?.error };
    }

    try {
      await onOpen(prepared.value);
    } catch (error) {
      onError("open-failed");
      return { ok: false, reason: "open-failed", error };
    }
    return { ok: true };
  }

  return (text) => {
    const next = queue.then(() => handoff(text), () => handoff(text));
    queue = next.then(() => undefined, () => undefined);
    return next;
  };
}


export function createJsonHandoffReceiver({
  normalizeState,
  persistState,
  applyState,
  onError = () => {},
}) {
  let queue = Promise.resolve();

  async function receive(payload) {
    const normalized = normalizeState(payload);
    if (normalized.unsupportedVersion || normalized.destructive || !normalized.state) {
      onError("invalid-state");
      return { ok: false, reason: "invalid-state" };
    }

    let saved;
    try {
      saved = await persistState(normalized.state);
    } catch (error) {
      saved = { ok: false, error };
    }
    if (!saved?.ok) {
      onError("save-failed");
      return { ok: false, reason: "save-failed", error: saved?.error };
    }

    applyState(normalized.state);
    return { ok: true };
  }

  return (payload) => {
    const next = queue.then(() => receive(payload), () => receive(payload));
    queue = next.then(() => undefined, () => undefined);
    return next;
  };
}
