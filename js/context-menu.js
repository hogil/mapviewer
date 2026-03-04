/**
 * 컨텍스트 메뉴 관련 기능들
 * 우클릭 메뉴, 파일 다운로드, 이미지 합성, 클립보드 복사
 */

import { calculateGridSize, copyToClipboard, extractFolderName, extractFileName, splitFileName } from './utils.js';

/**
 * 컨텍스트 메뉴 관리 클래스
 */
export class ContextMenuManager {
    constructor(viewer) {
        this.viewer = viewer;
        this.menu = null;
        this.isVisible = false;
        this.html2canvasPromise = null;
        
        this.initializeMenu();
        this.bindEvents();
    }
    
    /**
     * 컨텍스트 메뉴 초기화
     */
    initializeMenu() {
        this.menu = document.getElementById('grid-context-menu');
        if (!this.menu) {
            console.warn('컨텍스트 메뉴 요소를 찾을 수 없습니다.');
            return;
        }
        
        // 메뉴 항목들에 이벤트 리스너 연결
        const downloadItem = document.getElementById('context-download');
        const mergeCopyItem = document.getElementById('context-merge-copy');
        const listCopyItem = document.getElementById('context-list-copy');
        const tableCopyItem = document.getElementById('context-table-copy');
        const cancelItem = document.getElementById('context-cancel');
        
        // 🔥 MY LOT 추가 메뉴 항목
        const myLotAddItem = document.getElementById('context-my-lot-add');

        if (downloadItem) {
            downloadItem.onclick = () => {
                this.hide();
                this.downloadSelectedImages();
            };
        }

        if (mergeCopyItem) {
            mergeCopyItem.onclick = () => {
                this.hide();
                this.mergeAndCopyImages();
            };
        }

        if (listCopyItem) {
            listCopyItem.onclick = () => {
                this.hide();
                this.copyFileList();
            };
        }

        if (tableCopyItem) {
            tableCopyItem.onclick = () => {
                this.hide();
                this.copyFileListAsTable();
            };
        }

        if (cancelItem) {
            cancelItem.onclick = () => {
                this.hide();
            };
        }

        // 🔥 MY LOT에 추가 (클릭한 이미지 또는 선택된 모든 이미지)
        if (myLotAddItem) {
            myLotAddItem.onclick = () => {
                this.hide();
                this.addToMyLot();
            };
        }
    }
    
    /**
     * 이벤트 바인딩
     */
    bindEvents() {
        // 전역 클릭으로 메뉴 숨기기
        this.globalClickHandler = (e) => {
            if (this.isVisible && !this.menu.contains(e.target)) {
                this.hide();
            }
        };
    }
    
    /**
     * 컨텍스트 메뉴 표시
     * @param {MouseEvent} event 마우스 이벤트
     * @param {number} clickedIdx 클릭된 이미지 인덱스
     */
    show(event, clickedIdx) {
        event.preventDefault();
        
        // 컨텍스트 메뉴 표시 시 선택 상태를 변경하지 않음 (기존 선택 유지)
        
        // 메뉴 위치 설정
        this.menu.style.left = event.pageX + 'px';
        this.menu.style.top = event.pageY + 'px';
        this.menu.style.display = 'block';
        
        this.isVisible = true;
        
        // 전역 클릭 리스너 추가
        document.addEventListener('click', this.globalClickHandler);
    }
    
    /**
     * 컨텍스트 메뉴 숨기기
     */
    hide() {
        if (this.menu) {
            this.menu.style.display = 'none';
        }
        this.isVisible = false;
        
        // 전역 클릭 리스너 제거
        document.removeEventListener('click', this.globalClickHandler);
    }
    
    /**
     * 선택된 이미지들 다운로드
     */
    async downloadSelectedImages() {
        const selectedFiles = this.getSelectedFiles();
        if (selectedFiles.length === 0) {
            alert('다운로드할 이미지를 선택해주세요.');
            return;
        }
        
        console.log(`${selectedFiles.length}개 파일 다운로드 시작`);
        
        for (let i = 0; i < selectedFiles.length; i++) {
            const filePath = selectedFiles[i];
            await this.downloadImage(filePath);
            
            // 브라우저의 다운로드 제한을 피하기 위해 짧은 지연
            if (i < selectedFiles.length - 1) {
                await new Promise(resolve => setTimeout(resolve, 100));
            }
        }
        
        console.log('모든 파일 다운로드 완료');
        alert(`${selectedFiles.length}개 파일 다운로드가 완료되었습니다.`);
    }
    
