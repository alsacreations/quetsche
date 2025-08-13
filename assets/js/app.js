/* Prototype compression client-side
 * - Lit un fichier image
 * - Optionnel: redimensionne via canvas
 * - Exporte JPEG/PNG optimisé (approx) + WebP
 * NOTE: Pour une qualité proche de MozJPEG/OxiPNG, intégrer wasm codecs (todo prochaine étape)
 */

const fileInput = document.getElementById("fileInput");
const dropHint = document.getElementById("dropHint");
const dropZone = document.getElementById("dropZone");
// Qualité fixe (75%)
const FIXED_QUALITY = 0.75;
const resizeRadios = document.querySelectorAll('input[name="resize"]');
const statusEl = document.getElementById("status");
const resultsSection = document.querySelector(".results");
const compare = document.getElementById("compare");
const compareInner = document.getElementById("compareInner");
let origPreview, procPreview, origDim, origSize, procDim, procSize, procGain;
const downloadGroup = document.getElementById("downloadGroup");
// Tableau de téléchargement
const downloadTable = document.getElementById("downloadTable");
let downloadTbody = downloadTable ? downloadTable.querySelector("tbody") : null;
const metrics = document.getElementById("metrics");
const metricOrigBpp = document.getElementById("metricOrigBpp");
const metricProcBpp = document.getElementById("metricProcBpp");
const metricBytesSaved = document.getElementById("metricBytesSaved");
const metricCo2Saved = document.getElementById("metricCo2Saved");
// Échantillon d'exemple
const sampleContainer = document.getElementById("sampleSuggestion");

let originalImage = null; // { blob, width, height, fileName, size }
let worker = null;
initWorker();

// Active le chargement de l'image d'exemple
if (sampleContainer) {
  sampleContainer.addEventListener("click", (e) => {
    const target = e.target;
    if (target instanceof HTMLElement && target.matches(".sample-load")) {
      const fullSrc = target.getAttribute("data-full-src");
      const fname = target.getAttribute("data-file-name") || "sample.jpg";
      if (fullSrc) {
        loadSample(fullSrc, fname);
      }
    }
  });
}

async function loadSample(url, fileName) {
  try {
    announceStatus("Chargement de l'exemple…", true);
    let res = await fetch(url);
    if (!res.ok) {
      // Fallback orthographe (quetsche vs questche)
      const alt = url.includes("questche")
        ? url.replace("questche", "quetsche")
        : url.replace("quetsche", "questche");
      res = await fetch(alt);
      if (res.ok) {
        url = alt; // conserve l'URL réellement utilisée
        if (fileName.includes("questche") || fileName.includes("quetsche")) {
          fileName = alt.split("/").pop() || fileName;
        }
      }
    }
    if (!res.ok) throw new Error("404");
    const blob = await res.blob();
    const file = new File([blob], fileName, {
      type: blob.type || "image/jpeg",
    });
    await handleFile(file);
    announceStatus("Exemple chargé, compression…", true);
  } catch (err) {
    announceStatus("Impossible de charger l'exemple", false);
  }
}

function initWorker() {
  worker = new Worker("assets/js/worker.js", { type: "module" });
  worker.addEventListener("message", onWorkerMessage);
}

function onWorkerMessage(e) {
  const { type, payload } = e.data;
  if (type === "progress") {
    statusEl.textContent = payload.label;
  } else if (type === "result") {
    buildResults(payload);
  } else if (type === "error") {
    statusEl.textContent = "Erreur worker: " + payload.message;
  }
}

fileInput.addEventListener("change", () => {
  if (!fileInput.files?.length) return;
  const selected = fileInput.files[0];
  handleFile(selected).finally(() => {
    fileInput.value = ""; // reset après traitement
  });
});

// Drag & drop
["dragenter", "dragover"].forEach((evt) => {
  document.addEventListener(evt, (e) => {
    e.preventDefault();
    e.dataTransfer && (e.dataTransfer.dropEffect = "copy");
    dropZone?.classList.add("is-drag");
    dropZone?.setAttribute(
      "aria-label",
      "Déposez le fichier pour lancer la compression"
    );
  });
});
["dragleave", "drop"].forEach((evt) => {
  document.addEventListener(evt, (e) => {
    e.preventDefault();
    if (evt === "drop" && e.dataTransfer?.files?.length) {
      fileInput.files = e.dataTransfer.files;
      fileInput.dispatchEvent(new Event("change"));
    }
    dropZone?.classList.remove("is-drag");
    dropZone?.removeAttribute("aria-label");
  });
});

dropZone?.addEventListener("keydown", (e) => {
  if (e.key === "Enter" || e.key === " ") {
    e.preventDefault();
    fileInput.click();
  }
});

dropZone?.addEventListener("click", (e) => {
  const target = e.target;
  if (
    target instanceof Element &&
    (target.closest("label") || target === fileInput)
  )
    return;
  fileInput.click();
});

resizeRadios.forEach((r) =>
  r.addEventListener("change", () => originalImage && process())
);

