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

**Absolute Rule: 기능 수정/버그 수정 시 반드시 서버 + Playwright UI 검증**
- 코드 수정 후 반드시 서버를 켜고 (`python -m api.main`) 새 Playwright 인스턴스로 새 브라우저 창을 열어 UI에서 직접 동작을 확인한다
- 코드 분석만으로 "수정 완료"라고 보고하는 행위는 절대 금지한다
- 검증 순서: 서버 시작 → 새 Playwright 브라우저 열기 → 해당 기능 직접 조작 → 스크린샷으로 결과 확인
- 서버가 이미 실행 중이면 재시작 없이 기존 서버 사용, 꺼져 있으면 먼저 시작한다
- 이 규칙은 모든 기능 구현, 버그 수정, UI 관련 변경에 예외 없이 적용된다

**Absolute Rule: Non-blocking Server Startup (비동기 서버 시작)**
- 서버 시작 시 `lifespan`의 `yield` 전에는 최소한의 필수 초기화만 수행한다 (labels 로드, 디렉토리 생성 등)
- 인덱스 캐시 로드(`load_cache`), 인덱스 빌드(`build`), `_build_lookup_indices`, `_save_cache`, `__pycache__` 정리, composite cleanup 등 모든 무거운 작업은 반드시 `asyncio.create_task`로 백그라운드 실행한다
- CPU/IO 집약적 작업(`_walk_and_collect`, `_save_cache`, `_build_lookup_indices`, `_build_folder_files_cache`)은 반드시 `loop.run_in_executor`로 실행하여 이벤트 루프를 블로킹하지 않는다
- 서버는 인덱스 빌드 완료 여부와 무관하게 즉시 웹 요청을 처리할 수 있어야 한다
- `/api/files`, `/api/image` 등 인덱스에 의존하지 않는 엔드포인트는 서버 시작 즉시 동작해야 한다
- 인덱스 빌드 상태는 `/api/index-status` 엔드포인트와 프론트엔드 배너로 사용자에게 표시한다
- 이 규칙을 위반하는 코드 변경(동기 블로킹 초기화, yield 전 무거운 작업 추가)은 절대 금지한다

**Absolute Rule: Positions 파일 전체 스캔 금지**
- POSITIONS_ROOT에서 `rglob`, `iterdir`, `os.walk` 등으로 전체 디렉토리를 재귀/순회 검색하는 것은 절대 금지한다
- positions 파일은 이미지 경로와 동일한 상대 경로(`POSITIONS_ROOT/제품폴더/stem.json`)에서만 조회한다
- 해당 경로에 없으면 추가 검색 없이 즉시 404 반환 — 다른 폴더를 뒤지지 않는다
- classification, my-lot 등 어떤 경로든 동일: 직접 경로에 없으면 없는 것이다
- `get_chip_positions()`에서 classification 분기를 만들어 별도 스캔하는 것도 금지 — `_resolve_positions_path()` 한 줄로 통일
- 위반 시 async 이벤트 루프를 블로킹하여 모든 HTTP 요청이 수 초간 pending되는 심각한 성능 문제 유발

**Absolute Rule: Playwright는 반드시 새 브라우저 창으로 실행**
- 이미 열려있는 페이지가 있다면 절대 덮어쓰지 않는다 — 기존 탭에서 `browser_navigate` 금지
- **1순위: 사용 중이 아닌 다른 Playwright 인스턴스 사용** (playwright, playwright2, ..., playwright10 중 비어있는 것)
- **2순위: 다른 인스턴스가 전부 사용 중일 때만** `browser_evaluate`로 `window.open(url)` → `browser_tabs`로 전환
- 이 규칙을 위반하여 기존 페이지를 navigate로 덮어쓰는 행위는 절대 금지한다

**Absolute Rule: 기존 브라우저 창을 절대 닫지 않는다**
- `browser_close`를 사용자가 명시적으로 요청하기 전에는 절대 호출하지 않는다
- 접속 오류, 타임아웃, 브라우저 컨트롤 불가 등 어떤 상황에서도 기존 브라우저 창을 닫는 것으로 해결하지 않는다
- 브라우저 제어가 안 될 경우, 닫지 말고 사용자에게 상황을 보고하고 지시를 기다린다
- 이 규칙을 위반하여 사용자 허락 없이 브라우저를 닫는 행위는 절대 금지한다

**Absolute Rule: batch 폴더는 더미 파일 — 이미지 로드 절대 금지**
- `wm-811k/batch/` 하위의 모든 파일은 **파일 인덱스 성능 테스트용 더미 파일**이다 (0바이트 빈 파일)
- 실제 서버 환경의 수백만 개 파일 수를 재현하기 위해 만들어진 것이므로, 유효한 이미지 데이터가 아니다
- 이 폴더의 파일에 대해 썸네일 생성, 이미지 열기, PIL/pyvips 로드 등 **이미지 처리를 시도하는 것은 절대 금지**한다
- E2E 테스트, UI 점검, 디버깅 시 batch 폴더 파일은 테스트 대상에서 제외한다
- pyvips/PIL에서 "not a known file format" 또는 "cannot identify image file" 에러가 batch 경로에서 발생하면, 이는 정상 동작이다 — 버그가 아니므로 수정하려 하지 않는다

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
- `UVICORN_WORKERS`: FastAPI worker count (must stay at 1 to avoid duplicate indexing)
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