    /**
     * 단일 이미지 다운로드
     * @param {string} filePath 파일 경로
     */
    async downloadImage(filePath) {
        try {
            const response = await fetch(`/api/image?path=${encodeURIComponent(filePath)}`);
            if (!response.ok) {
                throw new Error(`다운로드 실패: ${response.status}`);
            }
            
            const blob = await response.blob();
            const url = window.URL.createObjectURL(blob);
            
            const a = document.createElement('a');
            a.href = url;
            a.download = filePath.split('/').pop();
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            
            window.URL.revokeObjectURL(url);
        } catch (error) {
            console.error('이미지 다운로드 오류:', error);
        }
    }
    
    /**
     * 선택된 이미지들을 합쳐서 클립보드에 복사 (상단 color legend 포함 - Dark Theme)
     */
    async mergeAndCopyImages() {
        const selectedFiles = this.getSelectedFiles();
        if (selectedFiles.length === 0) {
            alert('합칠 이미지를 선택해주세요.');
            return;
        }
        
        try {
            console.log(`${selectedFiles.length}개 이미지 합성 시작 (Dark Theme Legend)`);

            const personalizedParams = (this.viewer && typeof this.viewer.getPersonalizedParams === 'function')
                ? this.viewer.getPersonalizedParams()
                : '';

            // Color legends 데이터 로드
            const colorLegends = await this.loadColorLegends();
            
            // 그리드 크기 계산
            const cols = Math.ceil(Math.sqrt(selectedFiles.length));
            const rows = Math.ceil(selectedFiles.length / cols);
            
            // 이미지 크기 및 여백 설정
            const imageSize = 512;
            const filenameHeight = 32;
            const rowPadding = 20;
            const cellHeight = imageSize + filenameHeight + rowPadding;
            
            // 캔버스 너비 먼저 계산 (Legend 줄바꿈 계산을 위해)
            const canvasWidth = cols * imageSize;
            
            // 캔버스 생성 (임시로 높이 0)
            const canvas = document.createElement('canvas');
            const ctx = canvas.getContext('2d');
            
            // Legend 높이 계산 (줄바꿈 포함)
            const legendHeight = this.calculateLegendHeight(ctx, colorLegends, canvasWidth);
            
            // 최종 캔버스 크기 설정
            canvas.width = canvasWidth;
            canvas.height = legendHeight + (rows * cellHeight);
            
            // 🔥 배경을 어두운 색(#1e1e1e)으로 채우기 (Dark Theme)
            ctx.fillStyle = '#1e1e1e';
            ctx.fillRect(0, 0, canvas.width, canvas.height);
            
            // 🔥 상단에 Color Legend 그리기
            this.drawColorLegend(ctx, colorLegends, canvasWidth, legendHeight);
            
            // 🔥 고품질 이미지 리샘플링 활성화
            ctx.imageSmoothingEnabled = true;
            ctx.imageSmoothingQuality = 'high';
            
            // 이미지들을 그리드에 배치
            const imagePromises = selectedFiles.map(async (imagePath, index) => {
                const img = new Image();
                img.crossOrigin = 'anonymous';
                
                return new Promise((resolve, reject) => {
                    img.onload = () => {
                        const row = Math.floor(index / cols);
                        const col = index % cols;
                        const x = col * imageSize;
                        const y = legendHeight + (row * cellHeight); // Legend 아래부터 시작
                        
                        // 이미지를 512x512 안에 맞춤 (비율 유지)
                        const scale = Math.min(imageSize / img.width, imageSize / img.height);
                        const scaledWidth = img.width * scale;
                        const scaledHeight = img.height * scale;
                        const offsetX = (imageSize - scaledWidth) / 2;
                        const offsetY = (imageSize - scaledHeight) / 2;
                        
                        ctx.drawImage(img, x + offsetX, y + offsetY, scaledWidth, scaledHeight);
                        
                        // 파일명 표시
                        const pathParts = imagePath.split('/');
                        const filename = pathParts.pop();
                        const folderName = pathParts.length > 0 ? pathParts[pathParts.length - 1] : '';
                        
                        // 확장자 제거
                        const nameWithoutExt = filename.substring(0, filename.lastIndexOf('.')) || filename;
                        
                        // 폴더명과 파일명을 한 줄로 결합
                        let displayName = folderName ? `${folderName}/${nameWithoutExt}` : nameWithoutExt;
                        
                        // 텍스트 설정 (밝은 색)
                        ctx.fillStyle = '#cccccc'; // 연한 회색
                        ctx.font = '28px Arial';
                        ctx.textAlign = 'center';
                        ctx.textBaseline = 'middle';

                        // 파일명이 너무 길면 잘라내기
                        const maxWidth = imageSize - 20;
                        let metrics = ctx.measureText(displayName);
                        if (metrics.width > maxWidth) {
                            while (displayName.length > 0 && ctx.measureText(displayName + '...').width > maxWidth) {
                                displayName = displayName.substring(0, displayName.length - 1);
                            }
                            displayName = displayName + '...';
                        }

                        // 파일명 표시
                        ctx.fillText(displayName, x + imageSize / 2, y + imageSize + filenameHeight / 2);
                        
                        resolve();
                    };
                    img.onerror = reject;
                    img.src = `/api/thumbnail?path=${encodeURIComponent(imagePath)}&size=512${personalizedParams}`;
                });
            });
            
            await Promise.all(imagePromises);
            
            // 🔥 초고품질 PNG로 클립보드에 복사
            canvas.toBlob(async (blob) => {
                try {
                    await navigator.clipboard.write([
                        new ClipboardItem({ 'image/png': blob })
                    ]);
                    alert(`${selectedFiles.length}개 이미지가 클립보드에 복사되었습니다.`);
                } catch (error) {
                    console.error('클립보드 복사 실패:', error);
                    alert('클립보드 복사에 실패했습니다.');
                }
            }, 'image/png');
            
        } catch (error) {
            console.error('이미지 합성 오류:', error);
            alert('이미지 합성에 실패했습니다.');
        }
    }
    