async function handleFile(file) {
  announceStatus("Lecture du fichier…", true);
  const arrayBuffer = await file.arrayBuffer();
  const blob = new Blob([arrayBuffer], { type: file.type });
  const url = URL.createObjectURL(blob);
  const img = new Image();
  img.decoding = "async";
  img.onload = () => {
    originalImage = {
      blob,
      width: img.naturalWidth,
      height: img.naturalHeight,
      fileName: file.name,
    };
    ensurePreviewStructure();
    origPreview.src = url;
    origDim.textContent = img.naturalWidth + "×" + img.naturalHeight;
    origSize.textContent = formatBytes(file.size);
    if (resultsSection.hasAttribute("hidden")) {
      resultsSection.hidden = false;
      resultsSection.dataset.state = "loaded";
    }
    compare.hidden = false;
    focusResultsHeading();
    announceStatus("Image chargée, compression…", true);
    process();
  };
  img.onerror = () => {
    announceStatus("Échec de lecture.", false);
  };
  img.src = url;
}

async function process() {
  if (!originalImage) return;
  announceStatus("Préparation…", true);
  const quality = FIXED_QUALITY;
  let maxSide = null;
  const checked = document.querySelector('input[name="resize"]:checked');
  if (checked && (checked.value !== "original" || checked.value === "1200")) {
    maxSide = Number(checked.value);
  }
  let targetW = originalImage.width;
  let targetH = originalImage.height;
  if (
    maxSide &&
    (originalImage.width > maxSide || originalImage.height > maxSide)
  ) {
    if (originalImage.width >= originalImage.height) {
      targetW = maxSide;
      targetH = Math.round(
        (maxSide * originalImage.height) / originalImage.width
      );
    } else {
      targetH = maxSide;
      targetW = Math.round(
        (maxSide * originalImage.width) / originalImage.height
      );
    }
  }
  const opts = {
    quality,
    targetW,
    targetH,
    exportWebP: true,
    exportAvif: false,
    originalMime: originalImage.blob.type,
    fileName: originalImage.fileName,
    engine: "native",
  };
  const arrayBuffer = await originalImage.blob.arrayBuffer();
  worker.postMessage(
    { type: "process", payload: { buffer: arrayBuffer, options: opts } },
    [arrayBuffer]
  );
  announceStatus("Traitement en cours…", true);
}

function buildResults(data) {
  const { previews, meta } = data;
  ensurePreviewStructure();
  procPreview.src = previews.processed.url;
  procDim.textContent =
    meta.processed.width + "×" + meta.processed.height + " pixels";
  origDim.textContent =
    meta.original.width + "×" + meta.original.height + " pixels";
  procSize.textContent = formatBytes(meta.processed.size);
  const deltaPct =
    meta.original.size > 0
      ? (1 - meta.processed.size / meta.original.size) * 100
      : 0;
  const sign = deltaPct >= 0 ? "-" : "+";
  const absPct = Math.abs(deltaPct).toFixed(1);
  procGain.textContent = sign + absPct + "%";
  procGain.classList.remove("gain-positive", "gain-negative");
  if (deltaPct >= 0) {
    procGain.classList.add("gain-positive");
    procGain.setAttribute("aria-label", absPct + "% plus léger");
  } else {
    procGain.classList.add("gain-negative");
    procGain.setAttribute("aria-label", absPct + "% plus lourd");
  }
  // Construire le tableau récapitulatif des versions
  if (downloadTbody) downloadTbody.innerHTML = "";
  const rows = [];
  // Ligne originale (données issues de meta.original)
  rows.push(
    makeDownloadRow({
      label: "Originale",
      blob: originalImage.blob,
      fileName: meta.fileName,
      mime: meta.original.mime || originalImage.blob.type,
      size: meta.original.size,
      optimized: false,
    })
  );
  // Ligne compressée
  rows.push(
    makeDownloadRow({
      label: "Compressée",
      blob: previews.processed.blob,
      fileName: deriveFileName(meta.fileName, meta.processed.mime),
      mime: meta.processed.mime,
      size: meta.processed.size,
      optimized: false,
    })
  );
  // Ligne WebP éventuelle
  if (previews.webp) {
    rows.push(
      makeDownloadRow({
        label: "WebP",
        blob: previews.webp.blob,
        fileName: deriveFileName(meta.fileName, "image/webp"),
        mime: "image/webp",
        size: previews.webp.blob.size,
        optimized: false,
      })
    );
  }
  // Trouver la plus légère (hors cas taille 0)
  const candidates = rows.filter((r) => r.dataset.size > 0);
  if (candidates.length) {
    const best = candidates.reduce((a, b) =>
      Number(b.dataset.size) < Number(a.dataset.size) ? b : a
    );
    best.classList.add("is-best");
    const cell = best.querySelector('[data-col="best"]');
    if (cell) {
      cell.innerHTML =
        '<span class="best-indicator" role="img" aria-label="Version la plus optimisée">✔</span>';
    }
  }
  if (downloadTbody) rows.forEach((tr) => downloadTbody.appendChild(tr));
  // Mettre à jour lien Download dans le figcaption compressé
  injectInlineDownload(
    previews.processed.blob,
    deriveFileName(meta.fileName, meta.processed.mime)
  );
  downloadGroup.hidden = false;
  announceStatus("Compression effectuée", false, true);
  const origPixels = meta.original.width * meta.original.height;
  const procPixels = meta.processed.width * meta.processed.height;
  const origBpp = (meta.original.size * 8) / Math.max(1, origPixels);
  const procBpp = (meta.processed.size * 8) / Math.max(1, procPixels);
  const bytesSaved = Math.max(0, meta.original.size - meta.processed.size);
  const co2PerMB = 0.5;
  const co2Saved = (bytesSaved / (1024 * 1024)) * co2PerMB;
  metricOrigBpp.textContent = origBpp.toFixed(2);
  metricProcBpp.textContent = procBpp.toFixed(2);
  metricBytesSaved.textContent = formatBytes(bytesSaved);
  metricCo2Saved.textContent = co2Saved.toFixed(2) + " g";
  metrics.hidden = false;
}

