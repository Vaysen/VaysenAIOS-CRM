#!/bin/bash
# Vaysen Trade OS — Preview Demo Data Seed
# Run: bash scripts/seed-preview.sh

echo "=== Seeding preview demo data ==="
cd "$(dirname "$0")/../backend"
npx ts-node prisma/seed-preview.ts
echo "=== Seed complete ==="