    /**
     * Color legends 데이터 로드
     */
    async loadColorLegends() {
        try {
            const response = await fetch(`/logs/color-legends.json?_t=${Date.now()}`);
            if (!response.ok) return {};
            return await response.json();
        } catch (error) {
            return {};
        }
    }
    
    /**
     * Legend 높이 계산 (너비에 따른 줄바꿈 고려)
     */
    calculateLegendHeight(ctx, colorLegends, canvasWidth) {
        const TOP_KEYS = ['Grade0', 'Grade1', 'Grade2', 'Grade3', 'Grade4', 'Grade5', 'Grade6', 'Grade7'];
        const BOTTOM_KEYS = ['Normal', 'Invalid', 'B285', 'B286', 'B287', 'B288', 'B290', 'B291'];
        const allKeys = [...TOP_KEYS, ...BOTTOM_KEYS];
        
        const itemWidth = 70; // 아이템 간격 포함 예상 너비
        const padding = 20;
        const itemsPerRow = Math.floor((canvasWidth - padding * 2) / itemWidth);
        const rows = Math.ceil(allKeys.length / itemsPerRow);
        
        // 기본 높이 40px, 줄바꿈 시 줄당 30px 추가
        return Math.max(50, 20 + (rows * 30));
    }
    
    /**
     * 캔버스에 Color Legend 그리기 (Dark Theme)
     */
    drawColorLegend(ctx, colorLegends, canvasWidth, legendHeight) {
        // Scheme 결정
        let schemeName = 'default';
        if (this.viewer?.personalizedColorEnabled && this.viewer?.currentUser) {
            schemeName = this.viewer.currentUser;
        }
        
        const scheme = colorLegends[schemeName] || colorLegends.default || {};
        const topColors = scheme.top || {};
        const bottomColors = scheme.bottom || {};
        
        const TOP_KEYS = ['Grade0', 'Grade1', 'Grade2', 'Grade3', 'Grade4', 'Grade5', 'Grade6', 'Grade7'];
        const BOTTOM_KEYS = ['Normal', 'Invalid', 'B285', 'B286', 'B287', 'B288', 'B290', 'B291'];
        
        // Legend 아이템 설정
        const itemWidth = 20; // 컬러바 너비
        const itemHeight = 16; // 컬러바 높이
        const gap = 50; // 아이템 간 간격 (텍스트 포함)
        const startX = 20;
        let currentX = startX;
        let currentY = 20; // 첫 줄 Y 좌표
        
        ctx.font = '14px Arial'; // 폰트 크기 약간 키움
        ctx.textBaseline = 'middle';
        
        const drawItem = (key, color, label) => {
            // 텍스트 길이 측정
            const textMetrics = ctx.measureText(label);
            const totalItemWidth = itemWidth + 8 + textMetrics.width; // 컬러바 + 간격 + 텍스트
            
            // 줄바꿈 체크
            if (currentX + totalItemWidth > canvasWidth - 20) {
                currentX = startX;
                currentY += 30; // 다음 줄
            }
            
            // Color bar
            ctx.fillStyle = color;
            ctx.fillRect(currentX, currentY - itemHeight/2, itemWidth, itemHeight);
            ctx.strokeStyle = '#555'; // 테두리 밝게
            ctx.lineWidth = 1;
            ctx.strokeRect(currentX, currentY - itemHeight/2, itemWidth, itemHeight);
            
            // Label (밝은 색)
            ctx.fillStyle = '#eeeeee'; 
            ctx.textAlign = 'left';
            ctx.fillText(label, currentX + itemWidth + 8, currentY);
            
            // 다음 위치로 이동
            currentX += totalItemWidth + 20; // 아이템 간 추가 간격
        };
        
        // Top colors (G0~G7)
        TOP_KEYS.forEach((gradeKey, index) => {
            const color = topColors[gradeKey] || '#FFFFFF';
            drawItem(gradeKey, color, `G${index}`);
        });
        
        // Bottom colors
        const labelMap = {
            'Normal': 'nor',
            'Invalid': 'inv',
            'B285': 'B285',
            'B286': 'B286',
            'B287': 'B287',
            'B288': 'B288',
            'B290': 'B290',
            'B291': 'B291',
        };
        
        BOTTOM_KEYS.forEach((key) => {
            const color = bottomColors[key] || '#FFFFFF';
            const label = labelMap[key] || key;
            drawItem(key, color, label);
        });
    }

