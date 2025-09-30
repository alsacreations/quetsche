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
// Aperçu : image compressée
let procPreview, procDim, procSize, procGain;
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

// Mode batch (traitement par lot) - réutilise la zone compare existante
let batchState = {
  active: false,
  cancelled: false,
  total: 0,
  current: 0,
  results: [], // { fileName, status, originalBlob, processedBlob, webpBlob, meta, error }
};

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
  const files = Array.from(fileInput.files);

  // Détection auto : 1 image = mode simple, 2+ = mode batch
  if (files.length === 1) {
    handleFile(files[0]).finally(() => {
      fileInput.value = ""; // reset après traitement
    });
  } else {
    handleBatchFiles(files).finally(() => {
      fileInput.value = ""; // reset après traitement
    });
  }
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
  r.addEventListener("change", () => {
    // Retraiter les images batch si mode actif
    if (batchState.active && batchState.results.length > 0) {
      reprocessBatch();
      return;
    }
    if (originalImage) process();
  })
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

/* ========== MODE BATCH (traitement par lot) ========== */

async function handleBatchFiles(files) {
  // Initialisation du mode batch
  batchState = {
    active: true,
    cancelled: false,
    total: files.length,
    current: 0,
    results: [],
  };

  // Afficher la zone de résultats
  if (compressResults) compressResults.hidden = false;
  compare.hidden = false;

  // Vider et préparer compareInner pour le mode batch
  compareInner.innerHTML = "";
  compareInner.dataset.built = "batch";

  // Afficher la progression dans status
  announceStatus(`Traitement de ${files.length} images...`, true);

  // Traitement séquentiel des images
  for (let i = 0; i < files.length; i++) {
    if (batchState.cancelled) break;

    const file = files[i];
    batchState.current = i + 1;
    updateBatchProgress();

    try {
      const result = await processSingleImageForBatch(file);
      batchState.results.push({
        fileName: file.name,
        status: "success",
        originalBlob: result.originalBlob,
        processedBlob: result.processedBlob,
        webpBlob: result.webpBlob,
        meta: result.meta,
      });
    } catch (error) {
      batchState.results.push({
        fileName: file.name,
        status: "error",
        error: error.message || "Échec du traitement",
      });
    }
  }

  // Afficher les résultats
  displayBatchResults();
  announceStatus(
    `✓ ${
      batchState.results.filter((r) => r.status === "success").length
    } images traitées avec succès`,
    false,
    true
  );
}

async function processSingleImageForBatch(file) {
  // Retourne une Promise avec le résultat du traitement
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = async (e) => {
      try {
        const arrayBuffer = e.target.result;
        const blob = new Blob([arrayBuffer], { type: file.type });
        const url = URL.createObjectURL(blob);
        const img = new Image();
        img.decoding = "async";

        img.onload = async () => {
          const origWidth = img.naturalWidth;
          const origHeight = img.naturalHeight;

          // Calcul des dimensions cibles (selon les réglages)
          const quality = FIXED_QUALITY;
          let maxSide = null;
          const checked = document.querySelector(
            'input[name="resize"]:checked'
          );
          if (checked && checked.value !== "original") {
            maxSide = Number(checked.value);
          }

          let targetW = origWidth;
          let targetH = origHeight;
          if (maxSide && (origWidth > maxSide || origHeight > maxSide)) {
            if (origWidth >= origHeight) {
              targetW = maxSide;
              targetH = Math.round((maxSide / origWidth) * origHeight);
            } else {
              targetH = maxSide;
              targetW = Math.round((maxSide / origHeight) * origWidth);
            }
          }

          // Envoyer au worker
          const workerPromise = new Promise((resolveWorker, rejectWorker) => {
            const handler = (e) => {
              const { type, payload } = e.data;
              if (type === "result") {
                worker.removeEventListener("message", handler);
                resolveWorker(payload);
              } else if (type === "error") {
                worker.removeEventListener("message", handler);
                rejectWorker(new Error(payload.message));
              }
            };
            worker.addEventListener("message", handler);

            worker.postMessage({
              type: "process",
              payload: {
                buffer: arrayBuffer,
                options: {
                  quality,
                  targetW,
                  targetH,
                  exportWebP: true,
                  originalMime: file.type,
                  fileName: file.name,
                },
              },
            });
          });

          const workerResult = await workerPromise;

          resolve({
            originalBlob: blob,
            processedBlob: workerResult.previews.processed.blob,
            webpBlob: workerResult.previews.webp?.blob,
            meta: workerResult.meta,
          });

          URL.revokeObjectURL(url);
        };

        img.onerror = () => reject(new Error("Impossible de charger l'image"));
        img.src = url;
      } catch (err) {
        reject(err);
      }
    };
    reader.onerror = () => reject(new Error("Échec de lecture du fichier"));
    reader.readAsArrayBuffer(file);
  });
}

