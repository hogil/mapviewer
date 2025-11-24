// extractLotTokensFromPath 함수
function extractLotTokensFromPath(path) {
    if (!path) return null;

    const fileName = path.split('/').pop().split('\\').pop();
    const baseName = fileName.replace(/\.[^/.]+$/, '');
    const parts = baseName.split('_');

    if (parts.length < 2) return null;

    return {
        lotValue: parts[0] || '',
        waferValue: parts[1] || '',
        root: parts[0] || ''
    };
}

// 현재 OR 검색 방식
function currentOrSearchMethod(fileNames, lotQuery) {
    const query = lotQuery.toLowerCase();
    const orTerms = query.split(' or ').map(t => t.trim());

    const results = [];
    for (const fileName of fileNames) {
        const normalizedName = fileName.toLowerCase();
        if (orTerms.some(term => normalizedName.includes(term))) {
            results.push(fileName);
        }
    }
    return results;
}

// 제안된 슬래시 + split 방식
function proposedSlashSplitMethod(fileNames, lotQuery) {
    const lotSet = new Set(lotQuery.split('/'));

    const results = [];
    for (const fileName of fileNames) {
        const tokens = extractLotTokensFromPath(fileName);
        if (tokens && lotSet.has(tokens.lotValue)) {
            results.push(fileName);
        }
    }
    return results;
}

// 테스트 데이터 생성
function generateTestData(numLots, filesPerLot = 20) {
    const fileNames = [];
    const lots = [];

    // LOT 생성
    for (let i = 0; i < numLots; i++) {
        const lotName = `LOT${String(i).padStart(4, '0')}`;
        lots.push(lotName);

        // 각 LOT마다 여러 Wafer 파일 생성
        for (let w = 1; w <= filesPerLot; w++) {
            fileNames.push(`${lotName}_Wafer${w}_Site1.jpg`);
        }
    }

    // 추가 노이즈 파일 (매치되지 않는 파일들)
    for (let i = 0; i < 1000; i++) {
        fileNames.push(`NOISE${i}_Wafer1_Site1.jpg`);
    }

    return { fileNames, lots };
}

// 벤치마크 실행
function runBenchmark(numLots) {
    console.log(`\n${'='.repeat(60)}`);
    console.log(`🚀 Benchmark: ${numLots}개 LOT 검색`);
    console.log('='.repeat(60));

    const { fileNames, lots } = generateTestData(numLots);

    // OR 검색 쿼리 생성
    const orQuery = lots.join(' OR ');

    // 슬래시 검색 쿼리 생성
    const slashQuery = lots.join('/');

    const iterations = 1000; // 1000회 반복 측정

    console.log(`\n📁 테스트 데이터:`);
    console.log(`   LOT 개수: ${numLots}개`);
    console.log(`   총 파일 수: ${fileNames.length.toLocaleString()}개`);
    console.log(`   반복 횟수: ${iterations}회\n`);

    // 현재 방식 벤치마크
    const startCurrent = performance.now();
    let currentResults;
    for (let i = 0; i < iterations; i++) {
        currentResults = currentOrSearchMethod(fileNames, orQuery);
    }
    const endCurrent = performance.now();
    const currentTime = endCurrent - startCurrent;

    // 제안 방식 벤치마크
    const startProposed = performance.now();
    let proposedResults;
    for (let i = 0; i < iterations; i++) {
        proposedResults = proposedSlashSplitMethod(fileNames, slashQuery);
    }
    const endProposed = performance.now();
    const proposedTime = endProposed - startProposed;

    // 결과 계산
    const avgCurrentTime = currentTime / iterations;
    const avgProposedTime = proposedTime / iterations;
    const speedup = currentTime / proposedTime;

    // 결과 출력
    console.log(`⚡ 현재 방식 (OR 검색):`);
    console.log(`   총 실행 시간: ${currentTime.toFixed(2)} ms`);
    console.log(`   평균 실행 시간: ${avgCurrentTime.toFixed(3)} ms`);
    console.log(`   매치된 파일: ${currentResults.length}개`);
    console.log(`   쿼리 길이: ${orQuery.length} characters\n`);

    console.log(`🚀 제안 방식 (슬래시 + Split):`);
    console.log(`   총 실행 시간: ${proposedTime.toFixed(2)} ms`);
    console.log(`   평균 실행 시간: ${avgProposedTime.toFixed(3)} ms`);
    console.log(`   매치된 파일: ${proposedResults.length}개`);
    console.log(`   쿼리 길이: ${slashQuery.length} characters\n`);

    console.log(`🏆 결과:`);
    if (speedup > 1) {
        console.log(`   ✅ 제안 방식이 ${speedup.toFixed(2)}배 빠름!`);
        console.log(`   ⏱️  시간 절약: ${(currentTime - proposedTime).toFixed(2)} ms (${iterations}회 기준)`);
        console.log(`   💾 메모리 효율: Set 기반 O(1) 조회`);
    } else {
        console.log(`   ✅ 현재 방식이 ${(1/speedup).toFixed(2)}배 빠름`);
        console.log(`   ⏱️  시간 차이: ${(proposedTime - currentTime).toFixed(2)} ms (${iterations}회 기준)`);
    }

    // 정확도 비교
    console.log(`\n🎯 정확도 비교:`);
    console.log(`   현재 방식 매치: ${currentResults.length}개`);
    console.log(`   제안 방식 매치: ${proposedResults.length}개`);

    // 샘플 파일 몇 개 확인
    console.log(`\n📝 매치된 파일 샘플 (처음 3개):`);
    console.log(`   현재 방식: ${currentResults.slice(0, 3).join(', ')}`);
    console.log(`   제안 방식: ${proposedResults.slice(0, 3).join(', ')}`);
}

// 메인 실행
console.log('\n🧪 검색 성능 벤치마크 시작...\n');

runBenchmark(10);
runBenchmark(100);
runBenchmark(1000);

console.log(`\n${'='.repeat(60)}`);
console.log('✅ 벤치마크 완료!');
console.log('='.repeat(60) + '\n');