    /**
     * 선택된 파일 리스트를 클립보드에 복사 (YMS 방식)
     */
    async copyFileList() {
        const selectedFiles = this.getSelectedFiles();
        if (selectedFiles.length === 0) {
            alert('복사할 파일을 선택해주세요.');
            return;
        }
        
        const ymsList = selectedFiles.map(filePath => {
            const fileName = filePath.split('/').pop();
            const parts = fileName.split('_');
            const part0 = parts[0] || '';
            let part2 = parts[2] || '';
            if (part2) {
                part2 = part2.replace(/\.(png|jpg|jpeg|gif|bmp|tiff?)$/i, '');
            }
            return `${part0}\t${part2}`;
        }).join('\n');
        
        const success = await copyToClipboard(ymsList);
        
        if (success) {
            alert(`${selectedFiles.length}개 파일 정보가 클립보드에 복사되었습니다.`);
        } else {
            alert('클립보드 복사에 실패했습니다.');
        }
    }
    
    /**
     * 선택된 파일 리스트를 테이블 형태로 클립보드에 복사
     */
    async copyFileListAsTable() {
        const selectedFiles = this.getSelectedFiles();
        if (selectedFiles.length === 0) {
            alert('복사할 파일을 선택해주세요.');
            return;
        }
        
        const tableData = selectedFiles.map(filePath => {
            const fileName = filePath.split('/').pop();
            const parts = fileName.split('_');
            const part4 = parts[4] || '';
            const part5Raw = parts[5] || '';
            const part5 = part5Raw.replace(/\.(png|jpg|jpeg|gif|bmp|tiff?)$/i, '');
            
            return { part4, part5 };
        });
        
        let tableText = '';
        tableData.forEach(row => {
            const time = row.part5.length === 6 ? `'${row.part5}` : row.part5;
            tableText += `${row.part4}\t${time}\n`;
        });
        
        const success = await copyToClipboard(tableText);
        
        if (success) {
            alert(`${selectedFiles.length}개 파일 정보가 테이블 형태로 클립보드에 복사되었습니다.`);
        } else {
            alert('클립보드 복사에 실패했습니다.');
        }
    }
    
