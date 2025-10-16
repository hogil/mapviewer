/**
 * 라벨 및 클래스 관리 기능들
 * 클래스 생성/삭제, 라벨 추가/제거, Label Explorer 관리
 */

import { setButtonLoading, debounce } from './utils.js';

/**
 * 라벨 매니저 클래스
 */
export class LabelManager {
    constructor(viewer) {
        this.viewer = viewer;
        this.classes = [];
        this.labelSelection = {
            selected: [],
            selectedClasses: []
        };
        
        // 디바운싱된 새로고침 함수
        this.debouncedRefresh = debounce(() => this.refreshAll(), 300);
        
        this.initElements();
        this.bindEvents();
    }
    
    /**
     * DOM 요소 초기화
     */
    initElements() {
        this.elements = {
            newClassInput: document.getElementById('new-class-input'),
            addClassBtn: document.getElementById('add-class-btn'),
            deleteClassBtn: document.getElementById('delete-class-btn'),
            classList: document.getElementById('class-list'),
            labelStatus: document.getElementById('label-status'),
            classImagesSection: document.getElementById('class-images-section'),
            classImagesTitle: document.getElementById('class-images-title'),
            classImagesList: document.getElementById('class-images-list'),
            labelExplorerList: document.getElementById('label-explorer-list'),
            batchLabelBtn: document.getElementById('label-explorer-batch-label-btn'),
            batchDeleteBtn: document.getElementById('label-explorer-batch-delete-btn')
        };
    }
    
    /**
     * 이벤트 바인딩
     */
    bindEvents() {
        console.log('🔍 [LABEL_EXPLORER_DEBUG] bindEvents 호출됨');
        
        // 클래스 추가 버튼
        if (this.elements.addClassBtn) {
            this.elements.addClassBtn.addEventListener('click', () => {
                console.log('🔍 [LABEL_EXPLORER_DEBUG] 클래스 추가 버튼 클릭됨');
                this.addClass();
            });
        }
        
        // 클래스 삭제 버튼
        if (this.elements.deleteClassBtn) {
            this.elements.deleteClassBtn.addEventListener('click', () => {
                console.log('🔍 [LABEL_EXPLORER_DEBUG] 클래스 삭제 버튼 클릭됨');
                this.deleteSelectedClasses();
            });
        }
        
        // 새 클래스 입력 필드에서 Enter 키
        if (this.elements.newClassInput) {
            this.elements.newClassInput.addEventListener('keydown', (e) => {
                if (e.key === 'Enter') {
                    console.log('🔍 [LABEL_EXPLORER_DEBUG] 클래스 입력 필드에서 Enter 키 입력됨');
                    e.preventDefault();
                    this.addClass();
                }
            });
        }
        
        // 배치 라벨 추가 버튼
        if (this.elements.batchLabelBtn) {
            this.elements.batchLabelBtn.addEventListener('click', () => {
                console.log('🔍 [LABEL_EXPLORER_DEBUG] 배치 라벨 추가 버튼 클릭됨');
                this.openAddLabelModal();
            });
        }
        
        // 배치 라벨 삭제 버튼
        if (this.elements.batchDeleteBtn) {
            this.elements.batchDeleteBtn.addEventListener('click', () => {
                console.log('🔍 [LABEL_EXPLORER_DEBUG] 배치 라벨 삭제 버튼 클릭됨');
                this.deleteSelectedLabels();
            });
        }
        
        // 모달 이벤트 바인딩
        this.bindModalEvents();
    }
    
    /**
     * 모달 이벤트 바인딩
     */
    bindModalEvents() {
        // 모달 닫기 버튼
        const closeBtn = document.querySelector('#add-label-modal .modal-close');
        if (closeBtn) {
            closeBtn.addEventListener('click', () => this.closeAddLabelModal());
        }
        
        // 모달 취소 버튼
        const cancelBtn = document.getElementById('modal-cancel');
        if (cancelBtn) {
            cancelBtn.addEventListener('click', () => this.closeAddLabelModal());
        }
        
        // 모달 확인 버튼
        const addLabelBtn = document.getElementById('modal-add-label');
        if (addLabelBtn) {
            addLabelBtn.addEventListener('click', () => this.addLabelsToSelectedImages());
        }
        
        // 모달 배경 클릭으로 닫기
        const modal = document.getElementById('add-label-modal');
        if (modal) {
            modal.addEventListener('click', (e) => {
                if (e.target === modal) {
                    this.closeAddLabelModal();
                }
            });
        }
    }
    
