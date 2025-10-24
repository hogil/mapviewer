# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

L3 Tracker is a semiconductor wafer map defect analysis system. It processes high-resolution images (up to 4000x4000 pixels) of semiconductor wafer maps and provides AI-based pattern classification for defect detection.

**Key Features:**
- High-performance image rendering using image pyramid technique
- SAML-based SSO authentication (OneLogin)
- FastAPI backend with HTTPS support
- Vanilla JavaScript frontend with no build step
- Thumbnail caching and optimization

## Environment Context

**Development Environment:** Windows 11 (for coding)
**Production Environment:** Ubuntu 24 (for testing and deployment)

The codebase uses environment variables to adapt to both environments. SAML login only works in the production Ubuntu environment with proper settings configured.

**Critical Rules from .cursor/rules/role.mdc:**
- Image quality settings must always be: Q=100 (quality) and Lanczos3 algorithm
- SAML configuration in `saml/settings.json` is sample data; production values are configured separately in Ubuntu
- Do not try to evaluate or test SAML features in the Windows development environment

## Running the Application

### Start the Server

**Windows:**
```cmd
python -m api.main
```

**Ubuntu:**
```bash
python -m api.main
```

The server runs HTTPS by default on port 8443 (configurable via `HTTPS_PORT` environment variable).

### Access the Application

Open browser and navigate to: `https://localhost:8443`

## Key Environment Variables

### Required
- `PROJECT_ROOT`: Root directory containing wafer map images (default: `/appdata/appuser/images`)
- `HTTPS_PORT`: HTTPS port number (default: `8443`)
- `SSL_CERTFILE`: Path to SSL certificate (default: `cert/fullchain.pem`)
- `SSL_KEYFILE`: Path to SSL private key (default: `cert/server.key`)

### Performance Tuning
- `UVICORN_WORKERS`: Number of worker processes (default: 75% of CPU cores, minimum 24, **recommended: 28 for 32-core servers**)
- `IO_THREADS`: I/O thread pool size (default: CPU count * 2, minimum 16, **recommended: 128 for high-load servers**)
- `THUMBNAIL_SEM`: Thumbnail generation concurrency limit (default: 128, **recommended: 256 for 32-core servers**)
- `DIRLIST_CACHE_SIZE`: Directory listing cache size (default: 1024, **recommended: 8192 for production**)
- `THUMB_STAT_CACHE_CAPACITY`: Thumbnail stat cache size (default: 8192, **recommended: 32768 for production**)
- `VIPS_CONCURRENCY`: libvips thread count (**must be 1 for web servers** to avoid thread conflicts)
- `VIPS_DISC_THRESHOLD`: Memory threshold before disk use (**recommended: 10000m for 198GB RAM servers**)
- `VIPS_MAX_CACHE`: libvips cache entries (**recommended: 10000 for high-performance servers**)
- `VIPS_MAX_CACHE_MEM`: libvips memory cache size (**recommended: 20000m for 198GB RAM servers**)
- `PYTHONUNBUFFERED`: Real-time log output (set to `1`)
- `MALLOC_ARENA_MAX`: Prevent memory fragmentation (set to `4`)

### Development
- `RELOAD`: Enable auto-reload on code changes (set to `1` for development, default: `0`)
- `DEV_SAML`: Enable development SAML mode (default: `0`)
- `AUTO_LOGIN`: Force automatic login redirect (default: disabled)

### Image Processing
- `THUMBNAIL_SIZE`: Thumbnail dimension (default: `512`)
- `THUMBNAIL_FORMAT`: Thumbnail format (default: `WEBP`)
- `THUMBNAIL_QUALITY`: Thumbnail quality (default: `100`)

See [ENVIRONMENT_SETUP.md](ENVIRONMENT_SETUP.md) for detailed environment variable configuration.

## Architecture Overview

### Backend (FastAPI + Python)

**Main Entry Point:** [api/main.py](api/main.py)

The backend uses FastAPI with Uvicorn for high-performance async operations. Key components:

- **ThumbnailService** ([api/thumbnail_service.py](api/thumbnail_service.py)): Generates and caches thumbnails using pyvips for performance
- **SAML Authentication**: OneLogin python3-saml integration for SSO (minimal SP implementation)
- **Access Logging**: Custom pretty-table logger with ANSI color support
- **Async Processing**: Background tasks for thumbnail generation and file indexing

