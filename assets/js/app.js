/* Prototype compression client-side
 * - Lit un fichier image
 * - Optionnel: redimensionne via canvas
 * - Exporte JPEG/PNG optimisé (approx) + WebP
 * NOTE: Pour une qualité proche de MozJPEG/OxiPNG, intégrer wasm codecs (todo prochaine étape)
 */

const fileInput = document.getElementById("fileInput");
const dropHint = document.getElementById("dropHint");
const dropZone = document.getElementById("dropZone");
const dropSection = document.querySelector(".drop-section");
// Qualité fixe (75%)
const FIXED_QUALITY = 0.75;
const resizeRadios = document.querySelectorAll('input[name="resize"]');
const statusEl = document.getElementById("status");
const resultsSection = document.querySelector(".results");
const compressResults = document.querySelector(".compress-results");
const compare = document.getElementById("compare");
const compareInner = document.getElementById("compareInner");
// Aperçu : image compressée + original superposés
let procPreview, origPreview, procDim, procSize, procGain; // origPreview ajouté pour swap
const downloadGroup = document.getElementById("downloadGroup");
// Tableau de téléchargement
const downloadTable = document.getElementById("downloadTable");
let downloadTbody = downloadTable ? downloadTable.querySelector("tbody") : null;
const resizeChoices = document.getElementById("resizeChoices");
const bilanPlaceholder = document.getElementById("bilanPlaceholder");
const bilanContent = document.getElementById("bilanContent");
// Panel format
const formatPanel = document.getElementById("formatPanel");
let formatRadios = null;
// Échantillon d'exemple
const sampleContainer = document.getElementById("sampleSuggestion");

let originalImage = null; // { blob, width, height, fileName, size }
// État courant des derniers résultats de compression (pour mise à jour dynamique)
let currentPreviews = null; // { processed:{blob,url}, webp?:{blob,url} }
let currentMeta = null; // { original:{size,width,height,mime}, processed:{size,width,height,mime}, fileName }
let worker = null;
initWorker();

// Met à jour les libellés des options de redimensionnement avec dimensions calculées
function updateResizeLabels() {
  const origSpan = document.querySelector('[data-role="original-dim"]');
  const webSpan = document.querySelector('[data-role="web-dim"]');
  if (originalImage && origSpan) {
    origSpan.textContent = `(${originalImage.width}×${originalImage.height}px)`;
  }
  if (originalImage && webSpan) {
    // Calcule la dimension après contrainte 1200 sur le plus grand côté
    const target = 1200;
    const w = originalImage.width;
    const h = originalImage.height;
    if (Math.max(w, h) <= target) {
      webSpan.textContent = `(déjà ${w}×${h}px)`;
    } else {
      const ratio = w >= h ? h / w : w / h;
      let newW, newH;
      if (w >= h) {
        newW = target;
        newH = Math.round(target * ratio);
      } else {
        newH = target;
        newW = Math.round(target * ratio);
      }
      webSpan.textContent = `(${newW}×${newH}px)`;
    }
  }
}

// Met à jour l'affichage du format original dans format-panel
function updateFormatLabels() {
  const formatSpan = document.querySelector('[data-role="format-original"]');
  if (!formatSpan) return;
  if (originalImage) {
    const type = originalImage.blob.type || ""; // ex: image/jpeg
    let fmt = "";
    if (type.startsWith("image/")) {
      fmt = type.split("/")[1];
    }
    if (!fmt && originalImage.fileName) {
      const m = originalImage.fileName.match(/\.([^.]+)$/);
      if (m) fmt = m[1];
    }
    if (fmt) {
      if (fmt === "jpeg") fmt = "jpg"; // normalisation
      formatSpan.textContent = `(${fmt.toUpperCase()})`;
    } else {
      formatSpan.textContent = "";
    }
  } else {
    formatSpan.textContent = "";
  }
}