    /**
     * 원본 이미지 다운로드
     */
    async downloadOriginalImage() {
        if (!this.viewer.currentImagePath) {
            alert('다운로드할 이미지가 없습니다.');
            return;
        }
        await this.downloadImage(this.viewer.currentImagePath);
        alert('원본 이미지가 다운로드되었습니다.');
    }
    
    /**
     * 이미지만 복사 (패널 제외, 이미지/오버레이 보이는 영역만)
     */
    async copyImageToClipboard() {
        try {
            await this.copyVisibleCanvasViewport();
        } catch (error) {
            console.error('이미지 복사 실패:', error);
            alert('이미지 복사에 실패했습니다: ' + error.message);
        }
    }


    /**
     * 전체 캔버스를 클립보드에 복사 (모든 UI/범례 포함 - html2canvas 사용)
     */
    async copyCanvasToClipboard() {
        try {
            const dom = this.viewer?.dom || {};
            const mainContent = document.querySelector('.main-content');
            const captureRoot = mainContent || dom.viewerContainer;
            if (!captureRoot) {
                alert('복사할 영역이 없습니다.');
                return;
            }

            const html2canvas = await this.ensureHtml2Canvas();
            if (!html2canvas) {
                await this.copyCanvasOnly();
                return;
            }

            const captureRect = this.getCaptureRect(
                [dom.viewerContainer, dom.colorLegendTop, dom.colorLegendBottom, dom.gridColorLegendBottom],
                captureRoot
            );

            const canvas = await html2canvas(captureRoot, {
                backgroundColor: '#1a1a1a',
                scale: Math.min(2.5, window.devicePixelRatio || 1),
                logging: false,
                useCORS: true,
                allowTaint: true,
                x: captureRect.x,
                y: captureRect.y,
                width: captureRect.width,
                height: captureRect.height
            });

            await this.writeCanvasToClipboard(canvas, '전체 화면이 클립보드에 복사되었습니다. (UI 포함)');
        } catch (error) {
            console.error('캔버스 복사 실패:', error);
            alert('캔버스 복사에 실패했습니다. 기본 캔버스만 복사합니다.');
            await this.copyCanvasOnly();
        }
    }

    /**
     * 캔버스만 복사 (fallback)
     */
    async copyCanvasOnly() {
        const imageCanvas = this.viewer.dom?.imageCanvas;
        if (!imageCanvas) {
            alert('복사할 캔버스가 없습니다.');
            return;
        }

        const blob = await new Promise((resolve, reject) => {
            imageCanvas.toBlob(
                (blob) => {
                    if (blob) {
                        resolve(blob);
                    } else {
                        reject(new Error('Canvas Blob 변환 실패'));
                    }
                },
                'image/png',
                1.0
            );
        });

        await navigator.clipboard.write([
            new ClipboardItem({ 'image/png': blob })
        ]);

        alert('캔버스가 클립보드에 복사되었습니다.');
    }