See [docs/PERFORMANCE.md](docs/PERFORMANCE.md) for runtime performance details.

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
- Must stay at 1 (`UVICORN_WORKERS=1`) to avoid duplicate indexing
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

## Composite Map Features

### Overview

Composite Map is a powerful feature that aggregates multiple wafer maps into a single heatmap showing defect patterns across many wafers.

**Key Concepts:**
- **Full Composite Map**: Shows all defect grades (0-7) aggregated across selected wafers
- **Subset Composite Map**: Shows only selected defect grades for focused analysis
- **Grade Counts**: NumPy arrays tracking how many wafers have each grade at each position
- **NPZ Caching**: Composite data cached in `.npz` files for fast recoloring
- **Recolor**: Fast color scheme changes without recalculating composite values

### Main Functions

**Creating Composite Maps** (api/composite_map.py):
- `create_full_composite_maps()` - Generate Full Composite Map from multiple wafers
- `create_subset_map()` - Generate Subset Composite Map for specific grades
- `recolor_saved_sum_maps()` - Fast recolor using cached composite data

**Color Management** (api/composite_colors.py):
- `load_composite_color_settings()` - Load color scheme from `logs/color-legends.json`
- `save_composite_color_settings()` - Save custom color schemes
- 11-point gradient: Blue (0%) → Cyan → Green → Yellow → Orange → Red (100%)

### Key Technical Details

**Calculation:**
- Uses square weighting: `grade²` for severity
- Two metrics: `square_mean` (simple average) and `square_weighted` (weighted average)
- Min-Max scaling to percentiles (0-100%) for color mapping
- 2-layer rendering: Base layer (wafer shape) + Composite layer (gradient)

**Subset Map Behavior:**
- Non-selected grades are moved to grade 0 (which has 0² = 0 weight)
- Same `calc_mask` as Full Map to maintain wafer shape
- Values are typically much smaller than Full Map
- Same position shows different colors due to different value ranges

**Common Pitfalls:**
- Always pass `only_low_mask=None` to subset functions to force recalculation
- Don't reuse Full Map's `calc_mask` - let subset recalculate from `grade_counts`
- Subset colors appear lighter/different due to narrower value range (this is expected)

See [docs/COMPOSITE_MAP.md](docs/COMPOSITE_MAP.md) for detailed technical comparison.

## Development Guidelines

See [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) for full development guide.

### Project Structure & Module Organization

The FastAPI backend lives in `api/` (`main.py` entrypoint plus config, caching, and logging helpers). Frontend ES6 modules are in `js/` and loaded directly by `index.html`, so keep code browser-ready without a bundler. Long-form docs in `docs/`, and TLS placeholders in `cert/`. Leave large datasets and private configuration outside version control.

### Build, Test, and Development Commands

Install dependencies with `pip install -r requirements.txt`. Launch the service via `python -m api.main`; use `./start.ps1` (Windows) or `./start.sh` (Ubuntu) when you need the tuned environment variables. Enable local hot reload by exporting `RELOAD=1` and setting `UVICORN_WORKERS=1`. Confirm `PROJECT_ROOT` points to your wafer directory before running any command.

### Coding Style & Naming Conventions

Python modules use 4-space indentation, `snake_case` for functions, and `CamelCase` for services or Pydantic models. Reuse helpers such as `thumbnail_service` and the shared loggers instead of reimplementing filesystem or caching logic, and keep structured logging intact. JavaScript stays as native ES6 modules with `camelCase` APIs and hyphenated filenames (`context-menu.js`, `semiconductor-renderer.js`). Guard long-running I/O with the existing async patterns and locks.

### Security & Configuration Tips

Never commit real secrets; `cert/` holds placeholders only. Before leaving shared machines, reset aggressive concurrency knobs (`VIPS_CONCURRENCY`, `THUMBNAIL_SEM`, `IO_THREADS`) and re-check that HTTPS still terminates correctly after SSL changes.

## Additional Documentation

- [README.md](README.md): Project overview and quick start
- [docs/README.md](docs/README.md): Documentation index
- [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md): Development guide and project structure
- [docs/API_REFERENCE.md](docs/API_REFERENCE.md): Full API endpoint reference
- [docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md): Debugging guide and deploy checklist
- [docs/CHIP_ANNOTATION.md](docs/CHIP_ANNOTATION.md): Chip-level defect annotation system