// Active le chargement de l'image d'exemple
if (sampleContainer) {
  sampleContainer.addEventListener("click", (e) => {
    const raw = e.target;
    if (!(raw instanceof HTMLElement)) return;
    const trigger = raw.closest(".sample-load");
    if (trigger) {
      e.preventDefault();
      const fullSrc = trigger.getAttribute("data-full-src");
      const fname = trigger.getAttribute("data-file-name") || "sample.jpg";
      if (fullSrc) loadSample(fullSrc, fname);
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
  // Nouveau fichier : on retire l'état résultat précédent
  dropSection?.classList.remove("has-result");
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
      url,
    };
    updateResizeLabels();
    updateFormatLabels();
    // Masquer contenu compression regroupé
    if (compressResults) compressResults.hidden = true;
    ensurePreviewStructure();
    // Aperçu original supprimé : seules dimensions conservées ailleurs (bilan / labels)
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
  currentPreviews = previews;
  currentMeta = meta;
  // Ajoute la classe signalant qu'un résultat est disponible
  dropSection?.classList.add("has-result");
  ensurePreviewStructure();
  updateResizeLabels();
  updateFormatLabels();
  if (previews.webp && formatPanel) {
    if (!formatRadios) {
      formatRadios = formatPanel.querySelectorAll('input[name="format"]');
      formatRadios.forEach((r) => {
        r.addEventListener("change", () => {
          updateDisplayedFormat();
          updateBilan();
        });
      });
      // Sélection par défaut (processed) si aucune coche (évite chosen null)
      const anyChecked = Array.from(formatRadios).some((r) => r.checked);
      if (!anyChecked) {
        const first = Array.from(formatRadios).find(
          (r) => r.value === "processed"
        );
        if (first) first.checked = true;
      }
    }
  }
  procPreview.src = previews.processed.url;
  // Pré-charge l'original pour swap rapide
  if (origPreview && originalImage?.url) {
    origPreview.src = originalImage.url;
  }
  procDim.textContent = `${meta.processed.width}×${meta.processed.height} pixels`;
  // Plus d'affichage direct de l'original dans la zone visuelle de comparaison
  if (downloadTbody) downloadTbody.innerHTML = "";
  const rows = [];
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
  const candidates = rows.filter((r) => r.dataset.size > 0);
  if (candidates.length) {
    const best = candidates.reduce((a, b) =>
      Number(b.dataset.size) < Number(a.dataset.size) ? b : a
    );
    best.classList.add("is-best");
    const cell = best.querySelector('[data-col="best"]');
    if (cell)
      cell.innerHTML =
        '<span class="best-indicator" role="img" aria-label="Version la plus optimisée">✔</span>';
  }
  if (downloadTbody) rows.forEach((tr) => downloadTbody.appendChild(tr));
  updateDisplayedFormat();
  downloadGroup.hidden = false;
  if (compressResults) compressResults.hidden = false;
  announceStatus("Compression effectuée", false, true);
  updateBilan();
}

function updateDisplayedFormat() {
  if (!currentPreviews || !currentMeta) return;
  const previews = currentPreviews;
  const meta = currentMeta;
  const chosen = document.querySelector('input[name="format"]:checked');
  const mode = chosen ? chosen.value : "processed";
  const current =
    mode === "webp" && previews.webp ? previews.webp : previews.processed;
  if (procPreview && current) {
    procPreview.src = current.url;
    procPreview.alt = `Aperçu image compressée (${
      mode === "webp" ? "WebP" : "original compressé"
    })`;
  }
  const blob =
    mode === "webp" && previews.webp
      ? previews.webp.blob
      : previews.processed.blob;
  procSize.textContent = formatBytes(blob.size);
  const deltaPct =
    currentMeta.original.size > 0
      ? (1 - blob.size / currentMeta.original.size) * 100
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
  const fileNameForLink =
    mode === "webp" && previews.webp
      ? deriveFileName(meta.fileName, "image/webp")
      : deriveFileName(meta.fileName, meta.processed.mime);
  injectInlineDownload(blob, fileNameForLink);
}

function updateBilan() {
  if (!bilanContent || !currentMeta || !currentPreviews) return;
  const meta = currentMeta;
  const previews = currentPreviews;
  const origBytes = meta.original.size;
  const chosen = document.querySelector('input[name="format"]:checked');
  const mode = chosen ? chosen.value : "processed";
  const chosenBlob =
    mode === "webp" && previews.webp
      ? previews.webp.blob
      : previews.processed.blob;
  const chosenFormat =
    mode === "webp" && previews.webp
      ? "WebP"
      : meta.processed.mime.split("/").pop()?.toUpperCase() || "";

  const chosenSizeBytes = chosenBlob.size;
  // Delta: positif si plus lourd, négatif si plus léger
  const deltaBytes = chosenSizeBytes - origBytes;
  const absDeltaBytes = Math.abs(deltaBytes);
  const isHeavier = deltaBytes > 0;

  // Pourcentage d'écart relatif au poids d'origine
  let pctRaw = 0;
  if (origBytes > 0) pctRaw = ((origBytes - chosenSizeBytes) / origBytes) * 100; // >0 si gain
  const absPct = Math.abs(pctRaw);
  const pctRounded = Math.round(absPct * 10) / 10;
  const pctStr =
    pctRounded === 0
      ? "0%"
      : (pctRaw >= 0 ? "-" : "+") + pctRounded.toFixed(1) + "%";

  // CO2: seulement une réduction si on gagne, sinon 0
  const co2PerMB = 0.5; // g CO₂ / Mo
  const co2Saved =
    pctRaw <= 0
      ? "0.00 g"
      : ((absDeltaBytes / (1024 * 1024)) * co2PerMB).toFixed(2) + " g";

  const orig = formatBytes(origBytes);
  const chosenSize = formatBytes(chosenSizeBytes);
  const bytesLabel = isHeavier ? "Octets supplémentaires" : "Octets économisés";
  const gainLabel = isHeavier ? "Perte" : "Gain";

  const html = `
    <ul class="bilan-list" role="list">
      <li>Poids originel (${meta.original.mime
        .split("/")
        .pop()
        .toUpperCase()}) : <span class="bilan-val">${orig}</span></li>
      <li>Poids compressé (${chosenFormat}) : <span class="bilan-val">${chosenSize}</span></li>
      <li>${bytesLabel} : <span class="bilan-val">${formatBytes(
    absDeltaBytes
  )}</span></li>
      <li>${gainLabel} : <span class="bilan-gain${
    isHeavier ? " is-negative" : ""
  }">${pctStr}</span></li>
      <li>Réduction CO₂ estimée : <span class="bilan-val">${co2Saved}</span></li>
    </ul>
    <p class="metrics-note bilan-note"><small>Estimation CO₂ (~0,5 g / Mo transféré) source indicative : <a href="https://www.websitecarbon.com/" target="_blank" rel="noopener noreferrer">Website Carbon</a></small></p>
  `;
  bilanContent.innerHTML = html;
  bilanContent.dataset.state = "ready";
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
  const wrapper = fig.querySelector(".inline-download-wrapper");
  if (!wrapper) return;
  wrapper.innerHTML = "";
  const link = document.createElement("a");
  link.className = "inline-download";
  link.href = URL.createObjectURL(blob);
  link.download = fileName;
  link.textContent = "Télécharger";
  link.setAttribute(
    "aria-label",
    "Télécharger la version compressée " + fileName
  );
  wrapper.appendChild(link);
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
  // Si la structure existe déjà, on s'assure que le hint est sous l'image (hors figcaption)
  if (compareInner.dataset.built === "true") {
    const existingFigure = compareInner.querySelector(".figure-processed");
    if (existingFigure) {
      const existingHint = existingFigure.querySelector(".preview-hint");
      const existingStack = existingFigure.querySelector(".preview-stack");
      if (
        existingHint &&
        existingStack &&
        existingHint.parentElement &&
        existingHint.parentElement.tagName.toLowerCase() === "figcaption"
      ) {
        // Déplace le hint juste après la pile d'aperçu
        existingStack.insertAdjacentElement("afterend", existingHint);
      }
    }
    return;
  }
  compareInner.innerHTML = "";
  const figProcessed = document.createElement("figure");
  figProcessed.className = "figure figure-processed";
  figProcessed.innerHTML = `
  <figcaption data-layout=\"repel\">
  <span class=\"proc-title\">Image optimisée</span>
  <span class=\"proc-values\">
    <span class=\"proc-dim visually-hidden\"></span>
    <span class=\"proc-size pill\"></span>
    <span class=\"proc-gain gain pill\"></span>
  </span>
  <span class=\"inline-download-wrapper\"></span>
  </figcaption>
    <div class=\"preview-stack\">
      <img class=\"proc-preview\" alt=\"Aperçu image compressée\" />
      <img class=\"orig-preview\" alt=\"Aperçu image originale\" aria-hidden=\"true\" />
    </div>
    <small class=\"preview-hint\" aria-live=\"polite\">(clic maintenu pour voir l'image originale)</small>`;
  compareInner.appendChild(figProcessed);
  procPreview = figProcessed.querySelector(".proc-preview");
  origPreview = figProcessed.querySelector(".orig-preview"); // assignation ajoutée
  procDim = figProcessed.querySelector(".proc-dim");
  procSize = figProcessed.querySelector(".proc-size");
  procGain = figProcessed.querySelector(".proc-gain");
  compareInner.dataset.built = "true";
  compareInner.style.display = "";
  // Interaction maintien pour swap
  const hintEl = figProcessed.querySelector(".preview-hint");
  const showOriginal = () => {
    if (!origPreview || !originalImage) return;
    if (!origPreview.src && originalImage.url)
      origPreview.src = originalImage.url;
    figProcessed.classList.add("showing-original");
    if (hintEl)
      hintEl.textContent = "(relâcher pour revenir à la version optimisée)";
  };
  const hideOriginal = () => {
    figProcessed.classList.remove("showing-original");
    if (hintEl)
      hintEl.textContent = "(clic maintenu pour voir l'image originale)";
  };
  figProcessed.addEventListener("pointerdown", (e) => {
    if (e.button === 0) showOriginal();
  });
  window.addEventListener("pointerup", hideOriginal);
  figProcessed.addEventListener("pointerleave", hideOriginal);
  figProcessed.tabIndex = 0;
  figProcessed.addEventListener("keydown", (e) => {
    if (e.code === "Space" || e.code === "Enter") {
      e.preventDefault();
      showOriginal();
    }
  });
  figProcessed.addEventListener("keyup", (e) => {
    if (e.code === "Space" || e.code === "Enter") hideOriginal();
  });

  // Overlay original supprimé : aucune interaction spéciale
}
