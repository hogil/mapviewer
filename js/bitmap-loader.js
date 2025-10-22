(() => {
    const WORKER_PATH = '/js/bitmap-worker.js';
    const MAX_WORKERS = Math.min(4, (typeof navigator !== 'undefined' && navigator.hardwareConcurrency) || 4);
    const workers = [];
    let workerIndex = 0;
    let requestId = 0;
    const pending = new Map();

    function ensureWorkers() {
        if (workers.length) {
            return;
        }
        const desired = Math.max(1, MAX_WORKERS);
        try {
            for (let i = 0; i < desired; i++) {
                const worker = new Worker(WORKER_PATH);
                worker.onmessage = (event) => {
                    const { id, bitmap, error } = event.data || {};
                    if (!id) {
                        return;
                    }
                    const resolver = pending.get(id);
                    if (!resolver) {
                        return;
                    }
                    pending.delete(id);
                    if (error) {
                        resolver.reject(new Error(error));
                    } else {
                        resolver.resolve(bitmap);
                    }
                };
                worker.onerror = (event) => {
                    pending.forEach(({ reject }) => reject(event.error || new Error('Bitmap worker failed')));
                    pending.clear();
                };
                workers.push(worker);
            }
        } catch (error) {
            workers.length = 0;
        }
    }

    function decodeWithWorkerBuffer(buffer, type, options) {
        ensureWorkers();
        if (!workers.length) {
            throw new Error('worker_unavailable');
        }
        const worker = workers[workerIndex];
        workerIndex = (workerIndex + 1) % workers.length;
        const id = ++requestId;
        let transferable;
        if (buffer instanceof ArrayBuffer) {
            transferable = buffer;
        } else if (ArrayBuffer.isView(buffer) && buffer.buffer) {
            if (buffer.byteOffset === 0 && buffer.byteLength === buffer.buffer.byteLength) {
                transferable = buffer.buffer;
            } else {
                transferable = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
            }
        } else {
            transferable = buffer;
        }
        return new Promise((resolve, reject) => {
            pending.set(id, { resolve, reject });
            try {
                worker.postMessage(
                    {
                        id,
                        buffer: transferable,
                        type: type || 'image/jpeg',
                        options: options || null
                    },
                    [transferable]
                );
            } catch (error) {
                pending.delete(id);
                reject(error);
            }
        });
    }

    async function decodeBitmap(source, options) {
        const opts = options || undefined;

        if (source && typeof source === 'object' && 'buffer' in source && source.buffer) {
            try {
                return await decodeWithWorkerBuffer(source.buffer, source.type || 'image/jpeg', opts);
            } catch (error) {
                console.warn('[BitmapLoader] worker decode failed, fallback to main thread', error);
                const blob = new Blob([source.buffer], { type: source.type || 'image/jpeg' });
                if (typeof createImageBitmap === 'function') {
                    return await createImageBitmap(blob, opts);
                }
                throw error;
            }
        }

        if (source instanceof ArrayBuffer || ArrayBuffer.isView(source)) {
            try {
                return await decodeWithWorkerBuffer(source instanceof ArrayBuffer ? source : source.buffer, 'image/jpeg', opts);
            } catch (error) {
                console.warn('[BitmapLoader] worker decode failed, fallback to main thread', error);
                const blob = new Blob([source], { type: 'image/jpeg' });
                if (typeof createImageBitmap === 'function') {
                    return await createImageBitmap(blob, opts);
                }
                throw error;
            }
        }

        if (source instanceof Blob) {
            try {
                const buffer = await source.arrayBuffer();
                return await decodeWithWorkerBuffer(buffer, source.type || 'image/png', opts);
            } catch (error) {
                console.warn('[BitmapLoader] worker decode failed, fallback to main thread', error);
            }
        }

        if (typeof createImageBitmap === 'function') {
            return await createImageBitmap(source, opts);
        }
        if (source instanceof HTMLCanvasElement) {
            const canvas = new OffscreenCanvas(source.width, source.height);
            const ctx = canvas.getContext('2d');
            ctx.drawImage(source, 0, 0);
            return canvas.transferToImageBitmap();
        }
        throw new Error('Decoding not supported for this source');
    }

    window.BitmapLoader = {
        decode: decodeBitmap
    };
})();
