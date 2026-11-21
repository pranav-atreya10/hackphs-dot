function startWorker() {
  if (typeof globalThis.Worker === "undefined") {
    throw new Error("SkySentry v5 requires Web Worker support");
  }
  return new globalThis.Worker(new URL("./skysentry-v5-worker.mjs", import.meta.url), { type: "module" });
}

export function createV5WorkerClient({ createWorker = startWorker, timeoutMs = 25_000 } = {}) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 0x7fffffff) {
    throw new RangeError("timeoutMs must be a positive Web Worker request timeout");
  }
  if (typeof createWorker !== "function") {
    throw new TypeError("createWorker must be a function");
  }

  let worker = null;
  let pending = null;
  let loaded = false;
  let lastError = null;
  let nextId = 0;

  function takePending() {
    const job = pending;
    pending = null;
    if (job) clearTimeout(job.timer);
    return job;
  }

  function stop(error) {
    const active = worker;
    worker = null;
    loaded = false;
    lastError = error;
    takePending()?.reject(error);
    if (active) {
      active.onmessage = active.onerror = active.onmessageerror = null;
      active.terminate();
    }
  }

  function request(type, payload, transfer = []) {
    const id = ++nextId;
    let resolve, reject;
    const promise = new Promise((ok, fail) => { resolve = ok; reject = fail; });
    const timer = setTimeout(() => {
      if (pending?.id === id) {
        stop(new DOMException(`SkySentry v5 worker ${type} timed out after ${timeoutMs} ms`, "TimeoutError"));
      }
    }, timeoutMs);
    pending = { id, type, count: payload?.boxes.length, promise, resolve, reject, timer };
    try {
      worker.postMessage({ id, type, ...payload }, transfer);
    } catch (error) {
      stop(error);
    }
    return promise;
  }

  function load() {
    if (loaded) return Promise.resolve();
    if (pending) return pending.promise;
    try {
      const active = createWorker();
      worker = active;
      lastError = null;
      active.onmessage = ({ data }) => {
        const job = pending;
        if (worker !== active || !job || data?.id !== job.id) return;
        if (data.ok === false) {
          const reason = typeof data.error === "string" && data.error ? data.error : "unknown error";
          stop(new Error(`SkySentry v5 worker ${job.type} failed: ${reason}`));
        } else if (
          data.ok !== true ||
          (job.type === "classify" && (!Array.isArray(data.results) || data.results.length !== job.count))
        ) {
          stop(new Error(`Invalid SkySentry v5 worker ${job.type} reply`));
        } else {
          loaded = true;
          takePending().resolve(job.type === "classify" ? data.results : undefined);
        }
      };
      active.onerror = ({ message }) => {
        if (worker === active) stop(new Error(message || "SkySentry v5 worker crashed"));
      };
      active.onmessageerror = () => {
        if (worker === active) stop(new Error("Could not read the SkySentry v5 worker reply"));
      };
      return request("load");
    } catch (error) {
      stop(error);
      return Promise.reject(error);
    }
  }

  // Takes ownership of the frame helper's exclusive RGBA copy. Posting it detaches its buffer.
  async function classify(frame, boxes) {
    if (pending) throw new Error("SkySentry v5 worker is busy");
    if (!loaded) throw lastError ?? new Error("SkySentry v5 worker is not loaded");
    const { data, width, height } = frame ?? {};
    if (
      !Number.isSafeInteger(width) ||
      width < 1 ||
      !Number.isSafeInteger(height) ||
      height < 1 ||
      !(data instanceof Uint8ClampedArray) ||
      !(data.buffer instanceof ArrayBuffer) ||
      data.byteLength !== width * height * 4 ||
      data.byteOffset !== 0 ||
      data.buffer.byteLength !== data.byteLength
    ) {
      throw new TypeError("Expected an owned RGBA frame buffer for SkySentry v5");
    }
    if (!Array.isArray(boxes)) throw new TypeError("Expected an array of SkySentry v5 boxes");
    return request("classify", { frame: { data, width, height }, boxes }, [data.buffer]);
  }

  // The next explicit load starts a fresh worker, including after a failure.
  function close() {
    stop(new DOMException("SkySentry v5 worker was closed", "AbortError"));
    lastError = null;
  }

  return { load, classify, close };
}