function updateBatchProgress() {
  const message = `Traitement en cours... ${batchState.current} / ${batchState.total} images`;
  announceStatus(message, true);
}

function displayBatchResults() {
  // Calcul du bilan global
  let totalOrigSize = 0;
  let totalOptSize = 0;
  let successCount = 0;

  batchState.results.forEach((result) => {
    if (result.status === "success") {
      successCount++;
      totalOrigSize += result.meta.original.size;
      // Meilleure version (processed ou webp)
      const procSize = result.meta.processed.size;
      const webpSize = result.webpBlob ? result.webpBlob.size : Infinity;
      totalOptSize += Math.min(procSize, webpSize);
    }
  });

  const saved = totalOrigSize - totalOptSize;
  const percent =
    totalOrigSize > 0 ? ((saved / totalOrigSize) * 100).toFixed(1) : 0;
  const co2 = ((saved / (1024 * 1024)) * 0.5).toFixed(2);

  // Mise à jour du bilan-panel avec les données du batch (inclut le bouton ZIP)
  updateBilanPanel({
    mode: "batch",
    totalOrigSize,
    totalOptSize,
    successCount,
    totalCount: batchState.total,
    co2Saved: co2,
  });

  // Génération de la liste des images dans compareInner (liste ordonnée)
  compareInner.innerHTML = "";
  compareInner.removeAttribute("data-layout");
  compareInner.removeAttribute("data-gap");
  compareInner.style.setProperty("--col-min-size", "");

  const ol = document.createElement("ol");
  ol.className = "field-group batch-list";

  batchState.results.forEach((result, index) => {
    const item = createBatchResultItem(result, index);
    ol.appendChild(item);
  });

  compareInner.appendChild(ol);
}

function createBatchResultItem(result, index) {
  // Création d'un élément de liste
  const li = document.createElement("li");
  li.className = "batch-item";
  li.dataset.status = result.status;
  li.setAttribute("data-layout", "repel");

  if (result.status === "success") {
    // Déterminer la version à afficher selon le choix de l'utilisateur
    const chosenFormat = document.querySelector('input[name="format"]:checked');
    const formatMode = chosenFormat ? chosenFormat.value : "processed";

    let displaySize, displayFormat, displayBlob;
    if (formatMode === "webp" && result.webpBlob) {
      displaySize = result.webpBlob.size;
      displayBlob = result.webpBlob;
      displayFormat = "WebP";
    } else {
      displaySize = result.meta.processed.size;
      displayBlob = result.processedBlob;
      displayFormat =
        result.meta.processed.mime.split("/")[1]?.toUpperCase() || "JPEG";
    }

    const saved = result.meta.original.size - displaySize;
    const percent =
      result.meta.original.size > 0
        ? ((saved / result.meta.original.size) * 100).toFixed(1)
        : 0;

    // Contenu du li (réutilise repel layout)
    li.innerHTML = `
      <span class="proc-title">
        <strong>${escapeHtml(result.fileName)}</strong>
      </span>
      <span class="proc-values" data-layout="cluster" data-gap="xs">
        <span class="pill">${formatBytes(
          result.meta.original.size
        )} → ${formatBytes(displaySize)}</span>
        <span class="pill ${saved > 0 ? "gain-positive" : "gain-negative"}">${
      saved > 0 ? "-" : "+"
    }${Math.abs(percent).toFixed(1)}%</span>
      </span>
    `;
  } else {
    // Erreur : affichage simplifié
    li.innerHTML = `
      <span class="proc-title">
        <strong>⚠️ ${escapeHtml(result.fileName)}</strong>
        <small class="error-text">${escapeHtml(
          result.error || "Erreur inconnue"
        )}</small>
      </span>
    `;
    li.classList.add("batch-error");
  }

  return li;
}