    /**
     * UI 캡처용 요소 가시성 체크
     */
    isElementVisibleForCapture(el) {
        if (!el) return false;
        const style = window.getComputedStyle(el);
        if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) {
            return false;
        }
        const rect = el.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
    }

    /**
     * 캡처할 영역 계산 (이미지/범례가 보이는 영역만)
     */
    getCaptureRect(elements = [], root) {
        const rootRect = root?.getBoundingClientRect();
        if (!rootRect) {
            return { x: 0, y: 0, width: window.innerWidth, height: window.innerHeight };
        }

        const visibleRects = elements
            .filter(el => this.isElementVisibleForCapture(el))
            .map(el => el.getBoundingClientRect());

        if (!visibleRects.length) {
            return {
                x: 0,
                y: 0,
                width: Math.max(1, Math.ceil(rootRect.width)),
                height: Math.max(1, Math.ceil(rootRect.height))
            };
        }

        const union = visibleRects.reduce((acc, rect) => ({
            left: Math.min(acc.left, rect.left),
            top: Math.min(acc.top, rect.top),
            right: Math.max(acc.right, rect.right),
            bottom: Math.max(acc.bottom, rect.bottom)
        }), {
            left: Number.POSITIVE_INFINITY,
            top: Number.POSITIVE_INFINITY,
            right: Number.NEGATIVE_INFINITY,
            bottom: Number.NEGATIVE_INFINITY
        });

        const x = Math.max(0, union.left - rootRect.left);
        const y = Math.max(0, union.top - rootRect.top);
        const width = Math.min(rootRect.width - x, union.right - union.left);
        const height = Math.min(rootRect.height - y, union.bottom - union.top);

        return {
            x: Math.floor(x),
            y: Math.floor(y),
            width: Math.max(1, Math.ceil(width)),
            height: Math.max(1, Math.ceil(height))
        };
    }

    /**
     * 현재 화면을 PNG Blob으로 변환 후 클립보드에 복사
     */
    async writeCanvasToClipboard(canvas, successMessage) {
        const blob = await new Promise((resolve, reject) => {
            canvas.toBlob(
                (result) => {
                    if (result) {
                        resolve(result);
                    } else {
                        reject(new Error('Canvas Blob 변환 실패'));
                    }
                },
                'image/png',
                1.0
            );
        });

        await navigator.clipboard.write([
            new ClipboardItem({ 'image/png': blob })
        ]);

        alert(successMessage || '화면이 클립보드에 복사되었습니다.');
    }

    /**
     * html2canvas 실패 시: 기존 로직으로 가시 영역만 병합/복사
     */
    async copyVisibleCanvasViewport() {
        const imageCanvas = this.viewer.dom?.imageCanvas;
        const overlayCanvas = this.viewer.dom?.overlayCanvas;
        const transform = this.viewer.transform;
        const imgWidth = this.viewer.originalWidth;
        const imgHeight = this.viewer.originalHeight;

        if (!imageCanvas || !transform || !imgWidth || !imgHeight) {
            alert('복사할 이미지가 없습니다.');
            return;
        }

        const viewWidth = (overlayCanvas && overlayCanvas.width) || imageCanvas.width || imageCanvas.getBoundingClientRect().width;
        const viewHeight = (overlayCanvas && overlayCanvas.height) || imageCanvas.height || imageCanvas.getBoundingClientRect().height;
        const scale = Number(transform.scale) || 1;
        const offsetX = Number(transform.dx) || 0;
        const offsetY = Number(transform.dy) || 0;
        const renderedWidth = imgWidth * scale;
        const renderedHeight = imgHeight * scale;

        let visibleLeft = Math.max(0, Math.floor(offsetX));
        let visibleTop = Math.max(0, Math.floor(offsetY));
        let visibleRight = Math.min(viewWidth, Math.ceil(offsetX + renderedWidth));
        let visibleBottom = Math.min(viewHeight, Math.ceil(offsetY + renderedHeight));

        let sourceWidth = Math.max(0, visibleRight - visibleLeft);
        let sourceHeight = Math.max(0, visibleBottom - visibleTop);

        if (sourceWidth < 1 || sourceHeight < 1) {
            visibleLeft = 0;
            visibleTop = 0;
            visibleRight = viewWidth;
            visibleBottom = viewHeight;
            sourceWidth = viewWidth;
            sourceHeight = viewHeight;
        }

        const outputWidth = Math.max(1, Math.round(sourceWidth));
        const outputHeight = Math.max(1, Math.round(sourceHeight));

        if (this.viewer?.chipAnnotator?.render) {
            this.viewer.chipAnnotator.render();
        }

        const mergedCanvas = document.createElement('canvas');
        mergedCanvas.width = viewWidth;
        mergedCanvas.height = viewHeight;
        const mergedCtx = mergedCanvas.getContext('2d');
        if (!mergedCtx) {
            throw new Error('캔버스를 준비할 수 없습니다.');
        }
        mergedCtx.imageSmoothingEnabled = false;

        // ✅ 베이스 이미지 먼저 그대로 그리기
        mergedCtx.drawImage(imageCanvas, 0, 0, viewWidth, viewHeight);

        // ✅ Chip overlay는 UI에서 사용한 Y 오프셋만큼 아래로 내려서 합성
        //    - UI에서는 chip 선택/렌더링을 위해 ChipAnnotator 내부에서 Y_OFFSET을 위로 올려서 사용하고 있음
        //    - 클립보드 이미지에서는 같은 오프셋만큼 chip 레이어를 "아래로" 내려서,
        //      실제 이미지 상의 chip 위치와 정확히 겹치도록 보정한다.
        if (overlayCanvas) {
            const chipAnnotator = this.viewer?.chipAnnotator;
            // ChipAnnotator에 Y_OFFSET 속성이 있으면 그 값을 사용, 없으면 0
            const yOffset = chipAnnotator && typeof chipAnnotator.Y_OFFSET === 'number'
                ? -chipAnnotator.Y_OFFSET   // UI에서 위로 올린 만큼, 복사할 땐 아래로 내린다
                : 0;

            mergedCtx.drawImage(
                overlayCanvas,
                0, 0, viewWidth, viewHeight,   // source 영역 전체
                0, yOffset, viewWidth, viewHeight // destination에서 Y 방향으로만 보정
            );
        }

        const tempCanvas = document.createElement('canvas');
        tempCanvas.width = outputWidth;
        tempCanvas.height = outputHeight;
        const tempCtx = tempCanvas.getContext('2d');
        if (!tempCtx) {
            throw new Error('캔버스를 준비할 수 없습니다.');
        }
        tempCtx.imageSmoothingEnabled = false;

        tempCtx.drawImage(
            mergedCanvas,
            visibleLeft, visibleTop, sourceWidth, sourceHeight,
            0, 0, outputWidth, outputHeight
        );

        await this.writeCanvasToClipboard(tempCanvas, '이미지가 클립보드에 복사되었습니다. (보이는 영역)');
    }

    /**
     * html2canvas 라이브러리 동적 로드
     */
    async ensureHtml2Canvas() {
        if (this.html2canvasPromise) {
            return this.html2canvasPromise;
        }

        this.html2canvasPromise = new Promise((resolve) => {
            // 이미 로드되어 있는지 확인
            if (window.html2canvas) {
                resolve(window.html2canvas);
                return;
            }

            // CDN에서 로드
            const script = document.createElement('script');
            script.src = 'https://cdnjs.cloudflare.com/ajax/libs/html2canvas/1.4.1/html2canvas.min.js';
            script.onload = () => {
                resolve(window.html2canvas);
            };
            script.onerror = () => {
                console.error('html2canvas 로드 실패');
                resolve(null);
            };
            document.head.appendChild(script);
        });

        return this.html2canvasPromise;
    }
    
    /**
     * 현재 선택된 파일들 가져오기
     */
    getSelectedFiles() {
        // 단일 이미지 뷰(그리드에서 더블클릭 진입)에서는 현재 이미지만 대상
        if (this.viewer.viewMode === 'gridImage') {
            if (this.viewer.gridSelectedIdxs && this.viewer.gridSelectedIdxs.length > 0) {
                const imageList = this.viewer.currentGridImages || this.viewer.selectedImages;
                if (imageList) {
                    return this.viewer.gridSelectedIdxs.map(idx => imageList[idx]).filter(Boolean);
                }
            }
            if (this.viewer.selectedImagePath) {
                return [this.viewer.selectedImagePath];
            }
        }

        if (this.viewer.gridMode && this.viewer.gridSelectedIdxs && this.viewer.gridSelectedIdxs.length > 0) {
            const imageList = this.viewer.currentGridImages || this.viewer.selectedImages;
            if (imageList) {
                return this.viewer.gridSelectedIdxs.map(idx => imageList[idx]).filter(Boolean);
            }
        }
        
        if (!this.viewer.gridMode && this.viewer.selectedImagePath) {
            return [this.viewer.selectedImagePath];
        }

        if (this.viewer.selectedImages && this.viewer.selectedImages.length > 0) {
            return [...this.viewer.selectedImages];
        }
        
        return [];
    }
    
    /**
     * MY LOT에 추가
     */
    async addToMyLot() {
        const targetPath = this.viewer.contextMenuTargetPath;
        const selectedFiles = this.getSelectedFiles();

        let pathsToAdd = [];

        if (targetPath && selectedFiles.includes(targetPath)) {
            pathsToAdd = selectedFiles;
        } else if (targetPath) {
            pathsToAdd = [targetPath];
        } else {
            this.viewer.showToast?.('추가할 이미지를 찾을 수 없습니다.', 2000);
            return;
        }

        if (pathsToAdd.length === 0) {
            this.viewer.showToast?.('추가할 이미지를 선택해주세요.', 2000);
            return;
        }

        if (!this.viewer.myLotModal) {
            this.viewer.showToast?.('MY LOT을 열 수 없습니다.', 2000);
            return;
        }

        await this.viewer.myLotModal.open(pathsToAdd);
        this.viewer.showToast?.(`${pathsToAdd.length}개 항목이 대기 중입니다.`, 4000);
    }
}
