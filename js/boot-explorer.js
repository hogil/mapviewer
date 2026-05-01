const HOT_FOLDER = 'unknown';
const DEFAULT_SCHEME = 'notsaml';
const BOOT_GRID_LIMIT = 48;
const IDLE_IMPORT_DELAY_MS = 150;
const IDLE_IMPORT_TIMEOUT_MS = 200;
const INTERACTION_IMPORT_DELAY_MS = 150;

let fullViewerImportPromise = null;
let fullViewerImportTimer = null;
let fullViewerImportDueAt = 0;

function ensureBootPrefetch(key, url) {
    window.__prefetch = window.__prefetch || {};
    if (!window.__prefetch[key]) {
        window.__prefetch[key] = fetch(url).then((response) => (
            response.ok ? response.json() : null
        )).catch(() => null);
    }
}

function primeMainPrefetch() {
    ensureBootPrefetch('config', '/api/config');
    ensureBootPrefetch('rootFolder', '/api/root-folder');
    ensureBootPrefetch('currentFolder', '/api/current-folder');
    ensureBootPrefetch('browseFolders', '/api/browse-folders?path=&force_root=true');
}

function startFullViewerImport() {
    if (fullViewerImportTimer !== null) {
        window.clearTimeout(fullViewerImportTimer);
        fullViewerImportTimer = null;
        fullViewerImportDueAt = 0;
    }
    if (!fullViewerImportPromise) {
        primeMainPrefetch();
        fullViewerImportPromise = import('./main.js').catch((error) => {
            console.error('[boot-explorer] failed to import main viewer', error);
            throw error;
        });
        window.__l3MainImportPromise = fullViewerImportPromise;
    }
    return fullViewerImportPromise;
}

function scheduleFullViewerImport(delayMs = IDLE_IMPORT_DELAY_MS) {
    if (fullViewerImportPromise) return;

    const dueAt = Date.now() + Math.max(0, delayMs);
    if (fullViewerImportTimer !== null && dueAt >= fullViewerImportDueAt) {
        return;
    }

    if (fullViewerImportTimer !== null) {
        window.clearTimeout(fullViewerImportTimer);
    }

    fullViewerImportDueAt = dueAt;
    fullViewerImportTimer = window.setTimeout(() => {
        fullViewerImportTimer = null;
        fullViewerImportDueAt = 0;
        const kick = () => void startFullViewerImport();
        if ('requestIdleCallback' in window) {
            window.requestIdleCallback(kick, { timeout: IDLE_IMPORT_TIMEOUT_MS });
        } else {
            kick();
        }
    }, Math.max(0, delayMs));
}

function attachGlobalWarmTriggers() {
    const warmSoon = () => scheduleFullViewerImport(INTERACTION_IMPORT_DELAY_MS);
    window.addEventListener('pointerdown', warmSoon, { once: true, passive: true });
    window.addEventListener('keydown', warmSoon, { once: true });
}

function getExplorer() {
    return document.getElementById('file-explorer');
}

async function ensureFolderLoaded(folderPath, detailsElement, contentDiv) {
    if (!contentDiv || detailsElement?.dataset.loaded === 'true') return;
    const response = await fetch(`/api/files?path=${encodeURIComponent(folderPath)}`);
    if (!response.ok) throw new Error(`folder load failed: ${response.status}`);
    const data = await response.json();
    const items = Array.isArray(data?.items) ? data.items : [];
    const html = [
        '<ul>',
        ...items.map((item) => {
            if (item?.type === 'directory') {
                const fullPath = item.root_relative || item.name || '';
                return `<li><details><summary data-path="${fullPath}" class="folder">📁 ${item.name}</summary><div class="folder-content" style="padding-left: 0.5rem;"></div></details></li>`;
            }
            const fullPath = item?.root_relative || `${folderPath}/${item?.name || ''}`;
            return `<li><a href="#" data-path="${fullPath}" draggable="true">📄 ${item?.name || ''}</a></li>`;
        }),
        '</ul>',
    ].join('');
    contentDiv.innerHTML = html;
    detailsElement.dataset.loaded = 'true';
}

function renderBootGrid(files) {
    const grid = document.getElementById('image-grid');
    if (!grid) return;

    const renderTargets = files.slice(0, BOOT_GRID_LIMIT);
    grid.innerHTML = '';
    grid.style.display = 'grid';

    for (const path of renderTargets) {
        const wrapper = document.createElement('div');
        wrapper.className = 'grid-item selected';

        const img = document.createElement('img');
        img.className = 'grid-thumb-img';
        img.alt = path.split('/').pop() || path;
        img.dataset.gridLoaded = 'false';
        img.loading = 'eager';
        img.decoding = 'async';
        img.src = `/api/thumbnail?path=${encodeURIComponent(path)}&size=512&personalized=true&scheme=${DEFAULT_SCHEME}&_t=${Date.now()}`;
        img.addEventListener('load', () => {
            img.dataset.gridLoaded = 'true';
        }, { once: true });

        wrapper.appendChild(img);
        grid.appendChild(wrapper);
    }

    window.viewer = window.viewer || {};
    window.viewer.selectedImages = files.slice();
}

async function selectFolderToGrid(folderPath, detailsElement, contentDiv) {
    const response = await fetch(`/api/files/recursive?path=${encodeURIComponent(folderPath)}&limit=5000`);
    if (!response.ok) throw new Error(`folder recursive load failed: ${response.status}`);
    const data = await response.json();
    const files = Array.isArray(data?.files) ? data.files : [];
    if (contentDiv && detailsElement && detailsElement.dataset.loaded !== 'true') {
        try {
            await ensureFolderLoaded(folderPath, detailsElement, contentDiv);
        } catch (_) {}
    }
    renderBootGrid(files);
}

function attachBootExplorer() {
    const explorer = getExplorer();
    if (!explorer) return;

    explorer.addEventListener('click', async (event) => {
        if (window.__l3FullViewerReady) return;

        const summary = event.target instanceof Element ? event.target.closest('summary.folder') : null;
        if (!summary || !explorer.contains(summary)) return;

        const detailsElement = summary.parentElement;
        const contentDiv = summary.nextElementSibling;
        const folderPath = summary.dataset.path || '';
        if (!folderPath) return;

        if (event.ctrlKey || event.metaKey) {
            event.preventDefault();
            event.stopPropagation();
            try {
                await selectFolderToGrid(folderPath, detailsElement, contentDiv);
            } catch (error) {
                console.error('[boot-explorer] ctrl-select failed', error);
            }
            scheduleFullViewerImport(INTERACTION_IMPORT_DELAY_MS);
            return;
        }

        const isBootHydrated = detailsElement?.dataset.bootHydrated === 'true';
        if (!isBootHydrated && detailsElement && contentDiv && detailsElement.dataset.loaded !== 'true') {
            try {
                await ensureFolderLoaded(folderPath, detailsElement, contentDiv);
            } catch (error) {
                console.error('[boot-explorer] folder expand failed', error);
            }
        }

        scheduleFullViewerImport(INTERACTION_IMPORT_DELAY_MS);
    }, { capture: true });

    const hotSummary = explorer.querySelector(`summary.folder[data-path="${HOT_FOLDER}"]`);
    if (hotSummary) {
        scheduleFullViewerImport(IDLE_IMPORT_DELAY_MS);
    }
}

attachBootExplorer();
attachGlobalWarmTriggers();

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
        scheduleFullViewerImport(IDLE_IMPORT_DELAY_MS);
    }, { once: true });
} else {
    scheduleFullViewerImport(IDLE_IMPORT_DELAY_MS);
}