// Fonction pour attacher le gestionnaire de téléchargement ZIP
function attachZipDownloadHandler() {
  const btnZip = document.getElementById("btnDownloadZip");
  if (!btnZip) return;

  btnZip.addEventListener("click", async (e) => {
    e.preventDefault();

    if (typeof JSZip === "undefined") {
      alert("JSZip n'est pas chargé. Impossible de créer le ZIP.");
      return;
    }

    // Désactiver le lien pendant la génération
    btnZip.style.pointerEvents = "none";
    btnZip.style.opacity = "0.6";
    btnZip.textContent = "Génération du ZIP...";

    try {
      const zip = new JSZip();
      const folder = zip.folder("quetsche-export");

      // Déterminer le format sélectionné
      const chosenFormat = document.querySelector(
        'input[name="format"]:checked'
      );
      const formatMode = chosenFormat ? chosenFormat.value : "processed";

      // Ajouter uniquement les images selon le format sélectionné
      batchState.results.forEach((result) => {
        if (result.status === "success") {
          const baseName = result.fileName.replace(/\.[^.]+$/, "");

          // Ajouter le fichier selon le format choisi
          if (formatMode === "webp" && result.webpBlob) {
            // Mode WebP : ajouter uniquement le fichier WebP
            folder.file(`${baseName}.webp`, result.webpBlob);
          } else {
            // Mode processed : ajouter uniquement le fichier compressé (JPEG/PNG/GIF)
            const procExt = result.meta.processed.mime.split("/")[1] || "jpg";
            folder.file(`${baseName}.${procExt}`, result.processedBlob);
          }
        }
      });

      // Générer le ZIP
      const blob = await zip.generateAsync({ type: "blob" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `quetsche-batch-${Date.now()}.zip`;
      a.click();
      URL.revokeObjectURL(url);

      // Réactiver le lien
      btnZip.style.pointerEvents = "";
      btnZip.style.opacity = "";
      btnZip.textContent = "Télécharger tout (ZIP)";
    } catch (error) {
      alert("Erreur lors de la génération du ZIP : " + error.message);
      // Réactiver le lien en cas d'erreur
      btnZip.style.pointerEvents = "";
      btnZip.style.opacity = "";
      btnZip.textContent = "Télécharger tout (ZIP)";
    }
  });
}

// Retraiter toutes les images batch avec les nouveaux réglages
async function reprocessBatch() {
  announceStatus(`Retraitement de ${batchState.total} images...`, true);

  // Récupérer les blobs originaux pour retraiter
  const originalFiles = batchState.results.map((result, index) => ({
    blob: result.originalBlob,
    name: result.fileName,
    index,
  }));

  // Réinitialiser les résultats
  batchState.results = [];
  batchState.current = 0;

  // Retraiter chaque image
  for (let i = 0; i < originalFiles.length; i++) {
    const { blob, name } = originalFiles[i];
    batchState.current = i + 1;
    updateBatchProgress();

    try {
      // Créer un File à partir du blob
      const file = new File([blob], name, { type: blob.type });
      const result = await processSingleImageForBatch(file);
      batchState.results.push({
        fileName: name,
        status: "success",
        originalBlob: blob,
        processedBlob: result.processedBlob,
        webpBlob: result.webpBlob,
        meta: result.meta,
      });
    } catch (error) {
      batchState.results.push({
        fileName: name,
        status: "error",
        error: error.message || "Échec du traitement",
      });
    }
  }

  // Réafficher les résultats
  displayBatchResults();
  announceStatus(
    `✓ ${
      batchState.results.filter((r) => r.status === "success").length
    } images retraitées`,
    false,
    true
  );
}

// Mettre à jour l'affichage des images batch selon le format sélectionné
function updateBatchDisplay() {
  const chosen = document.querySelector('input[name="format"]:checked');
  const mode = chosen ? chosen.value : "processed";

  // Parcourir tous les éléments de liste batch pour mettre à jour les pills
  const items = compareInner.querySelectorAll(".batch-item");
  items.forEach((item, index) => {
    const result = batchState.results[index];
    if (!result || result.status !== "success") return;

    // Sélectionner le blob selon le choix de l'utilisateur
    let displayBlob;
    if (mode === "webp" && result.webpBlob) {
      displayBlob = result.webpBlob;
    } else {
      displayBlob = result.processedBlob;
    }

    // Mettre à jour les valeurs (pills) selon le format choisi
    const displaySize = displayBlob.size;
    const saved = result.meta.original.size - displaySize;
    const percent =
      result.meta.original.size > 0
        ? ((saved / result.meta.original.size) * 100).toFixed(1)
        : 0;

    const pills = item.querySelectorAll(".proc-values .pill");
    if (pills.length >= 2) {
      // Premier pill : taille original → taille optimisée (dynamique)
      pills[0].textContent = `${formatBytes(
        result.meta.original.size
      )} → ${formatBytes(displaySize)}`;
      // Deuxième pill : pourcentage de gain
      pills[1].textContent = `${saved > 0 ? "-" : "+"}${Math.abs(
        percent
      ).toFixed(1)}%`;
      pills[1].className = `pill ${
        saved > 0 ? "gain-positive" : "gain-negative"
      }`;
    }
  });

  // Recalculer et mettre à jour le bilan global
  let totalOrigSize = 0;
  let totalOptSize = 0;
  let successCount = 0;

  batchState.results.forEach((result) => {
    if (result.status === "success") {
      successCount++;
      totalOrigSize += result.meta.original.size;

      // Taille selon le format choisi
      let chosenSize;
      if (mode === "webp" && result.webpBlob) {
        chosenSize = result.webpBlob.size;
      } else {
        chosenSize = result.processedBlob.size;
      }
      totalOptSize += chosenSize;
    }
  });

  const saved = totalOrigSize - totalOptSize;
  const percent =
    totalOrigSize > 0 ? ((saved / totalOrigSize) * 100).toFixed(1) : 0;
  const co2 = ((saved / (1024 * 1024)) * 0.5).toFixed(2);

  updateBilanPanel({
    mode: "batch",
    totalOrigSize,
    totalOptSize,
    successCount,
    totalCount: batchState.total,
    co2Saved: co2,
  });
}

// Gestion des événements batch
if (false) {
  // Désactivé car btnCancelBatch n'existe plus
  const btnCancelBatch = null;
  btnCancelBatch.addEventListener("click", () => {
    batchState.cancelled = true;
    btnCancelBatch.disabled = true;
    btnCancelBatch.textContent = "Annulation...";
  });
}

/* ========== FIN MODE BATCH ========== */

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
          // En mode batch, mettre à jour l'affichage des images
          if (batchState.active && batchState.results.length > 0) {
            updateBatchDisplay();
          } else {
            updateBilanPanel();
          }
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
  // Charger aussi l'image originale pour le swap
  const origPreview = document.querySelector(".orig-preview");
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
  if (compressResults) compressResults.hidden = false;
  announceStatus("Compression effectuée", false, true);
  updateBilanPanel();
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
  // Fusionner original → optimisé dans le premier pill
  procSize.textContent = `${formatBytes(
    currentMeta.original.size
  )} → ${formatBytes(blob.size)}`;
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

function updateBilanPanel(data) {
  if (!bilanContent) return;

  if (data && data.mode === "batch") {
    // Mode batch : plusieurs images
    const { totalOrigSize, totalOptSize, successCount, totalCount, co2Saved } =
      data;
    const saved = totalOrigSize - totalOptSize;
    const percent =
      totalOrigSize > 0 ? ((saved / totalOrigSize) * 100).toFixed(1) : 0;
    const isGain = saved > 0;

    const html = `
      <ul class="bilan-list" role="list">
        <li><strong>${successCount} / ${totalCount}</strong> images traitées avec succès</li>
        <li>Poids total original : <span class="bilan-val">${formatBytes(
          totalOrigSize
        )}</span></li>
        <li>Poids total optimisé : <span class="bilan-val">${formatBytes(
          totalOptSize
        )}</span></li>
        <li>Octets économisés : <span class="bilan-val">${formatBytes(
          Math.abs(saved)
        )}</span></li>
        <li>Gain : <span class="bilan-gain${isGain ? "" : " is-negative"}">${
      isGain ? "-" : "+"
    }${Math.abs(percent)}%</span></li>
        <li>Réduction CO₂ estimée : <span class="bilan-val">${co2Saved} g</span></li>
      </ul>
      <p class="metrics-note bilan-note"><small>Estimation CO₂ (~0,5 g / Mo transféré) source indicative : <a href="https://www.websitecarbon.com/" target="_blank" rel="noopener noreferrer">Website Carbon</a></small></p>
      <span class="inline-download-wrapper"></span>
    `;
    bilanContent.innerHTML = html;
    bilanContent.dataset.state = "ready";

    // Injecter le lien de téléchargement ZIP après l'injection HTML
    const wrapper = bilanContent.querySelector(".inline-download-wrapper");
    if (wrapper) {
      const link = document.createElement("a");
      link.className = "inline-download";
      link.href = "#";
      link.id = "btnDownloadZip";
      link.textContent = "Télécharger tout (ZIP)";
      link.setAttribute("aria-label", "Télécharger toutes les images en ZIP");
      wrapper.appendChild(link);
    }

    // Réattacher le gestionnaire du bouton ZIP
    attachZipDownloadHandler();
  } else {
    // Mode simple : une seule image (ancien updateBilan)
    if (!currentMeta || !currentPreviews) return;
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
    if (origBytes > 0)
      pctRaw = ((origBytes - chosenSizeBytes) / origBytes) * 100; // >0 si gain
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
    const bytesLabel = isHeavier
      ? "Octets supplémentaires"
      : "Octets économisés";
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

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
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
      // Assure les attributs data sur la figure existante
      existingFigure.setAttribute("data-layout", "stack");
      existingFigure.setAttribute("data-gap", "xs");
    }
    return;
  }
  compareInner.innerHTML = "";
  const figProcessed = document.createElement("figure");
  figProcessed.className = "figure figure-processed";
  // Ajout des attributs de layout demandés
  figProcessed.setAttribute("data-layout", "stack");
  figProcessed.setAttribute("data-gap", "xs");
  figProcessed.innerHTML = `
  <figcaption data-layout=\"repel\">
  <span class=\"proc-title\">Image optimisée</span>
  <span class=\"proc-values\" data-layout=\"cluster\" data-gap=\"xs\">
    <span class=\"proc-dim visually-hidden\"></span>
    <span class=\"proc-size pill\"></span>
    <span class=\"proc-gain gain pill\"></span>
  </span>
  <span class=\"inline-download-wrapper\"></span>
  </figcaption>
  <div class=\"image-compare\">
    <img class=\"proc-preview\" alt=\"Aperçu image compressée\" />
    <img class=\"orig-preview\" alt=\"Image originale\" style=\"display: none;\" />
    <button class=\"swap-button\" type=\"button\" aria-pressed=\"false\" aria-live=\"polite\">Voir l'image originale</button>
  </div>`;
  compareInner.appendChild(figProcessed);
  procPreview = figProcessed.querySelector(".proc-preview");
  const origPreview = figProcessed.querySelector(".orig-preview");
  const swapButton = figProcessed.querySelector(".swap-button");
  const procTitle = figProcessed.querySelector(".proc-title");
  procDim = figProcessed.querySelector(".proc-dim");
  procSize = figProcessed.querySelector(".proc-size");
  procGain = figProcessed.querySelector(".proc-gain");

  // Gestion du swap entre image compressée et originale
  let showingOriginal = false;
  swapButton.addEventListener("click", () => {
    showingOriginal = !showingOriginal;
    if (showingOriginal) {
      procPreview.style.display = "none";
      origPreview.style.display = "block";
      procTitle.textContent = "Image originale";
      swapButton.textContent = "Voir l'image compressée";
      swapButton.setAttribute("aria-pressed", "true");
    } else {
      procPreview.style.display = "block";
      origPreview.style.display = "none";
      procTitle.textContent = "Image optimisée";
      swapButton.textContent = "Voir l'image originale";
      swapButton.setAttribute("aria-pressed", "false");
    }
  });

  compareInner.dataset.built = "true";
  compareInner.style.display = "";
}
