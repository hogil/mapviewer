/**
 * JS Minification Script (esbuild)
 * 각 JS 파일을 개별 minify하여 .min.js 생성
 * Usage: node scripts/minify.js
 */
const esbuild = require('esbuild');
const fs = require('fs');
const path = require('path');

const jsDir = path.join(__dirname, '..', 'js');
const files = fs.readdirSync(jsDir)
    .filter(f => f.endsWith('.js') && !f.endsWith('.min.js') && !f.includes('worker'));

let totalOrig = 0, totalMin = 0;

for (const file of files) {
    const input = path.join(jsDir, file);
    const output = path.join(jsDir, file.replace('.js', '.min.js'));
    try {
        esbuild.buildSync({
            entryPoints: [input],
            outfile: output,
            minify: true,
            format: 'esm',
            target: 'es2020',
            // import 경로는 그대로 유지 (번들링 안 함)
            bundle: false,
        });
        const origSize = fs.statSync(input).size;
        const minSize = fs.statSync(output).size;
        totalOrig += origSize;
        totalMin += minSize;
        const pct = ((1 - minSize / origSize) * 100).toFixed(0);
        console.log(`  ${file}: ${(origSize/1024).toFixed(0)}KB → ${(minSize/1024).toFixed(0)}KB (-${pct}%)`);
    } catch (err) {
        console.error(`  ERROR ${file}: ${err.message}`);
    }
}

console.log(`\n  Total: ${(totalOrig/1024).toFixed(0)}KB → ${(totalMin/1024).toFixed(0)}KB (-${((1-totalMin/totalOrig)*100).toFixed(0)}%)`);
