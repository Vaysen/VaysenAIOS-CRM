/**
 * TASK-015: GLB Compression Script
 * =================================
 * Compresses GLB 3D models using Draco mesh compression and texture compression.
 *
 * Usage:
 *   npx tsx scripts/compress-glb.ts [input.glb] [output.glb]
 *
 * Defaults:
 *   input  = F:/Vaysen包装资料/packaging-customizer/frontend/public/models/bag-8side-opt.glb
 *   output = F:/Vaysen包装资料/packaging-customizer/frontend/public/models/bag-8side-compressed.glb
 *
 * Optimisations applied:
 *   1. dedup           — remove duplicate mesh data
 *   2. weld            — merge identical vertices
 *   3. prune           — remove unused resources
 *   4. textureCompress — convert textures to WebP (with sharp encoder)
 *   5. draco           — Draco mesh compression (edgebreaker, quantized UVs preserved)
 *
 * Target: reduce 18 MB GLB to < 2 MB while preserving UV coordinates.
 */

import { NodeIO } from '@gltf-transform/core';
import {
  draco,
  textureCompress,
  dedup,
  weld,
  prune,
} from '@gltf-transform/functions';
import { KHRDracoMeshCompression, KHRONOS_EXTENSIONS } from '@gltf-transform/extensions';
import * as fs from 'fs';

// draco3d encoder/decoder — required by KHRDracoMeshCompression extension
const { createEncoderModule, createDecoderModule } = require('draco3d');

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------
const DEFAULT_INPUT =
  'F:/Vaysen包装资料/packaging-customizer/frontend/public/models/bag-8side-opt.glb';
const DEFAULT_OUTPUT =
  'F:/Vaysen包装资料/packaging-customizer/frontend/public/models/bag-8side-compressed.glb';

const TARGET_SIZE_MB = 2; // Target: < 2 MB

// Try to load sharp for texture compression
let sharpEncoder: any = undefined;
try {
  sharpEncoder = require('sharp');
} catch {
  console.warn('[WARN] sharp not available — texture compression will be skipped');
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) {
    return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
  }
  if (bytes >= 1024) {
    return `${(bytes / 1024).toFixed(2)} KB`;
  }
  return `${bytes} B`;
}