    /**
     * 모달 닫기
     */
    closeAddLabelModal() {
        const modal = document.getElementById('add-label-modal');
        if (modal) {
            modal.style.display = 'none';
        }
    }
    
    /**
     * 선택된 이미지들에 라벨 추가
     */
    async addLabelsToSelectedImages() {
        const selectedImages = this.viewer.getSelectedImagesForModal();
        if (selectedImages.length === 0) {
            alert('라벨을 추가할 이미지를 선택해주세요.');
            return;
        }
        
        // 클래스 선택 확인
        const classSelect = document.getElementById('modal-class-select');
        const newClassInput = document.getElementById('modal-new-class-input');
        
        let className = '';
        if (classSelect && classSelect.value) {
            className = classSelect.value;
        } else if (newClassInput && newClassInput.value.trim()) {
            className = newClassInput.value.trim();
        }
        
        if (!className) {
            alert('클래스를 선택하거나 새 클래스 이름을 입력해주세요.');
            return;
        }
        
        // 라벨 액션 확인
        const labelAction = document.querySelector('input[name="label-action"]:checked');
        const action = labelAction ? labelAction.value : 'add-all';
        
        try {
            // 배치 이미지 분류 API 호출
            let response;
            if (selectedImages.length === 1) {
                // 단일 이미지
                response = await fetch('/api/classify', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        image_path: selectedImages[0],
                        class_name: className
                    })
                });
            } else {
                // 다중 이미지
                response = await fetch('/api/classify/batch', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        images: selectedImages,
                        class_name: className
                    })
                });
            }
            
            if (!response.ok) {
                const errorData = await response.json();
                throw new Error(errorData.detail || errorData.error || '라벨 추가에 실패했습니다.');
            }
            
            const result = await response.json();
            console.log('라벨 추가 성공:', result);
            
            // 모달 닫기
            this.closeAddLabelModal();
            
            // UI 새로고침
            await this.refreshAll();
            
            alert(`라벨 "${className}"이 성공적으로 추가되었습니다.`);
            
        } catch (error) {
            console.error('라벨 추가 오류:', error);
            alert(`라벨 추가 실패: ${error.message}`);
        }
    }
    
    /**
     * 모달의 이미지 정보 업데이트
     */
    updateModalImageInfo(selectedImages) {
        const imageInfo = document.getElementById('current-image-info');
        if (imageInfo) {
            if (selectedImages.length === 1) {
                imageInfo.textContent = `Selected: ${selectedImages[0]}`;
            } else {
                imageInfo.textContent = `Selected: ${selectedImages.length} images`;
            }
        }
    }
    
    /**
     * 새 클래스 추가
     */
    async addClass() {
        const input = this.elements.newClassInput;
        const button = this.elements.addClassBtn;
        
        if (!input || !button) return;
        
        const className = input.value.trim();
        if (!className) {
            alert('클래스 이름을 입력해주세요.');
            return;
        }
        
        // 버튼 로딩 상태 설정
        const originalText = button.textContent;
        setButtonLoading(button, true, originalText, '추가 중...');
        
        try {
            const response = await fetch('/api/classes', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name: className })
            });
            
            if (!response.ok) {
                const errorData = await response.json();
                throw new Error(errorData.error || '클래스 생성에 실패했습니다.');
            }
            
            const result = await response.json();
            console.log('클래스 추가 성공:', result);
            
            // 입력 필드 초기화
            input.value = '';
            
            // UI 새로고침
            await this.refreshAll();
            
            alert(`클래스 "${className}"이 성공적으로 추가되었습니다.`);
            
        } catch (error) {
            console.error('클래스 추가 오류:', error);
            alert(`클래스 추가 실패: ${error.message}`);
        } finally {
            // 버튼 로딩 상태 해제
            setButtonLoading(button, false, originalText);
        }
    }
    
    /**
     * 선택된 클래스들 삭제
     */
    async deleteSelectedClasses() {
        const selectedClasses = this.getSelectedClasses();
        if (selectedClasses.length === 0) {
            alert('삭제할 클래스를 선택해주세요.');
            return;
        }
        
        const classNames = selectedClasses.map(cls => cls.name).join(', ');
        if (!confirm(`선택된 클래스들을 삭제하시겠습니까?\n\n${classNames}\n\n⚠️ 해당 클래스의 모든 라벨도 함께 삭제됩니다.`)) {
            return;
        }
        
        const button = this.elements.deleteClassBtn;
        const originalText = button?.textContent || '';
        
        if (button) {
            setButtonLoading(button, true, originalText, '삭제 중...');
        }
        
        try {
            const deletePromises = selectedClasses.map(cls =>
                fetch(`/api/classes/${encodeURIComponent(cls.name)}`, {
                    method: 'DELETE'
                })
            );
            
            const responses = await Promise.all(deletePromises);
            const errors = [];
            
            for (let i = 0; i < responses.length; i++) {
                if (!responses[i].ok) {
                    const errorData = await responses[i].json();
                    errors.push(`${selectedClasses[i].name}: ${errorData.error}`);
                }
            }
            
            if (errors.length > 0) {
                throw new Error(`일부 클래스 삭제 실패:\n${errors.join('\n')}`);
            }
            
            console.log(`${selectedClasses.length}개 클래스 삭제 완료`);
            
            // UI 새로고침
            await this.refreshAll();
            
            alert(`${selectedClasses.length}개 클래스가 성공적으로 삭제되었습니다.`);
            
        } catch (error) {
            console.error('클래스 삭제 오류:', error);
            alert(`클래스 삭제 실패: ${error.message}`);
        } finally {
            if (button) {
                setButtonLoading(button, false, originalText);
            }
        }
    }
    
    /**
     * 클래스 목록 새로고침
     */
    async refreshClassList() {
        console.log('🔍 [CACHE_DEBUG] Class Manager 새로고침 시작 - 캐시 삭제');
        
        // Class cache 삭제 (classes 배열 초기화)
        console.log('🔍 [CACHE_DEBUG] classes 배열 삭제 전:', this.classes.length, '개');
        this.classes = [];
        console.log('🔍 [CACHE_DEBUG] classes 배열 삭제 완료');
        
        try {
            // 현재 폴더가 있으면 해당 폴더의 클래스만 조회
            const currentFolder = this.viewer?.currentFolderPath;
            const apiUrl = currentFolder ? `/api/classes?folder=${encodeURIComponent(currentFolder)}` : '/api/classes';

            const response = await fetch(apiUrl);
            if (!response.ok) {
                throw new Error('클래스 목록 조회 실패');
            }

            const data = await response.json();
            this.classes = data.classes || [];

            this.renderClassList();

        } catch (error) {
            console.error('클래스 목록 새로고침 오류:', error);
            if (this.elements.classList) {
                this.elements.classList.innerHTML = '<p style="color: #f00;">클래스 목록을 불러올 수 없습니다.</p>';
            }
        }
    }
    
    /**
     * 클래스 목록 렌더링
     */
    renderClassList() {
        if (!this.elements.classList) return;
        
        if (this.classes.length === 0) {
            this.elements.classList.innerHTML = '<p style="color: #888;">클래스가 없습니다.</p>';
            return;
        }
        
        const fragment = document.createDocumentFragment();
        
        this.classes.forEach(cls => {
            const classButton = this.createClassButton(cls);
            fragment.appendChild(classButton);
        });
        
        this.elements.classList.innerHTML = '';
        this.elements.classList.appendChild(fragment);
    }
    
    /**
     * 클래스 버튼 생성
     * @param {Object} cls 클래스 정보
     * @returns {HTMLElement} 클래스 버튼 요소
     */
    createClassButton(cls) {
        const button = document.createElement('button');
        button.className = 'class-btn';
        button.textContent = cls.name;
        button.title = `${cls.name} (${cls.count || 0}개 라벨)`;
        button.dataset.className = cls.name;
        
        // 클릭 이벤트
        button.addEventListener('click', async (e) => {
            const className = cls.name;
            console.log('🔍 [LABEL_EXPLORER_DEBUG] 클래스 버튼 클릭됨:', className);
            console.log('🔍 [LABEL_EXPLORER_DEBUG] 현재 폴더:', this.viewer?.currentFolderPath);
            
            const selected = (this.viewer && typeof this.viewer.getSelectedImagesForModal === 'function')
                ? this.viewer.getSelectedImagesForModal()
                : [];

            // 이미지가 선택되어 있으면 즉시 분류 추가
            if (selected && selected.length > 0) {
                try {
                    let res;
                    if (selected.length === 1) {
                        // 단일 이미지
                        res = await fetch('/api/classify', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ 
                                image_path: selected[0], 
                                class_name: className 
                            })
                        });
                    } else {
                        // 다중 이미지
                        res = await fetch('/api/classify/batch', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ 
                                images: selected, 
                                class_name: className 
                            })
                        });
                    }
                    if (!res.ok) {
                        const err = await res.json().catch(() => ({}));
                        throw new Error(err.detail || err.error || `분류 추가 실패 (${res.status})`);
                    }
                    // UI 갱신
                    await this.refreshAll();
                } catch (err) {
                    console.error('라벨 추가 오류:', err);
                    alert(`라벨 추가 실패: ${err.message || err}`);
                }
                return;
            }

            // 이미지 선택이 없으면 선택/토글 동작
            if (e.ctrlKey) {
                this.toggleClassSelection(className);
            } else {
                this.selectClass(className);
            }
            this.updateClassButtonStates();
        });
        
        return button;
    }
    
    /**
     * 클래스 선택
     * @param {string} className 클래스명
     */
    selectClass(className) {
        // 기존 선택 해제
        this.labelSelection.selectedClasses = [className];
        this.showClassImages(className);
        
        // 단일 이미지 뷰에서 클래스 선택 시 라벨 추가 모달 열기
        if (this.viewer && this.viewer.isSingleImageMode && this.viewer.currentImagePath) {
            this.openAddLabelModal();
        }
    }
    
    /**
     * 클래스 선택 토글
     * @param {string} className 클래스명
     */
    toggleClassSelection(className) {
        const index = this.labelSelection.selectedClasses.indexOf(className);
        if (index > -1) {
            this.labelSelection.selectedClasses.splice(index, 1);
        } else {
            this.labelSelection.selectedClasses.push(className);
        }
    }
    
    /**
     * 클래스 버튼 상태 업데이트
     */
    updateClassButtonStates() {
        if (!this.elements.classList) return;
        
        const buttons = this.elements.classList.querySelectorAll('.class-btn');
        buttons.forEach(button => {
            const className = button.dataset.className;
            const isSelected = this.labelSelection.selectedClasses.includes(className);
            button.classList.toggle('selected', isSelected);
        });
    }
    
    /**
     * 선택된 클래스의 이미지들 표시
     * @param {string} className 클래스명
     */
    async showClassImages(className) {
        if (!this.elements.classImagesSection || !this.elements.classImagesList) return;
        
        try {
            // 현재 폴더가 있으면 해당 폴더의 클래스 이미지만 조회
            const currentFolder = this.viewer?.currentFolderPath;
            const apiUrl = currentFolder 
                ? `/api/classes/${encodeURIComponent(className)}/images?folder=${encodeURIComponent(currentFolder)}`
                : `/api/classes/${encodeURIComponent(className)}/images`;
                
            const response = await fetch(apiUrl);
            if (!response.ok) {
                throw new Error('클래스 이미지 조회 실패');
            }
            
            const data = await response.json();
            const images = data.results || [];
            
            // 제목 업데이트
            if (this.elements.classImagesTitle) {
                this.elements.classImagesTitle.textContent = `${className} (${images.length}개)`;
                this.elements.classImagesTitle.style.display = 'block';
            }
            
            // 이미지 목록 렌더링
            this.renderClassImages(images);
            
            this.elements.classImagesSection.style.display = 'block';
            
        } catch (error) {
            console.error('클래스 이미지 표시 오류:', error);
            if (this.elements.classImagesList) {
                this.elements.classImagesList.innerHTML = '<p style="color: #f00;">이미지를 불러올 수 없습니다.</p>';
            }
        }
    }
    
    /**
     * 클래스 이미지 목록 렌더링
     * @param {Array} images 이미지 배열
     */
    renderClassImages(images) {
        if (!this.elements.classImagesList) return;
        
        if (images.length === 0) {
            this.elements.classImagesList.innerHTML = '<p style="color: #888;">라벨된 이미지가 없습니다.</p>';
            return;
        }
        
        const fragment = document.createDocumentFragment();
        
        images.forEach(imagePath => {
            const imageItem = this.createClassImageItem(imagePath);
            fragment.appendChild(imageItem);
        });
        
        this.elements.classImagesList.innerHTML = '';
        this.elements.classImagesList.appendChild(fragment);
    }
    
    /**
     * 클래스 이미지 아이템 생성
     * @param {string} imagePath 이미지 경로
     * @returns {HTMLElement} 이미지 아이템 요소
     */
    createClassImageItem(imagePath) {
        const item = document.createElement('div');
        item.className = 'class-image-item';
        
        const img = document.createElement('img');
        img.src = `/api/thumbnail?path=${encodeURIComponent(imagePath)}`;
        img.alt = imagePath.split('/').pop();
        img.title = imagePath;
        
        const fileName = document.createElement('div');
        fileName.className = 'class-image-filename';
        fileName.textContent = imagePath.split('/').pop();
        
        item.appendChild(img);
        item.appendChild(fileName);
        
        // 클릭 시 해당 이미지 표시
        item.addEventListener('click', () => {
            console.log('🔍 [LABEL_EXPLORER_DEBUG] 이미지 아이템 클릭됨:', imagePath);
            console.log('🔍 [LABEL_EXPLORER_DEBUG] 현재 폴더:', this.viewer?.currentFolderPath);
            this.viewer.loadImage(imagePath);
        });
        
        return item;
    }
    
    /**
     * Label Explorer 새로고침
     */
    async refreshLabelExplorer() {
        console.log('🔍 [CACHE_DEBUG] Label Explorer 새로고침 시작 - 캐시 삭제');
        
        // Label cache 삭제
        if (this.viewer && this.viewer.classToImgListCache) {
            console.log('🔍 [CACHE_DEBUG] classToImgListCache 삭제 전:', Object.keys(this.viewer.classToImgListCache).length, '개');
            this.viewer.classToImgListCache = {};
            console.log('🔍 [CACHE_DEBUG] classToImgListCache 삭제 완료');
        }
        
        const container = this.elements.labelExplorerList;
        if (!container) return;

        // 현재 폴더의 클래스 목록 불러오기
        let classes = [];
        try {
            // 현재 폴더가 있으면 해당 폴더의 클래스만 조회
            const currentFolder = this.viewer?.currentFolderPath;
            console.log('🔍 [LABEL_EXPLORER_DEBUG] refreshLabelExplorer 호출됨');
            console.log('🔍 [LABEL_EXPLORER_DEBUG] this.viewer:', this.viewer);
            console.log('🔍 [LABEL_EXPLORER_DEBUG] currentFolder:', currentFolder);
            const apiUrl = currentFolder ? `/api/classes?folder=${encodeURIComponent(currentFolder)}` : '/api/classes';
            console.log('🔍 [LABEL_EXPLORER_DEBUG] apiUrl:', apiUrl);
            
            // 재시도 로직 추가
            let res;
            let retryCount = 0;
            const maxRetries = 3;
            
            while (retryCount < maxRetries) {
                try {
                    res = await fetch(apiUrl);
                    if (res.ok) break;
                    
                    console.warn(`🔍 [LABEL_EXPLORER_DEBUG] API 요청 실패 (시도 ${retryCount + 1}/${maxRetries}):`, res.status);
                    retryCount++;
                    if (retryCount < maxRetries) {
                        await new Promise(resolve => setTimeout(resolve, 200 * retryCount));
                    }
                } catch (error) {
                    console.warn(`🔍 [LABEL_EXPLORER_DEBUG] API 요청 에러 (시도 ${retryCount + 1}/${maxRetries}):`, error);
                    retryCount++;
                    if (retryCount < maxRetries) {
                        await new Promise(resolve => setTimeout(resolve, 200 * retryCount));
                    }
                }
            }
            
            if (!res || !res.ok) {
                throw new Error(`클래스 목록 조회 실패 (${retryCount}회 시도 후)`);
            }
            
            const data = await res.json();
            classes = data.classes || [];
            console.log('🔍 [LABEL_EXPLORER_DEBUG] 클래스 목록 조회 성공:', classes.length, '개');
        } catch (e) {
            console.error('Label Explorer 클래스 조회 오류:', e);
            container.innerHTML = '<p style="color:#f00;">클래스를 불러올 수 없습니다.</p>';
            return;
        }

        const frag = document.createDocumentFragment();

        for (const className of classes) {
            // 클래스 헤더
            const header = document.createElement('div');
            header.className = 'label-explorer-class';
            header.textContent = className;
            frag.appendChild(header);

            // 이미지 목록 컨테이너
            const list = document.createElement('div');
            list.className = 'label-explorer-list';
            frag.appendChild(list);

            // 이미지 목록 조회
            try {
                const currentFolder = this.viewer?.currentFolderPath;
                const imageApiUrl = currentFolder 
                    ? `/api/classes/${encodeURIComponent(className)}/images?folder=${encodeURIComponent(currentFolder)}&limit=1000`
                    : `/api/classes/${encodeURIComponent(className)}/images?limit=1000`;
                console.log('🔍 [LABEL_EXPLORER_DEBUG] 이미지 조회 API URL:', imageApiUrl);
                
                // 재시도 로직 추가
                let res;
                let retryCount = 0;
                const maxRetries = 3;
                
                while (retryCount < maxRetries) {
                    try {
                        res = await fetch(imageApiUrl);
                        if (res.ok) break;
                        
                        console.warn(`🔍 [LABEL_EXPLORER_DEBUG] 이미지 API 요청 실패 (시도 ${retryCount + 1}/${maxRetries}):`, res.status);
                        retryCount++;
                        if (retryCount < maxRetries) {
                            await new Promise(resolve => setTimeout(resolve, 200 * retryCount));
                        }
                    } catch (error) {
                        console.warn(`🔍 [LABEL_EXPLORER_DEBUG] 이미지 API 요청 에러 (시도 ${retryCount + 1}/${maxRetries}):`, error);
                        retryCount++;
                        if (retryCount < maxRetries) {
                            await new Promise(resolve => setTimeout(resolve, 200 * retryCount));
                        }
                    }
                }
                
                if (!res || !res.ok) {
                    throw new Error(`이미지 조회 실패 (${retryCount}회 시도 후)`);
                }
                
                const data = await res.json();
                const images = data.results || [];
                console.log('🔍 [LABEL_EXPLORER_DEBUG] 이미지 조회 성공:', images.length, '개');

                if (images.length === 0) {
                    const empty = document.createElement('div');
                    empty.className = 'label-explorer-empty';
                    empty.textContent = '라벨된 이미지 없음';
                    list.appendChild(empty);
                    continue;
                }

                for (const imagePath of images) {
                    const row = document.createElement('div');
                    row.className = 'label-explorer-item';

                    const name = document.createElement('span');
                    name.className = 'label-explorer-name';
                    name.textContent = imagePath.split('/').pop();
                    name.title = imagePath;
                    row.appendChild(name);

                    const del = document.createElement('button');
                    del.className = 'label-explorer-del';
                    del.textContent = '삭제';
                    del.addEventListener('click', async () => {
                        console.log('🔍 [LABEL_EXPLORER_DEBUG] 이미지 삭제 버튼 클릭됨:', imagePath);
                        console.log('🔍 [LABEL_EXPLORER_DEBUG] 클래스:', className);
                        console.log('🔍 [LABEL_EXPLORER_DEBUG] 현재 폴더:', this.viewer?.currentFolderPath);
                        
                        if (!confirm(`"${className}" 클래스에서 "${imagePath.split('/').pop()}" 이미지를 제거하시겠습니까?`)) {
                            return;
                        }
                        try {
                            // classification 디렉토리에서 파일 제거와 라벨 제거를 모두 수행
                            const res = await fetch('/api/classify', {
                                method: 'DELETE',
                                headers: { 'Content-Type': 'application/json' },
                                body: JSON.stringify({ 
                                    image_path: imagePath, 
                                    class_name: className 
                                })
                            });
                            if (!res.ok) {
                                const err = await res.json().catch(() => ({}));
                                throw new Error(err.detail || err.error || `삭제 실패(${res.status})`);
                            }
                            await this.refreshAll();
                        } catch (err) {
                            console.error('분류 삭제 오류:', err);
                            alert(`분류 삭제 실패: ${err.message || err}`);
                        }
                    });
                    row.appendChild(del);

                    list.appendChild(row);
                }
            } catch (e) {
                console.error('Label Explorer 이미지 조회 오류:', e);
                const err = document.createElement('div');
                err.style.color = '#f00';
                err.textContent = '이미지 목록을 불러올 수 없습니다.';
                list.appendChild(err);
            }
        }

        container.innerHTML = '';
        container.appendChild(frag);
    }
    
    /**
     * Add Label 모달 열기
     */
    async openAddLabelModal() {
        const selectedImages = this.viewer.getSelectedImagesForModal();
        if (selectedImages.length === 0) {
            alert('라벨을 추가할 이미지를 선택해주세요.');
            return;
        }
        
        // 모달 표시 로직
        const modal = document.getElementById('add-label-modal');
        if (modal) {
            modal.style.display = 'block';
            await this.populateModalClassList();
            this.updateModalImageInfo(selectedImages);
        }
    }
    
    /**
     * 모달의 클래스 목록 채우기
     */
    async populateModalClassList() {
        const classSelect = document.getElementById('modal-class-select');
        if (!classSelect) return;
        
        // 기존 옵션 제거 (첫 번째 옵션 제외)
        while (classSelect.children.length > 1) {
            classSelect.removeChild(classSelect.lastChild);
        }
        
        // 클래스 목록 추가
        this.classes.forEach(cls => {
            const option = document.createElement('option');
            option.value = cls.name;
            option.textContent = cls.name;
            classSelect.appendChild(option);
        });
    }
    
    /**
     * 모달의 이미지 정보 업데이트
     * @param {Array<string>} selectedImages 선택된 이미지들
     */
    updateModalImageInfo(selectedImages) {
        const infoElement = document.getElementById('current-image-info');
        if (infoElement) {
            infoElement.textContent = `${selectedImages.length}개 이미지 선택됨`;
        }
    }
    
    /**
     * 선택된 라벨들 삭제
     */
    async deleteSelectedLabels() {
        if (this.labelSelection.selectedClasses.length === 0 && this.labelSelection.selected.length === 0) {
            alert('삭제할 라벨을 선택해주세요.');
            return;
        }
        
        // 삭제 로직 구현
        console.log('선택된 라벨 삭제:', this.labelSelection);
    }
    
    /**
     * 선택된 클래스들 반환
     * @returns {Array} 선택된 클래스 배열
     */
    getSelectedClasses() {
        return this.classes.filter(cls => 
            this.labelSelection.selectedClasses.includes(cls.name)
        );
    }
    
    /**
     * 모든 UI 새로고침
     */
    async refreshAll() {
        console.log('🔍 [LABEL_EXPLORER_DEBUG] refreshAll 호출됨');
        console.log('🔍 [LABEL_EXPLORER_DEBUG] 현재 폴더:', this.viewer?.currentFolderPath);
        
        await Promise.all([
            this.refreshClassList(),
            this.refreshLabelExplorer()
        ]);
    }
    
    /**
     * 리소스 정리
     */
    cleanup() {
        this.labelSelection.selected = [];
        this.labelSelection.selectedClasses = [];
    }
}
