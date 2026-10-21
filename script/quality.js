/* ============================================================================
 * Image preparation and measurement.
 *
 * Everything here is measured from the actual pixels — nothing is assumed.
 * The quality thresholds live in Core.QUALITY_LIMITS so they can be tested.
 * ========================================================================== */

const ImageQuality = (() => {
  const WORK_MAX = 512;      // analysis resolution
  const UPLOAD_MAX = 1280;   // stored resolution

  function loadImage(file) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('That file is not a readable image.')); };
      img.src = url;
    });
  }

  function drawScaled(img, maxEdge) {
    const scale = Math.min(1, maxEdge / Math.max(img.naturalWidth, img.naturalHeight));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(img.naturalWidth * scale));
    canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    return canvas;
  }

  /**
   * Single pass over the pixels. Returns luminance, clipping, focus (variance of
   * Laplacian) and texture density, plus the vegetation signals the crop gate
   * needs — so the browser only touches the pixel buffer once.
   */
  function measure(canvas) {
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    const { width: w, height: h } = canvas;
    const data = ctx.getImageData(0, 0, w, h).data;
    const total = w * h;

    const luma = new Float32Array(total);
    let sum = 0;
    let bright = 0;

    for (let i = 0, p = 0; i < total; i++, p += 4) {
      const r = data[p], g = data[p + 1], b = data[p + 2];
      const y = 0.299 * r + 0.587 * g + 0.114 * b;
      luma[i] = y;
      sum += y;
      if (y > 245) bright++;
    }

    const mean = sum / total;
    const brightRatio = bright / total;

    // Variance of the 4-neighbour Laplacian: low variance = out of focus.
    let lapSum = 0;
    let lapSqSum = 0;
    let lapN = 0;
    for (let y = 1; y < h - 1; y++) {
      for (let x = 1; x < w - 1; x++) {
        const i = y * w + x;
        const v = 4 * luma[i] - luma[i - 1] - luma[i + 1] - luma[i - w] - luma[i + w];
        lapSum += v;
        lapSqSum += v * v;
        lapN++;
      }
    }
    const lapMean = lapN ? lapSum / lapN : 0;
    const laplacianVar = lapN ? lapSqSum / lapN - lapMean * lapMean : 0;

    // Vegetation + texture in the same pass.
    const x0 = Math.floor(w * 0.25), x1 = Math.ceil(w * 0.75);
    const y0 = Math.floor(h * 0.25), y1 = Math.ceil(h * 0.75);
    let veg = 0, vegCenter = 0, centerTotal = 0, greenHue = 0, edges = 0;

    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const p = (y * w + x) * 4;
        const r = data[p], g = data[p + 1], b = data[p + 2];

        const exg = 2 * g - r - b;
        const max = Math.max(r, g, b);
        const min = Math.min(r, g, b);
        const sat = max === 0 ? 0 : (max - min) / max;

        const isVeg = exg > 20 && sat > 0.15;
        if (isVeg) {
          veg++;
          if (x >= x0 && x < x1 && y >= y0 && y < y1) vegCenter++;
        }
        if (x >= x0 && x < x1 && y >= y0 && y < y1) centerTotal++;

        // Hue in the green band, using the standard HSV formula.
        if (max > 30 && sat > 0.2) {
          let hue = 0;
          const d = max - min;
          if (max === r) hue = ((g - b) / d) % 6;
          else if (max === g) hue = (b - r) / d + 2;
          else hue = (r - g) / d + 4;
          hue *= 60;
          if (hue < 0) hue += 360;
          if (hue >= 60 && hue <= 180) greenHue++;
        }

        // Sobel-lite gradient magnitude on luminance.
        if (x > 0 && y > 0 && x < w - 1 && y < h - 1) {
          const i = y * w + x;
          const gx = Math.abs(luma[i + 1] - luma[i - 1]);
          const gy = Math.abs(luma[i + w] - luma[i - w]);
          if (gx + gy > 32) edges++;
        }
      }
    }

    return {
      width: w,
      height: h,
      mean: round(mean, 2),
      brightRatio: round(brightRatio, 4),
      laplacianVar: round(laplacianVar, 2),
      edgeDensity: round(edges / total, 4),
      veg: round(veg / total, 4),
      centerVeg: round(centerTotal ? vegCenter / centerTotal : 0, 4),
      greenHue: round(greenHue / total, 4),
    };
  }

  function round(v, d) {
    const f = Math.pow(10, d);
    return Math.round(v * f) / f;
  }

  /** Prepare an upload-ready canvas plus the analysis canvas. */
  async function prepare(file) {
    if (!file) throw new Error('No photo selected.');
    if (!/^image\//.test(file.type)) throw new Error('Please choose an image file.');
    if (file.size > APP.maxUploadBytes) {
      throw new Error(`That photo is ${(file.size / 1048576).toFixed(1)} MB. The limit is ${APP.maxUploadBytes / 1048576} MB.`);
    }

    const img = await loadImage(file);
    if (img.naturalWidth < 240 || img.naturalHeight < 240) {
      throw new Error('That photo is too small to analyse. Move closer or use a higher resolution camera.');
    }

    const analysis = drawScaled(img, WORK_MAX);
    const upload = drawScaled(img, UPLOAD_MAX);

    return { analysis, upload, img };
  }

  function toBlob(canvas, quality) {
    return new Promise((resolve) => {
      canvas.toBlob((blob) => resolve(blob), 'image/jpeg', quality || 0.86);
    });
  }

  return { prepare, measure, toBlob, drawScaled };
})();
