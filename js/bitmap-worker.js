// Bitmap decode worker
self.onmessage = async (event) => {
    const { id, buffer, type = 'image/png', options } = event.data || {};
    if (!id || !buffer) {
        self.postMessage({ id, error: 'invalid_payload' });
        return;
    }

    try {
        const blob = new Blob([buffer], { type });
        let bitmap;

        if (typeof createImageBitmap === 'function') {
            bitmap = await createImageBitmap(blob, options || undefined);
        } else if (typeof ImageDecoder === 'function') {
            const decoder = new ImageDecoder({ data: blob.stream(), type });
            const { image } = await decoder.decode();
            bitmap = image;
        } else {
            throw new Error('ImageBitmap decoding not supported');
        }

        self.postMessage({ id, bitmap }, bitmap ? [bitmap] : undefined);
    } catch (error) {
        self.postMessage({ id, error: error?.message || String(error) });
    }
};
