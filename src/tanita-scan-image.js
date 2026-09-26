function loadImage(url) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error('The selected photo could not be opened.'));
    image.src = url;
  });
}

async function imageFileToCanvas(file) {
  const url = URL.createObjectURL(file);
  try {
    const image = await loadImage(url);
    const width = image.naturalWidth || image.width;
    const height = image.naturalHeight || image.height;
    if (!width || !height) {
      throw new Error('The selected photo has no readable image size.');
    }

    // Keep camera detail while avoiding pathological memory usage.
    // Current iPhone reference photos land just below this cap.
    const maxPixels = 26000000;
    const scale = Math.min(1, Math.sqrt(maxPixels / (width * height)));

    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(width * scale));
    canvas.height = Math.max(1, Math.round(height * scale));

    const context = canvas.getContext('2d', {
      alpha: false,
      willReadFrequently: true,
    });
    context.fillStyle = '#fff';
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    return canvas;
  } finally {
    URL.revokeObjectURL(url);
  }
}

function rotateCanvas180(source) {
  const canvas = document.createElement('canvas');
  canvas.width = source.width;
  canvas.height = source.height;
  const context = canvas.getContext('2d', { alpha: false });
  context.translate(canvas.width, canvas.height);
  context.rotate(Math.PI);
  context.drawImage(source, 0, 0);
  return canvas;
}

function cropCanvas(source, startRatio, endRatio, rotate = false) {
  const top = Math.max(0, Math.floor(source.height * startRatio));
  const bottom = Math.min(source.height, Math.ceil(source.height * endRatio));
  const crop = document.createElement('canvas');
  crop.width = source.width;
  crop.height = Math.max(1, bottom - top);
  crop.getContext('2d', { alpha: false }).drawImage(
    source,
    0,
    top,
    source.width,
    crop.height,
    0,
    0,
    source.width,
    crop.height,
  );
  return rotate ? rotateCanvas180(crop) : crop;
}

function copyCanvas(source, target, maxWidth = source.width) {
  const scale = Math.min(1, maxWidth / source.width);
  target.width = Math.max(1, Math.round(source.width * scale));
  target.height = Math.max(1, Math.round(source.height * scale));
  target.getContext('2d', { alpha: false }).drawImage(
    source,
    0,
    0,
    target.width,
    target.height,
  );
}

export {
  imageFileToCanvas,
  rotateCanvas180,
  cropCanvas,
  copyCanvas,
};