function makeDownloadRow(data) {
  /* Construit une ligne du tableau des téléchargements */
  const { label, blob, fileName, size } = data;
  const tr = document.createElement("tr");
  tr.dataset.size = size;
  // Col version
  const tdLabel = document.createElement("th");
  tdLabel.scope = "row";
  tdLabel.textContent = label;
  tr.appendChild(tdLabel);
  // Col poids
  const tdSize = document.createElement("td");
  tdSize.textContent = formatBytes(size);
  tdSize.dataset.col = "size";
  tr.appendChild(tdSize);
  // Col lien
  const tdLink = document.createElement("td");
  const a = document.createElement("a");
  a.download = fileName;
  a.href = URL.createObjectURL(blob);
  a.textContent = fileName;
  a.setAttribute(
    "aria-label",
    `${label}, ${fileName}, taille ${formatBytes(size)}`
  );
  tdLink.appendChild(a);
  tr.appendChild(tdLink);
  // Col meilleur
  const tdBest = document.createElement("td");
  tdBest.dataset.col = "best";
  tdBest.className = "cell-best";
  tr.appendChild(tdBest);
  return tr;
}

function injectInlineDownload(blob, fileName) {
  const fig = document.querySelector(".figure-processed figcaption");
  if (!fig) return;
  let existing = fig.querySelector(".inline-download");
  if (existing) existing.remove();
  const link = document.createElement("a");
  link.className = "inline-download";
  link.href = URL.createObjectURL(blob);
  link.download = fileName;
  link.textContent = "Télécharger";
  link.setAttribute(
    "aria-label",
    "Télécharger la version compressée " + fileName
  );
  link.style.marginLeft = "0.5rem";
  fig.appendChild(document.createTextNode(" "));
  fig.appendChild(link);
}

function deriveFileName(origName, mimeType) {
  const base = origName.replace(/\.[^.]+$/, "");
  const ext = mimeType === "image/jpeg" ? "jpg" : mimeType.split("/")[1];
  return base + "." + ext;
}

function formatBytes(bytes) {
  const units = ["octets", "Ko", "Mo", "Go"];
  let i = 0;
  let n = bytes;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  return n.toFixed(n < 10 && i > 0 ? 2 : 0) + " " + units[i];
}

function announceStatus(message, busy, hideVisually = false) {
  statusEl.textContent = message;
  if (busy) {
    resultsSection?.setAttribute("aria-busy", "true");
  } else {
    resultsSection?.removeAttribute("aria-busy");
  }
  if (hideVisually) {
    statusEl.classList.add("visually-hidden");
  } else {
    statusEl.classList.remove("visually-hidden");
  }
}

function focusResultsHeading() {
  const heading = document.getElementById("results-title");
  if (!heading) return;
  if (!heading.hasAttribute("tabindex")) heading.setAttribute("tabindex", "-1");
  heading.focus({ preventScroll: false });
}

function ensurePreviewStructure() {
  if (compareInner.dataset.built === "true") return;
  compareInner.innerHTML = "";
  const figOriginal = document.createElement("figure");
  figOriginal.className = "figure figure-original";
  figOriginal.innerHTML = `<figcaption>Original (<span id="origDim"></span>, <span id="origSize"></span>)</figcaption><img id="origPreview" alt="Aperçu image originale" />`;
  const figProcessed = document.createElement("figure");
  figProcessed.className = "figure figure-processed";
  figProcessed.innerHTML = `<figcaption>Compressé (<span id="procDim"></span>, <span id="procSize"></span>, <span id="procGain" class="gain"></span>)</figcaption><img id="procPreview" alt="Aperçu image compressée" />`;
  compareInner.appendChild(figOriginal);
  compareInner.appendChild(figProcessed);
  origPreview = document.getElementById("origPreview");
  procPreview = document.getElementById("procPreview");
  origDim = document.getElementById("origDim");
  origSize = document.getElementById("origSize");
  procDim = document.getElementById("procDim");
  procSize = document.getElementById("procSize");
  procGain = document.getElementById("procGain");
  compareInner.dataset.built = "true";
  compareInner.style.display = "";
}