**Key API Endpoints:**
```
GET  /api/files             # Browse directory tree
GET  /api/image             # Get original image (with ETag/Cache-Control)
GET  /api/thumbnail         # Get high-quality thumbnail
POST /api/classify          # Assign class/label to image
DELETE /api/classify        # Remove label
GET  /api/classes           # Get class list
GET  /saml/metadata         # SP metadata for SAML
GET  /saml/login            # Initiate SAML login
POST /saml/acs              # Assertion Consumer Service
GET  /api/whoami            # Check session (session_user, session_meta)
```

**Worker Configuration:**
- Default: 75% of CPU cores (minimum 24, maximum 32)
- Override with `UVICORN_WORKERS` environment variable
- When `RELOAD=1`, workers are forced to 1

### Frontend (Vanilla JavaScript)

**Main Entry Point:** [index.html](index.html)

The frontend uses vanilla JavaScript with ES6 modules and no build step.

**Core JavaScript Modules:**
- [js/main.js](js/main.js): Main application controller (`WaferMapViewer` class)
  - File explorer and directory navigation
  - Grid mode and single image mode management
  - Label Explorer UI and state management
  - View state preservation (grid ↔ single image transitions)
- [js/labels.js](js/labels.js): `LabelManager` class for classification
  - Class creation/deletion in Class Manager
  - Label assignment/removal operations
  - Label Explorer rendering and refresh logic
- [js/semiconductor-renderer.js](js/semiconductor-renderer.js): High-performance image rendering with pyramid technique
- [js/grid.js](js/grid.js): Grid view for batch image display
- [js/search.js](js/search.js): Advanced search with boolean operators
- [js/context-menu.js](js/context-menu.js): Right-click context menu
- [js/utils.js](js/utils.js): Utility functions

### Image Pyramid Rendering

The [SemiconductorRenderer](js/semiconductor-renderer.js) class implements a sophisticated image pyramid technique:

**Pyramid Levels:**
- `1.0` (100%): Original image for zoom >= 75%
- `0.5` (50%): Half-size for 25% <= zoom < 75%
- `0.2` (20%): One-fifth size for zoom < 25%

**Key Features:**
- Non-blocking pyramid generation using `requestIdleCallback`
- Immediate (synchronous) level creation on zoom threshold changes for instant visual feedback
- High-quality downsampling using browser's built-in algorithms
- Pixel-perfect rendering with disabled image smoothing
- Background upgrade to ImageBitmap for optimal performance

**Usage Pattern:**
```javascript
const renderer = new SemiconductorRenderer(canvas, {
    usePyramid: true,
    enhanceDefects: true,
    debug: false
});

await renderer.loadImage(imageElement);
renderer.fitToContainer(width, height);
```

## File Structure Conventions

### Image Files
- Supported formats: `.jpg`, `.jpeg`, `.png`, `.bmp`, `.tiff`, `.tif`, `.webp`, `.gif`
- Thumbnails stored in: `{PROJECT_ROOT}/thumbnails/`
- Classification data stored in: `{PROJECT_ROOT}/classification/`

### Directories to Skip
Default skip list: `classification`, `thumbnails` (configurable via `SKIP_DIRS` environment variable)

## Development Guidelines

### Code Style
- **Python:** PEP 8 compliant, use type hints where beneficial
- **JavaScript:** ES6+ features, JSDoc comments for public APIs
- No linting/formatting tools configured - follow existing patterns

### Commit Convention
```
feat: New feature
fix: Bug fix
refactor: Code refactoring
perf: Performance improvement
docs: Documentation changes
test: Test additions
chore: Build/tooling changes
```

### Important Notes for Code Changes

