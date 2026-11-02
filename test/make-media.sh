#!/bin/sh
# Generates the small test clips used by the e2e suite (needs ffmpeg with libx264 + libopus).
set -e
cd "$(dirname "$0")" && mkdir -p media && cd media
v() { ffmpeg -y -loglevel error -f lavfi -i "testsrc2=size=$2:rate=60" -t 2 -pix_fmt yuv420p -c:v libx264 -profile:v baseline -tune zerolatency -g 60 -bf 0 -x264-params aud=1 -f h264 "$1"; }
v portrait-s.h264 360x800; v landscape-s.h264 800x360
v portrait.h264 720x1600; v landscape.h264 1600x720
ffmpeg -y -loglevel error -f lavfi -i "sine=frequency=440:duration=2:sample_rate=48000" -ac 2 -c:a libopus tone.ogg
ffmpeg -y -loglevel error -f lavfi -i "sine=frequency=440:duration=2:sample_rate=48000" -ac 2 -f s16le tone.raw
