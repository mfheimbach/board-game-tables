// Runs the WASM search off the main thread so the UI never stalls.
importScripts('tables.js');
const ready = createTables();
onmessage = async ({ data }) => {
  const M = await ready;
  const t0 = performance.now();
  const bytes = new Uint8Array(Int32Array.from(data.buf).buffer);
  const json = M.ccall('solve_buf', 'string', ['array', 'number'], [bytes, data.buf.length]);
  postMessage({ id: data.id, result: JSON.parse(json), ms: performance.now() - t0 });
};