1. **Image Quality:** Always maintain Q=100 quality and Lanczos3 algorithm settings
2. **SAML:** Do not modify SAML configuration expecting it to work in Windows dev environment
3. **Pyramid Levels:** The configuration `PYRAMID_LEVELS = [0.25, 0.5, 0.75, 1.0]` in [api/config.py](api/config.py#L50) defines available pyramid levels
4. **Logging:** The system uses custom pretty-table access logging with ANSI colors - avoid polluting logs with verbose output
5. **HTTPS Only:** Production deployment requires HTTPS; HTTP is disabled by default

### Critical UI State Management Patterns

**Label Explorer State Preservation:**
- When modifying Label Explorer (adding/removing labels), avoid calling `refreshLabelExplorer()` which resets folder open/closed states
- Instead, use DOM manipulation to add/remove individual items:
  ```javascript
  // Good: Preserve folder state
  row.remove();
  await this.refreshClassList(); // Only update counts

  // Bad: Loses folder state
  await this.refreshLabelExplorer(); // Resets everything
  ```
- Cache management: `classToImgListCache` must be kept in sync with DOM changes
- Folder state tracking: `labelSelection.openFolders` object tracks which class folders are expanded

**Grid ↔ Single Image Mode Transitions:**
- When calling `loadImage()`, grid mode must be explicitly disabled and UI elements hidden:
  ```javascript
  this.gridMode = false;
  grid.style.display = 'none';
  gridControls.style.display = 'none';
  this.dom.viewerContainer.classList.remove('grid-mode');
  this.dom.viewerContainer.classList.add('single-image-mode');
  ```
- The `savedViewState` object preserves previous mode state for "Back" navigation
- Always clear `labelSelection.selectedClasses` when loading a new image to prevent lingering selection UI

**Class Manager vs Label Explorer:**
- `js/labels.js` (`LabelManager`) manages Class Manager panel and some Label Explorer operations
- `js/main.js` (`WaferMapViewer`) manages Label Explorer UI rendering and batch operations
- Both share the same `labelSelection` state object but update different UI panels
- When updating labels, coordinate between both managers to keep UI in sync

## Testing

The codebase does not include automated tests. Testing is performed manually:

1. Start the server with `python -m api.main`
2. Open browser to `https://localhost:8443`
3. Test image loading, pyramid rendering, thumbnail generation, and classification features
4. For pyramid rendering tests, use the browser developer tools to inspect canvas rendering

## Key Technical Decisions

### Why Image Pyramid?
Large wafer maps (4000x4000) require significant memory and rendering time. The pyramid approach reduces memory usage by 75% and improves rendering performance by 3x when zoomed out.

### Why No Build Step?
Simplicity and fast iteration. The frontend uses native ES6 modules supported by modern browsers, eliminating build complexity.

### Why FastAPI over Flask?
Better async support, automatic API documentation, and superior performance for concurrent image serving.

### Why pyvips over Pillow for Thumbnails?
pyvips provides significantly faster thumbnail generation for large images, especially with the high-quality settings required (Q=100).

## Common Tasks

### Adding a New API Endpoint

Edit [api/main.py](api/main.py) and add your endpoint:

```python
@app.get("/api/your-endpoint")
async def your_endpoint(request: Request):
    # Your logic here
    return JSONResponse({"status": "ok"})
```

### Adding New Image Processing

Image processing happens in the frontend [SemiconductorRenderer](js/semiconductor-renderer.js) class. For server-side processing, edit [api/thumbnail_service.py](api/thumbnail_service.py).

### Modifying Pyramid Behavior

The pyramid generation logic is in [SemiconductorRenderer.generateImagePyramid()](js/semiconductor-renderer.js#L145-L194). Level selection happens in [SemiconductorRenderer.selectPyramidLevel()](js/semiconductor-renderer.js#L276-L304).

### Changing HTTPS Configuration

HTTPS settings are in [api/config.py](api/config.py#L43-L47). Certificate files should be placed in the `cert/` directory.

## Troubleshooting

### Server Won't Start
- Check if port 8443 is already in use: `netstat -an | findstr :8443` (Windows) or `netstat -tulpn | grep :8443` (Ubuntu)
- Verify SSL certificate files exist at configured paths
- Check Python version: requires Python 3.8+

### Images Not Loading
- Verify `PROJECT_ROOT` environment variable points to correct directory
- Check file permissions (especially on Ubuntu)
- Ensure image file extensions are in supported list

### Pyramid Not Working
- Check browser console for JavaScript errors
- Verify `usePyramid: true` option is set in renderer constructor
- Large images may take time to generate pyramid - check dev tools Network tab

### SAML Login Issues
- SAML only works in Ubuntu production environment
- Verify `DEV_SAML=1` for development testing
- Check that `saml/settings.json` has proper configuration
- Review server logs for SAML assertion errors

## Additional Documentation

- [README.md](README.md): Project overview and quick start
- [ARCHITECTURE.md](ARCHITECTURE.md): Detailed system architecture
- [ENVIRONMENT_SETUP.md](ENVIRONMENT_SETUP.md): Complete environment variable guide
- [CHANGELOG.md](CHANGELOG.md): Version history and changes
