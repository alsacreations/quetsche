/* worker.js - compression hors thread principal */
self.addEventListener("message", async (e) => {
  const { type, payload } = e.data;
  if (type !== "process") return;
  try {
    const { buffer, options } = payload;
    const { quality, targetW, targetH, exportWebP, originalMime, fileName } = options;
    postProgress("Décodage…");
    const blob = new Blob([buffer], { type: originalMime });
    const bitmap = await createImageBitmap(blob);
    const w = targetW || bitmap.width;
    const h = targetH || bitmap.height;
    postProgress("Redimensionnement…");
    const off = new OffscreenCanvas(w, h);
    const ctx = off.getContext("2d");
    ctx.drawImage(bitmap, 0, 0, w, h);
    postProgress("Encodage…");
    const processedBlob = await off.convertToBlob({ type: originalMime, quality });
    const result = {
      previews: { processed: makePreview(processedBlob) },
      meta: {
        fileName,
        original: { size: buffer.byteLength, width: bitmap.width, height: bitmap.height, mime: originalMime },
        processed: { size: processedBlob.size, width: w, height: h, mime: originalMime },
      },
    };
    if (exportWebP) {
      try {
        postProgress("Encodage WebP…");
        const webpBlob = await off.convertToBlob({ type: "image/webp", quality });
        result.previews.webp = makePreview(webpBlob);
      } catch (err) {
        console.warn("WebP échec", err);
      }
    }
    postMessage({ type: "result", payload: result });
  } catch (err) {
    postMessage({ type: "error", payload: { message: err.message } });
  }
});
function postProgress(label) {
  postMessage({ type: "progress", payload: { label } });
}
function makePreview(blob) {
  return { blob, url: URL.createObjectURL(blob) };
}
