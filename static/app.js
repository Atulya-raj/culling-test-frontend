// ==========================================================================
// Celebrare Face Reco & Scoring Local Tester — Application Logic
// ==========================================================================

// Global fetch wrapper for seamless tunneling (ngrok / devtunnels)
const _origFetch = window.fetch;
window.fetch = function (url, options = {}) {
  options.headers = options.headers || {};
  if (options.headers instanceof Headers) {
    options.headers.set('ngrok-skip-browser-warning', 'true');
  } else {
    options.headers['ngrok-skip-browser-warning'] = 'true';
  }
  return _origFetch(url, options);
};

document.addEventListener('DOMContentLoaded', () => {
  // DOM Elements
  const videoFeed = document.getElementById('videoFeed');
  const captureCanvas = document.getElementById('captureCanvas');
  const reticleOverlay = document.getElementById('reticleOverlay');
  const cameraStatus = document.getElementById('cameraStatus');
  const cameraBtnText = document.getElementById('cameraBtnText');
  const btnToggleCamera = document.getElementById('btnToggleCamera');
  const btnScan = document.getElementById('btnScan');
  const btnUploadToggle = document.getElementById('btnUploadToggle');
  const fileInput = document.getElementById('fileInput');
  const dropzone = document.getElementById('dropzone');

  // Stats & Diagnostics
  const statClusters = document.getElementById('statClusters');
  const statImages = document.getElementById('statImages');
  const diagnosticBox = document.getElementById('diagnosticBox');
  const alignedChipImg = document.getElementById('alignedChipImg');
  const diagClusterId = document.getElementById('diagClusterId');
  const diagSim = document.getElementById('diagSim');
  const diagCount = document.getElementById('diagCount');
  const confidenceBadge = document.getElementById('confidenceBadge');
  const clusterSelect = document.getElementById('clusterSelect');
  const btnLoadCluster = document.getElementById('btnLoadCluster');

  // Results State
  const emptyState = document.getElementById('emptyState');
  const loadingState = document.getElementById('loadingState');
  const resultsContent = document.getElementById('resultsContent');
  const summaryClusterTitle = document.getElementById('summaryClusterTitle');
  const summarySim = document.getElementById('summarySim');
  const summaryPhotoCount = document.getElementById('summaryPhotoCount');
  const summaryTopScore = document.getElementById('summaryTopScore');
  const filterChips = document.getElementById('filterChips');
  const galleryGrid = document.getElementById('galleryGrid');

  // Modal Lightbox
  const photoModal = document.getElementById('photoModal');
  const modalBackdrop = document.getElementById('modalBackdrop');
  const modalClose = document.getElementById('modalClose');
  const modalImg = document.getElementById('modalImg');
  const modalRank = document.getElementById('modalRank');
  const modalFilename = document.getElementById('modalFilename');
  const modalScore = document.getElementById('modalScore');
  const modalScoreFill = document.getElementById('modalScoreFill');
  const modalTag = document.getElementById('modalTag');
  const modalPath = document.getElementById('modalPath');
  const modalPrev = document.getElementById('modalPrev');
  const modalNext = document.getElementById('modalNext');

  // Application State
  let stream = null;
  let isCameraActive = false;
  let isUploadMode = false;
  let uploadedImageBase64 = null;
  let currentPhotos = [];
  let currentFilter = 'ALL';
  let activeModalIndex = -1;

  // -------------------------------------------------------------
  // 1. Initialize API Stats & Clusters
  // -------------------------------------------------------------
  async function loadInitialData() {
    try {
      const statsRes = await fetch('/api/stats');
      if (statsRes.ok) {
        const stats = await statsRes.json();
        statClusters.textContent = stats.total_clusters !== undefined ? stats.total_clusters : '--';
        statImages.textContent = stats.total_images !== undefined ? stats.total_images : '--';
      }

      const clustersRes = await fetch('/api/clusters');
      if (clustersRes.ok) {
        const data = await clustersRes.json();
        const clusters = data.clusters || [];
        clusterSelect.innerHTML = '<option value="">-- Choose a person cluster --</option>';
        clusters.forEach(c => {
          const opt = document.createElement('option');
          opt.value = c.cluster_id;
          opt.textContent = `Cluster #${c.cluster_id} (${c.photo_count} photos, Top Score: ${c.top_score.toFixed(5)})`;
          clusterSelect.appendChild(opt);
        });
      }
    } catch (err) {
      console.warn("Could not load backend stats:", err);
    }
  }

  loadInitialData();

  // -------------------------------------------------------------
  // 2. Camera Controls
  // -------------------------------------------------------------
  async function startCamera() {
    try {
      if (stream) {
        stopCamera();
      }
      stream = await navigator.mediaDevices.getUserMedia({
        video: {
          width: { ideal: 1280 },
          height: { ideal: 720 },
          facingMode: 'user'
        },
        audio: false
      });
      videoFeed.srcObject = stream;
      await videoFeed.play();
      isCameraActive = true;
      cameraStatus.textContent = '● Live Camera Active';
      cameraStatus.className = 'status-pill active';
      cameraBtnText.textContent = 'Stop Camera';
      dropzone.classList.remove('active');
      isUploadMode = false;
    } catch (err) {
      console.error("Camera access error:", err);
      alert("Unable to access camera: " + err.message + "\n\nYou can use 'Upload Photo' to test images directly.");
      enableUploadMode();
    }
  }

  function stopCamera() {
    if (stream) {
      stream.getTracks().forEach(track => track.stop());
      stream = null;
    }
    videoFeed.srcObject = null;
    isCameraActive = false;
    cameraStatus.textContent = 'Camera Idle';
    cameraStatus.className = 'status-pill';
    cameraBtnText.textContent = 'Start Camera';
  }

  btnToggleCamera.addEventListener('click', () => {
    if (isCameraActive) {
      stopCamera();
    } else {
      startCamera();
    }
  });

  // -------------------------------------------------------------
  // 3. Upload Photo Fallback & Drag-and-Drop
  // -------------------------------------------------------------
  function enableUploadMode() {
    stopCamera();
    isUploadMode = true;
    dropzone.classList.add('active');
    cameraStatus.textContent = 'Upload Mode';
    cameraStatus.className = 'status-pill';
  }

  btnUploadToggle.addEventListener('click', () => {
    if (isUploadMode) {
      dropzone.classList.remove('active');
      isUploadMode = false;
      startCamera();
    } else {
      enableUploadMode();
    }
  });

  dropzone.addEventListener('click', () => {
    fileInput.click();
  });

  fileInput.addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (file) handleImageFile(file);
  });

  dropzone.addEventListener('dragover', (e) => {
    e.preventDefault();
    dropzone.style.borderColor = '#0ea5e9';
  });

  dropzone.addEventListener('dragleave', () => {
    dropzone.style.borderColor = '';
  });

  dropzone.addEventListener('drop', (e) => {
    e.preventDefault();
    dropzone.style.borderColor = '';
    if (e.dataTransfer.files && e.dataTransfer.files[0]) {
      handleImageFile(e.dataTransfer.files[0]);
    }
  });

  function handleImageFile(file) {
    const reader = new FileReader();
    reader.onload = (event) => {
      uploadedImageBase64 = event.target.result;
      dropzone.innerHTML = `
        <div class="dropzone-content">
          <img src="${uploadedImageBase64}" style="max-height: 180px; border-radius: 8px; margin-bottom: 8px; border: 2px solid #0ea5e9;" />
          <p style="color: #10b981;">✓ Photo Loaded: ${file.name}</p>
          <span>Click to choose another photo or tap SCAN</span>
        </div>
      `;
    };
    reader.readAsDataURL(file);
  }

  // -------------------------------------------------------------
  // 4. Capture & Scan Face
  // -------------------------------------------------------------
  btnScan.addEventListener('click', async () => {
    let payloadImage = null;

    if (isUploadMode && uploadedImageBase64) {
      payloadImage = uploadedImageBase64;
    } else if (isCameraActive && videoFeed.videoWidth > 0) {
      captureCanvas.width = videoFeed.videoWidth;
      captureCanvas.height = videoFeed.videoHeight;
      const ctx = captureCanvas.getContext('2d');
      // Draw mirrored video directly so orientation matches user expectation
      ctx.drawImage(videoFeed, 0, 0, captureCanvas.width, captureCanvas.height);
      payloadImage = captureCanvas.toDataURL('image/jpeg', 0.95);
    } else {
      // Auto-start camera if idle
      await startCamera();
      alert("Camera started! Please center your face in the oval guide and tap 'SCAN & GET MY IMAGES' again.");
      return;
    }

    // Trigger visual scanning laser animation
    reticleOverlay.classList.add('scanning');
    emptyState.style.display = 'none';
    resultsContent.style.display = 'none';
    loadingState.style.display = 'flex';

    try {
      const res = await fetch('/api/scan', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ image: payloadImage })
      });

      const data = await res.json();
      reticleOverlay.classList.remove('scanning');
      loadingState.style.display = 'none';

      if (!data.success) {
        alert(data.error || "Failed to scan face.");
        emptyState.style.display = 'flex';
        return;
      }

      // Update Diagnostics
      diagnosticBox.style.display = 'block';
      if (data.chip_preview) {
        alignedChipImg.src = data.chip_preview;
      }
      diagClusterId.textContent = `#${data.matched_cluster_id}`;
      diagSim.textContent = `${(data.similarity * 100).toFixed(1)}% (${data.similarity})`;
      diagCount.textContent = `${data.total_photos} photos`;
      confidenceBadge.textContent = `${data.confidence_level} Confidence`;
      confidenceBadge.className = `badge ${data.confidence_level.toLowerCase()}`;

      // Render matched cluster results
      renderResults(data);

    } catch (err) {
      reticleOverlay.classList.remove('scanning');
      loadingState.style.display = 'none';
      emptyState.style.display = 'flex';
      console.error("Scan error:", err);
      alert("Error sending scan to server: " + err.message);
    }
  });

  // Quick Direct Cluster Load
  btnLoadCluster.addEventListener('click', async () => {
    const clusterId = clusterSelect.value;
    if (!clusterId) {
      alert("Please select a cluster from the dropdown.");
      return;
    }

    emptyState.style.display = 'none';
    resultsContent.style.display = 'none';
    loadingState.style.display = 'flex';

    try {
      const res = await fetch(`/api/cluster/${clusterId}`);
      const data = await res.json();
      loadingState.style.display = 'none';

      if (data.error) {
        alert(data.error);
        emptyState.style.display = 'flex';
        return;
      }

      // Populate dummy similarity for manual selection
      data.matched_cluster_id = data.cluster_id;
      data.similarity_pct = 100.0;
      data.similarity = 1.0;
      data.top_score = data.photos[0] ? data.photos[0].score : 0.0;

      diagnosticBox.style.display = 'none';
      renderResults(data);
    } catch (err) {
      loadingState.style.display = 'none';
      emptyState.style.display = 'flex';
      alert("Error loading cluster: " + err.message);
    }
  });

  // Auto-load cluster on dropdown change
  clusterSelect.addEventListener('change', () => {
    if (clusterSelect.value) {
      btnLoadCluster.click();
    }
  });

  // Quick Demo button in Empty State
  const btnQuickDemo = document.getElementById('btnQuickDemo');
  if (btnQuickDemo) {
    btnQuickDemo.addEventListener('click', () => {
      clusterSelect.value = '1';
      btnLoadCluster.click();
    });
  }

  const btnReloadDb = document.getElementById('btnReloadDb');
  if (btnReloadDb) {
    btnReloadDb.addEventListener('click', async () => {
      btnReloadDb.disabled = true;
      btnReloadDb.textContent = '↻ Loading...';
      try {
        const res = await fetch('/api/reload', { method: 'POST' });
        const d = await res.json();
        if (d.success) {
          await loadInitialData();
          alert(`Database reloaded!\n\nClusters: ${d.total_clusters}\nImages: ${d.total_images}\nTags Loaded: ${d.has_tags ? 'Yes' : 'No'}`);
        } else {
          alert('Reload failed: ' + (d.error || 'Unknown error'));
        }
      } catch (e) {
        alert('Error connecting to reload endpoint: ' + e.message);
      } finally {
        btnReloadDb.disabled = false;
        btnReloadDb.textContent = '↻ Reload DB';
      }
    });
  }

  // -------------------------------------------------------------
  // 5. Render Results & Score-Sorted Gallery
  // -------------------------------------------------------------
  function renderResults(data) {
    currentPhotos = data.photos || [];
    currentFilter = 'ALL';

    // Summary Header
    summaryClusterTitle.textContent = `Cluster #${data.matched_cluster_id}`;
    summarySim.textContent = `${data.similarity_pct || (data.similarity * 100).toFixed(1)}%`;
    summaryPhotoCount.textContent = `${data.total_photos} Photos`;
    summaryTopScore.textContent = data.top_score ? data.top_score.toFixed(5) : '0.00000';

    // Update Filter Tag Counts
    const counts = {
      ALL: currentPhotos.length,
      BEST_IN_SCENE: 0,
      HERO: 0,
      CANDID: 0,
      BURST_DUPLICATE: 0,
      REJECT_BLUR: 0,
      REJECT_BLINK: 0
    };

    currentPhotos.forEach(p => {
      if (counts[p.culling_tag] !== undefined) {
        counts[p.culling_tag]++;
      }
    });

    document.getElementById('countAll').textContent = counts.ALL;
    document.getElementById('countBest').textContent = counts.BEST_IN_SCENE;
    document.getElementById('countHero').textContent = counts.HERO;
    document.getElementById('countCandid').textContent = counts.CANDID;
    document.getElementById('countBurst').textContent = counts.BURST_DUPLICATE;
    document.getElementById('countBlur').textContent = counts.REJECT_BLUR;
    document.getElementById('countBlink').textContent = counts.REJECT_BLINK;

    // Reset Active Filter Chip
    const chips = filterChips.querySelectorAll('.chip');
    chips.forEach(c => c.classList.remove('active'));
    chips[0].classList.add('active');

    // Render Cards
    renderPhotoGrid();
    resultsContent.style.display = 'block';
  }

  const TAG_DEFINITIONS = {
    BEST_IN_SCENE: {
      cls: 'tag-best',
      label: '👑 BEST IN SCENE',
      desc: 'Top-scoring frame for this person in multi-face shots (sharpest focus and best expression).'
    },
    HERO: {
      cls: 'tag-hero',
      label: '⭐ HERO',
      desc: 'Standout portrait with high aesthetic score (≥ 0.85), sharp focus, and open eyes.'
    },
    CANDID: {
      cls: 'tag-candid',
      label: '📸 CANDID',
      desc: 'High quality natural keeper meeting focus and expression standards (score ≥ 0.50).'
    },
    BURST_DUPLICATE: {
      cls: 'tag-burst',
      label: '📑 BURST DUP',
      desc: 'Near-identical consecutive shot in a burst sequence (demoted to avoid duplicate picks).'
    },
    REJECT_BLUR: {
      cls: 'tag-blur',
      label: '🌫️ BLUR',
      desc: 'Soft or out of focus with focus score below minimum threshold (< 3.0).'
    },
    REJECT_BLINK: {
      cls: 'tag-blink',
      label: '👁️ BLINK',
      desc: 'Subject caught blinking or with closed eyes (eye openness ≤ 0.35).'
    },
    UNCLASSIFIED: {
      cls: 'tag-unclassified',
      label: '⚪ UNCLASSIFIED',
      desc: 'Standard photo without a specific culling tag.'
    }
  };

  function getTagBadgeClass(tag) {
    if (TAG_DEFINITIONS[tag]) {
      return TAG_DEFINITIONS[tag];
    }
    return {
      cls: 'tag-burst',
      label: tag,
      desc: `Categorized under tag: ${tag}`
    };
  }

  function getScoreBadgeClass(score) {
    if (score >= 0.70) return 'score-badge';
    if (score >= 0.50) return 'score-badge medium';
    return 'score-badge low';
  }

  function renderPhotoGrid() {
    galleryGrid.innerHTML = '';

    const filtered = currentPhotos.filter(p => {
      if (currentFilter === 'ALL') return true;
      return p.culling_tag === currentFilter;
    });

    if (filtered.length === 0) {
      galleryGrid.innerHTML = `
        <div style="grid-column: 1 / -1; text-align: center; padding: 40px; color: #64748b;">
          No photos found under the selected filter tag.
        </div>
      `;
      return;
    }

    filtered.forEach((photo, index) => {
      const card = document.createElement('div');
      card.className = 'photo-card';

      const tagInfo = getTagBadgeClass(photo.culling_tag);
      const scoreCls = getScoreBadgeClass(photo.score);
      const isTop1 = photo.rank === 1 ? 'top-1' : '';

      card.innerHTML = `
        <div class="photo-img-wrap">
          <img src="${photo.thumb_url || photo.image_url}" alt="${photo.filename}" loading="lazy" />
          <span class="rank-badge ${isTop1}">#${photo.rank}</span>
          <span class="tag-badge-overlay ${tagInfo.cls}">${tagInfo.label}</span>
        </div>
        <div class="photo-card-body">
          <span class="photo-filename" title="${photo.filename}">${photo.filename}</span>
          <div class="score-row">
            <span class="${scoreCls}">
              <span>★</span> Score: ${photo.score.toFixed(5)}
            </span>
          </div>
          <div class="card-tag-desc" title="${tagInfo.desc}">
            ${tagInfo.desc}
          </div>
        </div>
      `;

      card.addEventListener('click', () => {
        const fullIndex = currentPhotos.findIndex(p => p.temp_id === photo.temp_id);
        openModal(fullIndex);
      });

      galleryGrid.appendChild(card);
    });
  }

  // -------------------------------------------------------------
  // 6. Culling Tag Filtering
  // -------------------------------------------------------------
  filterChips.addEventListener('click', (e) => {
    const chip = e.target.closest('.chip');
    if (!chip) return;

    filterChips.querySelectorAll('.chip').forEach(c => c.classList.remove('active'));
    chip.classList.add('active');

    currentFilter = chip.dataset.tag;
    const activeTagDesc = document.getElementById('activeTagDesc');
    if (activeTagDesc) {
      if (currentFilter === 'ALL') {
        activeTagDesc.textContent = "All Photos: Showing all images for this person cluster sorted strictly by quality score descending.";
      } else if (TAG_DEFINITIONS[currentFilter]) {
        activeTagDesc.innerHTML = `<strong>${TAG_DEFINITIONS[currentFilter].label}:</strong> ${TAG_DEFINITIONS[currentFilter].desc}`;
      }
    }
    renderPhotoGrid();
  });

  // -------------------------------------------------------------
  // 7. Lightbox Modal Navigation
  // -------------------------------------------------------------
  function openModal(index) {
    if (index < 0 || index >= currentPhotos.length) return;
    activeModalIndex = index;
    const photo = currentPhotos[index];

    modalImg.src = photo.image_url;
    modalRank.textContent = `#${photo.rank} Best Face Score`;
    modalFilename.textContent = photo.filename;
    modalScore.textContent = photo.score.toFixed(5);
    modalScoreFill.style.width = `${Math.min(100, Math.max(0, photo.score * 100))}%`;

    const tagInfo = getTagBadgeClass(photo.culling_tag);
    modalTag.textContent = tagInfo.label;
    modalTag.className = `modal-badge ${tagInfo.cls}`;

    const modalTagReason = document.getElementById('modalTagReason');
    if (modalTagReason) {
      modalTagReason.textContent = tagInfo.desc;
    }

    modalPath.textContent = photo.full_path || photo.temp_id;

    photoModal.classList.add('active');
  }

  function closeModal() {
    photoModal.classList.remove('active');
    activeModalIndex = -1;
  }

  modalClose.addEventListener('click', closeModal);
  modalBackdrop.addEventListener('click', closeModal);

  modalPrev.addEventListener('click', () => {
    if (activeModalIndex > 0) openModal(activeModalIndex - 1);
  });

  modalNext.addEventListener('click', () => {
    if (activeModalIndex < currentPhotos.length - 1) openModal(activeModalIndex + 1);
  });

  document.addEventListener('keydown', (e) => {
    if (!photoModal.classList.contains('active')) return;
    if (e.key === 'Escape') closeModal();
    if (e.key === 'ArrowLeft' && activeModalIndex > 0) openModal(activeModalIndex - 1);
    if (e.key === 'ArrowRight' && activeModalIndex < currentPhotos.length - 1) openModal(activeModalIndex + 1);
  });
});
