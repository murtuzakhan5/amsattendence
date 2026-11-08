#!/usr/bin/env bash
# Downloads the face-api.js model weights into public/models
set -e
DIR="$(cd "$(dirname "$0")/.." && pwd)/public/models"
BASE=https://raw.githubusercontent.com/justadudewhohacks/face-api.js/master/weights
mkdir -p "$DIR" && cd "$DIR"
curl -fLO $BASE/tiny_face_detector_model-weights_manifest.json
curl -fLO $BASE/tiny_face_detector_model-shard1
curl -fLO $BASE/face_landmark_68_model-weights_manifest.json
curl -fLO $BASE/face_landmark_68_model-shard1
curl -fLO $BASE/face_recognition_model-weights_manifest.json
curl -fLO $BASE/face_recognition_model-shard1
curl -fLO $BASE/face_recognition_model-shard2
echo "Models downloaded to $DIR"