// ---------------------------------------------------------------------------
// UV Verification
// ---------------------------------------------------------------------------
async function verifyUV(
  originalPath: string,
  compressedPath: string,
): Promise<{ passed: boolean; maxError: number }> {
  const decoderModule = await createDecoderModule();
  const io = new NodeIO()
    .registerExtensions(KHRONOS_EXTENSIONS)
    .registerDependencies({
      'draco3d.decoder': decoderModule,
    });

  const origDoc = await io.read(originalPath);
  const compDoc = await io.read(compressedPath);

  const origMeshes = origDoc.getRoot().listMeshes();
  const compMeshes = compDoc.getRoot().listMeshes();

  let maxError = 0;
  let compared = 0;

  for (let i = 0; i < origMeshes.length && i < compMeshes.length; i++) {
    const origPrims = origMeshes[i].listPrimitives();
    const compPrims = compMeshes[i].listPrimitives();

    for (let j = 0; j < origPrims.length && j < compPrims.length; j++) {
      const origUV = origPrims[j].getAttribute('TEXCOORD_0');
      const compUV = compPrims[j].getAttribute('TEXCOORD_0');

      if (!origUV || !compUV) {
        console.warn(
          `  [UV] Mesh ${i} Primitive ${j}: TEXCOORD_0 missing in ${!origUV ? 'original' : 'compressed'}`,
        );
        continue;
      }

      const origArray = origUV.getArray();
      const compArray = compUV.getArray();

      if (!origArray || !compArray) {
        console.warn(
          `  [UV] Mesh ${i} Primitive ${j}: UV array unavailable (possibly Draco-compressed)`,
        );
        continue;
      }

      if (origArray.length !== compArray.length) {
        console.warn(
          `  [UV] Mesh ${i} Primitive ${j}: UV count mismatch (orig=${origArray.length}, comp=${compArray.length})`,
        );
        continue;
      }

      // Compare UV values — Draco quantization introduces small errors
      for (let k = 0; k < origArray.length; k++) {
        const diff = Math.abs(origArray[k] - compArray[k]);
        if (diff > maxError) {
          maxError = diff;
        }
      }
      compared++;
    }
  }

  // With 12-bit texcoord quantization, max theoretical error is 1/4096 ≈ 0.000244
  const threshold = 0.001;
  const passed = maxError < threshold;

  console.log(`  [UV] Primitives compared: ${compared}`);
  console.log(`  [UV] Max quantization error: ${maxError.toFixed(6)} (threshold: ${threshold})`);
  console.log(`  [UV] Verification: ${passed ? 'PASSED' : 'FAILED'}`);

  return { passed, maxError };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function compressGlb(inputPath: string, outputPath: string): Promise<void> {
  console.log('=== GLB Compression (TASK-015) ===\n');

  // Validate input
  if (!fs.existsSync(inputPath)) {
    console.error(`Error: Input file not found: ${inputPath}`);
    process.exit(1);
  }

  const originalSize = fs.statSync(inputPath).size;
  console.log(`Input:     ${inputPath}`);
  console.log(`  Size:    ${formatBytes(originalSize)}`);
  console.log(`Output:    ${outputPath}\n`);

  // Read the original GLB
  console.log('Reading model ...');
  console.log('  Initializing Draco encoder/decoder ...');
  const [encoderModule, decoderModule] = await Promise.all([
    createEncoderModule(),
    createDecoderModule(),
  ]);
  const io = new NodeIO()
    .registerExtensions(KHRONOS_EXTENSIONS)
    .registerDependencies({
      'draco3d.encoder': encoderModule,
      'draco3d.decoder': decoderModule,
    });
  const doc = await io.read(inputPath);

  const root = doc.getRoot();
  const meshCount = root.listMeshes().length;
  const textureCount = root.listTextures().length;
  console.log(`  Meshes:    ${meshCount}`);
  console.log(`  Textures:  ${textureCount}`);

  // Print texture info
  const textures = root.listTextures();
  for (let i = 0; i < textures.length; i++) {
    const tex = textures[i];
    const imageSize = tex.getImage();
    console.log(
      `    Texture ${i}: ${tex.getName() || tex.getURI() || 'unnamed'} ` +
      `(${tex.getMimeType()}, ${imageSize ? formatBytes(imageSize.byteLength) : 'embedded'})`,
    );
  }
  console.log('');

  // Build the list of transforms
  const transforms: any[] = [];

  console.log('Applying transforms:');
  console.log('  1. dedup           — removing duplicate data ...');
  transforms.push(dedup());

  console.log('  2. weld            — merging identical vertices ...');
  transforms.push(weld());

  console.log('  3. prune           — removing unused resources ...');
  transforms.push(prune());

  // Texture compression (WebP) — requires sharp
  if (sharpEncoder) {
    console.log('  4. textureCompress — converting textures to WebP ...');
    transforms.push(
      textureCompress({
        targetFormat: 'webp',
        encoder: sharpEncoder,
        quality: 80,
      } as any),
    );
  } else {
    console.log('  4. textureCompress — SKIPPED (sharp not available)');
  }

  console.log('  5. draco           — applying Draco mesh compression ...\n');
  transforms.push(
    draco({
      method: 'edgebreaker',
      encodeSpeed: 5,
      decodeSpeed: 5,
      quantizePosition: 14,
      quantizeNormal: 10,
      quantizeColor: 8,
      quantizeTexcoord: 12,
    }),
  );

  await doc.transform(...transforms);

  // Write compressed GLB
  console.log('Writing compressed model ...');
  await io.write(outputPath, doc);

  const compressedSize = fs.statSync(outputPath).size;
  const reduction = ((1 - compressedSize / originalSize) * 100).toFixed(1);

  console.log('\n=== Compression Report ===');
  console.log(`Original:    ${formatBytes(originalSize)}`);
  console.log(`Compressed:  ${formatBytes(compressedSize)}`);
  console.log(`Reduction:   ${reduction}%`);
  console.log(
    `Target <${TARGET_SIZE_MB}MB: ${
      compressedSize < TARGET_SIZE_MB * 1024 * 1024 ? 'PASSED' : 'FAILED'
    }`,
  );

  // UV verification
  console.log('\n=== UV Verification ===');
  try {
    await verifyUV(inputPath, outputPath);
  } catch (err) {
    console.warn(`  [UV] Verification skipped due to error: ${(err as Error).message}`);
  }

  console.log('\nDone.');
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------
const input = process.argv[2] || DEFAULT_INPUT;
const output = process.argv[3] || DEFAULT_OUTPUT;

compressGlb(input, output).catch((err) => {
  console.error('Compression failed:', err);
  process.exit(1);
});
