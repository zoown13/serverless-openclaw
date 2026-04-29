#!/bin/bash
set -euo pipefail

# Deploy container image to ECR with zstd compression and optional SOCI index
# Usage: ./scripts/deploy-image.sh [--soci]
#
# Uses zstd compression (level 3) for faster Fargate image pull.
#
# Prerequisites:
#   - AWS CLI configured (profile via AWS_PROFILE or .env)
#   - Docker Buildx (included in Docker Desktop)
#   - For --soci: soci CLI installed (Linux only)
#     Install: https://github.com/awslabs/soci-snapshotter/releases

REGION="${AWS_REGION:-ap-northeast-2}"
ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
ECR_REPO="${ACCOUNT_ID}.dkr.ecr.${REGION}.amazonaws.com/serverless-openclaw"
ENABLE_SOCI=false
IMAGE_COMPRESSION="${IMAGE_COMPRESSION:-zstd}"

for arg in "$@"; do
  case $arg in
    --soci) ENABLE_SOCI=true ;;
  esac
done

echo "=== Build & Deploy Container Image ==="
echo "ECR: ${ECR_REPO}"
echo "SOCI: ${ENABLE_SOCI}"
echo "Compression: ${IMAGE_COMPRESSION}"

# Step 1: Login to ECR (needed before buildx --push)
echo ""
echo "[1/3] Logging in to ECR..."
aws ecr get-login-password --region "${REGION}" | \
  docker login --username AWS --password-stdin "${ACCOUNT_ID}.dkr.ecr.${REGION}.amazonaws.com"

# Step 2: Build & Push with zstd compression
echo ""
echo "[2/3] Building and pushing Docker image (zstd compression)..."
OPENCLAW_VERSION="${OPENCLAW_VERSION:-latest}"
IMAGE_TAG="${IMAGE_TAG:-latest}"
echo "OpenClaw version: ${OPENCLAW_VERSION}"
echo "Image tag: ${IMAGE_TAG}"

IMAGE_TAG_ARGS=(-t "${ECR_REPO}:latest")
if [ "${IMAGE_TAG}" != "latest" ]; then
  IMAGE_TAG_ARGS+=(-t "${ECR_REPO}:${IMAGE_TAG}")
fi

OUTPUT_ARGS=(--output type=image,push=true)
if [ "${IMAGE_COMPRESSION}" = "zstd" ]; then
  OUTPUT_ARGS=(--output type=image,push=true,compression=zstd,compression-level=3,force-compression=true)
elif [ "${IMAGE_COMPRESSION}" != "gzip" ] && [ "${IMAGE_COMPRESSION}" != "default" ]; then
  echo "ERROR: IMAGE_COMPRESSION must be one of: zstd, gzip, default"
  exit 1
fi

docker buildx build \
  --platform linux/arm64 \
  "${IMAGE_TAG_ARGS[@]}" \
  --build-arg OPENCLAW_VERSION="${OPENCLAW_VERSION}" \
  --provenance=false \
  --no-cache \
  "${OUTPUT_ARGS[@]}" \
  -f packages/container/Dockerfile .

# Step 3: SOCI Index (optional, Linux only)
if [ "${ENABLE_SOCI}" = true ]; then
  echo ""
  echo "[3/3] Creating SOCI index..."

  if ! command -v soci &> /dev/null; then
    echo "ERROR: soci CLI not found. Install from:"
    echo "  https://github.com/awslabs/soci-snapshotter/releases"
    echo ""
    echo "Quick install (Linux amd64):"
    echo "  wget https://github.com/awslabs/soci-snapshotter/releases/latest/download/soci-snapshotter-grpc-linux-amd64.tar.gz"
    echo "  tar -xzf soci-snapshotter-grpc-linux-amd64.tar.gz"
    echo "  sudo mv soci /usr/local/bin/"
    exit 1
  fi

  # Pull image locally for soci to index
  docker pull "${ECR_REPO}:latest"

  # Create and push SOCI index
  soci create "${ECR_REPO}:latest"
  soci push "${ECR_REPO}:latest"

  echo "SOCI index pushed to ECR. Fargate will use lazy loading on next task launch."
else
  echo ""
  echo "[3/3] Skipping SOCI index (use --soci to enable, Linux only)"
fi

echo ""
echo "=== Deploy complete ==="
echo "Image: ${ECR_REPO}:latest"
if [ "${IMAGE_TAG}" != "latest" ]; then
  echo "AgentCore image: ${ECR_REPO}:${IMAGE_TAG}"
fi

# Check image size in ECR
IMAGE_SIZE=$(aws ecr describe-images --repository-name serverless-openclaw --image-ids imageTag="${IMAGE_TAG}" \
  --query 'imageDetails[0].imageSizeInBytes' --output text --region "${REGION}" 2>/dev/null || echo "unknown")
if [ "${IMAGE_SIZE}" != "unknown" ]; then
  IMAGE_SIZE_MB=$((IMAGE_SIZE / 1024 / 1024))
  echo "Image size (compressed): ${IMAGE_SIZE_MB} MB"
else
  echo "Image size: (could not retrieve)"
fi
